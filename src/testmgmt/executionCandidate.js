import { contentDigest } from './content.js';
import { validAuditProof } from './governance.js';
import { tmFail } from './messages.js';

export const CANDIDATE_MIGRATIONS = [{ id: 'v182_tm_execution_candidate', sql: `CREATE TABLE IF NOT EXISTS tm_execution_candidate (
  execution_issue_id BIGINT NOT NULL PRIMARY KEY, project_id BIGINT NOT NULL, reported_build TEXT NOT NULL,
  digest CHAR(64) NOT NULL, created_by VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
  audit_event_id CHAR(32) NOT NULL, audit_seq BIGINT NULL, audit_hash CHAR(64) NULL
)` }];
const content = r => ({ kind: 'EXECUTION_CANDIDATE', executionIssueId: String(r.executionIssueId), projectId: String(r.projectId), reportedBuild: r.reportedBuild });
export function executionCandidateProof(record, expected) {
  return !!record && record.executionIssueId === String(expected.executionIssueId) && record.projectId === String(expected.projectId) &&
    contentDigest(record.reportedBuild) === contentDigest(expected.reportedBuild) && record.digest === contentDigest(content(record)) && validAuditProof(record.auditProof);
}

export function createExecutionCandidates(deps) {
  return { claimExecutionCandidate: async input => {
    if (!input.reportedBuild || typeof input.reportedBuild !== 'object' || Array.isArray(input.reportedBuild) ||
        !Object.keys(input.reportedBuild).length || Buffer.byteLength(JSON.stringify(input.reportedBuild)) > 8000 ||
        !/^\d+$/.test(String(input.executionIssueId)) || !/^\d+$/.test(String(input.projectId)) || !input.actorAccountId) tmFail('INVALID_INPUT');
    const frozen = content(input), digest = contentDigest(frozen);
    await deps.insertExecutionCandidate({ ...frozen, digest, createdAt: deps.now(), createdBy: input.actorAccountId, auditEventId: digest.slice(0, 32), auditProof: null });
    let record = await deps.readExecutionCandidate(input.executionIssueId);
    if (!record || record.digest !== digest || contentDigest(content(record)) !== digest) tmFail('EXECUTION_CANDIDATE_MISMATCH');
    if (!validAuditProof(record.auditProof)) {
      const proof = await deps.audit({ eventId: Buffer.from(record.auditEventId, 'hex'), eventType: 'TM_EXECUTION_CANDIDATE_BOUND', actorAccountId: record.createdBy,
        issueId: Number(record.executionIssueId), payload: { ...frozen, digest } });
      if (!validAuditProof(proof) || !await deps.confirmExecutionCandidate({ executionIssueId: record.executionIssueId, digest, proof })) tmFail('CANDIDATE_PENDING');
      record = await deps.readExecutionCandidate(input.executionIssueId);
    }
    if (!executionCandidateProof(record, input)) tmFail('CANDIDATE_PENDING');
    return record;
  } };
}

const defaultQuery = async (sql, params) => (await import('../lib/db.js')).executeQuery(sql, params);
export function createCandidateStore({ query = defaultQuery } = {}) {
  const q = async (sql, params) => { const r = await query(sql, params); if (!r?.result) tmFail('SERVICE_UNAVAILABLE'); return r.data; };
  const id = value => { if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) tmFail('INVALID_INPUT'); return Number(value); };
  const readExecutionCandidate = async executionIssueId => {
    const row = (await q('SELECT * FROM tm_execution_candidate WHERE execution_issue_id = ?', [id(executionIssueId)]))[0];
    if (!row) return null;
    let reportedBuild; try { reportedBuild = typeof row.reported_build === 'object' ? row.reported_build : JSON.parse(row.reported_build); } catch { tmFail('CANDIDATE_PENDING'); }
    return { executionIssueId: String(row.execution_issue_id), projectId: String(row.project_id), reportedBuild, digest: row.digest,
      createdBy: row.created_by, createdAt: Number(row.created_at), auditEventId: row.audit_event_id,
      auditProof: row.audit_seq == null ? null : { seq: Number(row.audit_seq), entryHash: row.audit_hash } };
  };
  return { readExecutionCandidate,
    insertExecutionCandidate: r => q(`INSERT INTO tm_execution_candidate (execution_issue_id, project_id, reported_build, digest, created_by, created_at, audit_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE execution_issue_id = execution_issue_id`,
    [id(r.executionIssueId), id(r.projectId), JSON.stringify(r.reportedBuild), r.digest, r.createdBy, r.createdAt, r.auditEventId]),
    confirmExecutionCandidate: async ({ executionIssueId, digest, proof }) => {
      if (!validAuditProof(proof)) return false;
      await q('UPDATE tm_execution_candidate SET audit_seq = ?, audit_hash = ? WHERE execution_issue_id = ? AND digest = ? AND audit_seq IS NULL', [proof.seq, proof.entryHash, id(executionIssueId), digest]);
      const record = await readExecutionCandidate(executionIssueId);
      return record?.digest === digest && validAuditProof(record.auditProof);
    }
  };
}
