import { contentDigest } from './content.js';
import { validAuditProof } from './governance.js';

const fail = () => { throw new Error('Transition observation unavailable'); };
const queryDefault = async (sql, params) => (await import('../lib/db.js')).executeQuery(sql, params);
export const OBSERVATION_MIGRATIONS = [{ id: 'tm_closure_observation', sql: `CREATE TABLE IF NOT EXISTS tm_closure_observation (
  observation_id CHAR(32) NOT NULL, source_issue_id BIGINT NOT NULL, content MEDIUMTEXT NOT NULL,
  digest CHAR(64) NOT NULL, created_at BIGINT NOT NULL, audit_seq BIGINT NULL, audit_hash CHAR(64) NULL,
  PRIMARY KEY (observation_id), INDEX idx_tm_closure_observation_source (source_issue_id, created_at)
)` }];

/** Jira's event proves a move. It supplies no proven correlation to our validator invocation. */
export async function observeGovernedTransition(event, transition, deps) {
  if (!event?.issue?.id || !transition?.from?.id || !transition?.to?.id ||
      !await deps.isGovernedSource(event.issue)) return { observed: false };
  const content = { kind: 'OBSERVED_TRANSITION', schema: 1, sourceIssueId: String(event.issue.id),
    sourceIssueKey: String(event.issue.key ?? ''), eventId: String(event.eventId ?? event.id ?? event.changelog?.id ?? ''),
    eventTime: event.timestamp ?? null, fromStatusId: String(transition.from.id), toStatusId: String(transition.to.id),
    transitionId: transition.transitionId == null ? null : String(transition.transitionId),
    actorAccountId: event.atlassianId ?? event.associatedUsers?.[0]?.accountId ?? null,
    evidenceSource: transition.source ?? 'transition-event', evaluationId: null, correlation: 'NOT_ESTABLISHED' };
  const digest = contentDigest(content), observationId = digest.slice(0, 32);
  await deps.insertObservedTransition({ observationId, content, digest, createdAt: deps.now() });
  const existing = deps.readObservedTransition ? await deps.readObservedTransition(observationId) : null;
  if (existing?.digest === digest && validAuditProof(existing.auditProof)) {
    return { observed: true, observationId, digest, linkedEvaluationId: null };
  }
  const proof = await deps.audit({ eventId: Buffer.from(observationId, 'hex'), eventType: 'TM_TRANSITION_OBSERVED',
    issueId: Number(event.issue.id), actorAccountId: content.actorAccountId ?? 'system', payload: { observationId, digest, ...content } });
  if (!Number.isSafeInteger(proof?.seq) || proof.seq < 1 || !/^[a-f0-9]{64}$/.test(proof?.entryHash ?? '') ||
      !await deps.confirmObservedTransition({ observationId, digest, proof })) fail();
  return { observed: true, observationId, digest, linkedEvaluationId: null };
}

export function createObservationStore({ query = queryDefault } = {}) {
  const q = async (sql, params) => { const r = await query(sql, params); if (!r?.result) fail(); return r.data; };
  const fromRow = row => {
    const content = typeof row.content === 'object' ? row.content : JSON.parse(row.content);
    const auditProof = row.audit_seq == null ? null : { seq: Number(row.audit_seq), entryHash: row.audit_hash };
    if (contentDigest(content) !== row.digest || auditProof && !validAuditProof(auditProof)) fail();
    return { observationId: row.observation_id, content, digest: row.digest, createdAt: Number(row.created_at), auditProof };
  };
  return {
    readObservedTransition: async observationId => {
      if (!/^[a-f0-9]{32}$/.test(observationId)) fail();
      const rows = await q('SELECT * FROM tm_closure_observation WHERE observation_id = ?', [observationId]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    insertObservedTransition: async r => {
      if (contentDigest(r.content) !== r.digest) fail();
      await q(`INSERT INTO tm_closure_observation (observation_id, source_issue_id, content, digest, created_at)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE observation_id = observation_id`,
      [r.observationId, Number(r.content.sourceIssueId), JSON.stringify(r.content), r.digest, r.createdAt]); return true;
    },
    confirmObservedTransition: async ({ observationId, digest, proof }) => {
      await q(`UPDATE tm_closure_observation SET audit_seq = ?, audit_hash = ? WHERE observation_id = ? AND digest = ? AND audit_seq IS NULL`,
        [proof.seq, proof.entryHash, observationId, digest]);
      const rows = await q('SELECT audit_seq, audit_hash FROM tm_closure_observation WHERE observation_id = ? AND digest = ?', [observationId, digest]);
      return validAuditProof({ seq: Number(rows[0]?.audit_seq), entryHash: rows[0]?.audit_hash });
    },
    readObservedTransitionsComplete: async sourceIssueId => {
      const rows = await q('SELECT * FROM tm_closure_observation WHERE source_issue_id = ? ORDER BY created_at DESC, observation_id DESC LIMIT 501', [Number(sourceIssueId)]);
      return { complete: rows.length <= 500, records: rows.slice(0, 500).filter(r => r.audit_seq != null).map(fromRow) };
    }
  };
}

export async function observeTransitionRuntime(event, transition) {
  const [{ listProjects }, { readIssueAsApp }, auditStore, ledger, governance] = await Promise.all([
    import('./store.js'), import('./jira.js'), import('../db/store.js'), import('../lib/ledger.js'), import('./governanceStore.js')
  ]);
  const store = createObservationStore(), governing = governance.createGovernanceStore();
  return observeGovernedTransition(event, transition, { ...store, now: Date.now,
    audit: e => ledger.append(auditStore.auditStore, e),
    isGovernedSource: async issue => {
      const projects = await listProjects();
      if (!projects.some(p => p.enabled)) return false;
      const current = issue.fields?.project?.id ? issue : await readIssueAsApp(issue.id);
      const project = projects.find(p => p.enabled && p.projectId === String(current.fields?.project?.id));
      if (!project) return false;
      const records = await governing.readGovernanceRecordsComplete(issue.id);
      if (records.complete !== true) fail();
      return records.records.length > 0;
    }
  });
}
