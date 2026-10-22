/**
 * An in-memory test-management world: the store functions, the Jira reads and
 * writes, signing and audit, with the same contracts as src/testmgmt/runtime.js.
 */
import { recordSignature, holdersFrom } from '../../src/testmgmt/signing.js';
import { rowAuthorises } from '../../src/lib/eligibility.js';
import { DEFAULT_RUN_CHAIN, DEFAULT_VERSION_CHAIN } from '../../src/testmgmt/chain.js';
import { terminalProofProblem } from '../../src/testmgmt/proof.js';

export function tmWorld({ chain = DEFAULT_RUN_CHAIN, versionChain = DEFAULT_VERSION_CHAIN } = {}) {
  let clock = 1_760_000_000_000;
  let seq = 0;
  const w = {
    issues: new Map(), drafts: new Map(), versions: new Map(), runs: new Map(), signatures: [], bugs: new Map(),
    audit: [], created: [], links: [], grants: [], permissions: new Set(), viewer: 'tester-1',
    project: { projectId: '100', enabled: true, testTypeId: '1', executionTypeId: '2', planTypeId: null,
      defectTypeId: '3', linkTypeName: 'Relates', runChain: chain, versionChain, revision: 1 },
    createFails: [], ledgerDown: false, hiddenFromViewer: new Set(), searchLagMs: 0, markers: new Map()
  };
  // A grant as va_eligibility holds it: '*' (every work type) unless one is named.
  const grantRow = (g) => ({ account_id: g.accountId, role: g.role, issue_type_id: g.issueTypeId ?? '*',
    project_id: g.projectId ?? null, state: 'ACTIVE' });
  w.advance = (ms) => { clock += ms; };
  const issue = (id, key, typeId, { parent = null, done = false, attachments = [] } = {}) => {
    w.issues.set(String(id), { id: String(id), key, fields: { summary: `${key} summary`, project: { id: '100' },
      issuetype: { id: typeId }, status: { name: done ? 'Done' : 'Open', statusCategory: { key: done ? 'done' : 'new' } },
      parent: parent ? { id: parent.id, key: parent.key, fields: { summary: 'Epic' } } : null, attachment: attachments } });
  };
  w.addIssue = issue;
  const find = (idOrKey) => [...w.issues.values()].find(i => i.id === String(idOrKey) || i.key === String(idOrKey));
  const notFound = () => Object.assign(new Error('nf'), { reason: 'NOT_FOUND' });
  w.deps = {
    now: () => (clock += 1000),
    newHexId: () => (++seq).toString(16).padStart(32, '0'),
    readIssueAsUser: async (k) => {
      const i = find(k);
      if (!i || w.hiddenFromViewer.has(`${w.viewer}:${i.id}`)) throw notFound();
      return structuredClone(i);
    },
    readIssueAsApp: async (k) => { const i = find(k); if (!i) throw notFound(); return structuredClone(i); },
    hasIssuePermission: async (id, perm) => !w.permissions.has(`deny:${perm}:${id}`),
    myself: async () => ({ displayName: `Name of ${w.viewer}` }),
    projectVersions: async () => [{ id: '900', name: 'R1', released: false }],
    readProject: async () => w.project,
    testManagementRole: async (i) => {
      const t = i?.fields?.issuetype?.id;
      if (!w.project.enabled) return null;
      if (t === w.project.testTypeId) return { role: 'TEST', project: w.project };
      if (t === w.project.executionTypeId) return { role: 'EXECUTION', project: w.project };
      return null;
    },
    // drafts
    readDraft: async (id) => structuredClone(w.drafts.get(String(id)) ?? null),
    saveDraft: async ({ testIssueId, content, expectedRevision, actor }) => {
      const cur = w.drafts.get(String(testIssueId));
      if ((cur?.revision ?? 0) !== expectedRevision) return null;
      const revision = (cur?.revision ?? 0) + 1;
      w.drafts.set(String(testIssueId), { content: structuredClone(content), revision, updatedAt: clock, updatedBy: actor });
      return revision;
    },
    // versions
    listVersions: async (id) => [...w.versions.values()].filter(v => v.testIssueId === String(id))
      .sort((a, b) => b.versionNo - a.versionNo).map(v => structuredClone(v)),
    readVersion: async (id) => structuredClone(w.versions.get(id) ?? null),
    readVersions: async (ids) => ids.map(id => w.versions.get(id)).filter(Boolean).map(v => structuredClone(v)),
    insertVersion: async (v) => {
      if ([...w.versions.values()].some(x => x.testIssueId === String(v.testIssueId) && x.versionNo === v.versionNo)) return false;
      w.versions.set(v.versionId, { ...structuredClone(v), testIssueId: String(v.testIssueId), state: 'PUBLISHING', signedAt: null });
      return true;
    },
    activateVersionPublication: async id => {
      const version = w.versions.get(id);
      if (!version || version.state !== 'PUBLISHING') return false;
      if (!w.audit.some(e => e.eventType === 'TM_VERSION_PUBLISHED' && e.payload.versionId === id && e.eventId?.toString('hex') === version.publishEventId)) throw Object.assign(new Error('publication audit missing'), { reason: 'PUBLICATION_PENDING' });
      version.state = 'PUBLISHED'; return true;
    },
    deleteVersion: async (id) => { w.versions.delete(id); },
    supersedePublished: async (testId, except) => {
      for (const v of w.versions.values()) if (v.testIssueId === String(testId) && v.state === 'PUBLISHED' && v.versionId !== except) v.state = 'SUPERSEDED';
    },
    setVersionState: async (id, { from, to, now }) => {
      const v = w.versions.get(id); if (!v || v.state !== from) return false;
      v.state = to; if (to === 'SIGNED') v.signedAt = now; return true;
    },
    latestSignedVersion: async (id) => structuredClone([...w.versions.values()]
      .filter(v => v.testIssueId === String(id) && v.state === 'SIGNED').sort((a, b) => b.versionNo - a.versionNo)[0] ?? null),
    // runs
    insertRun: async (r) => {
      if (r.creationKey && [...w.runs.values()].some(run => run.creationKey === r.creationKey)) return false;
      w.runs.set(r.runId, { ...structuredClone(r), state: 'CREATING', revision: 1, frozenDigest: null }); return true;
    },
    readRunByCreationKey: async key => structuredClone([...w.runs.values()].find(r => r.creationKey === key) ?? null),
    activateRunCreation: async id => {
      const run = w.runs.get(id);
      if (!run || run.state !== 'CREATING') return false;
      if (!w.audit.some(e => e.eventType === 'TM_RUN_CREATED' && e.payload.runId === id && e.eventId?.toString('hex') === run.creationEventId)) throw Object.assign(new Error('creation audit missing'), { reason: 'RUN_SETUP_PENDING' });
      run.state = 'IN_PROGRESS'; return true;
    },
    deleteRun: async (id) => { w.runs.delete(id); },
    readRun: async (id) => structuredClone(w.runs.get(id) ?? null),
    listRunsForExecution: async (id) => [...w.runs.values()].filter(r => r.executionIssueId === String(id)).map(r => structuredClone(r)),
    listOpenRunsForExecution: async (id) => [...w.runs.values()].filter(r => r.executionIssueId === String(id))
      .map(r => ({ runId: r.runId, state: r.state, result: r.result, bugState: w.bugs.get(r.runId)?.state ?? null,
        proofProblem: ['SIGNED', 'REJECTED', 'NOT_EXECUTED'].includes(r.state) ? terminalProofProblem(r,
          w.signatures.filter(s => s.subject_kind === 'RUN' && s.subjectId === r.runId && s.state === 'ACTIVE'),
          w.signatures.filter(s => s.subject_kind === 'RUN_NOT_EXECUTED' && s.subjectId === r.runId && s.state === 'ACTIVE')) : null }))
      .filter(r => !['SIGNED', 'REJECTED', 'NOT_EXECUTED'].includes(r.state)
        || r.proofProblem
        || (r.state === 'SIGNED' && r.result === 'FAILED' && r.bugState !== 'CREATED')),
    listRunsForTest: async (id) => [...w.runs.values()].filter(r => r.testIssueId === String(id)).map(r => structuredClone(r)),
    updateRunSteps: async ({ runId, expectedRevision, steps, result }) => {
      const r = w.runs.get(runId); if (!r || r.revision !== expectedRevision || r.state !== 'IN_PROGRESS') return false;
      Object.assign(r, { steps: structuredClone(steps), result, revision: r.revision + 1 }); return true;
    },
    setRunState: async ({ runId, from, to, expectedRevision, frozenDigest }) => {
      const r = w.runs.get(runId); if (!r || r.state !== from || r.revision !== expectedRevision) return false;
      Object.assign(r, { state: to, revision: r.revision + 1, frozenDigest: r.frozenDigest ?? frozenDigest ?? null }); return true;
    },
    unfreezeRun: async ({ runId, from }) => {
      const r = w.runs.get(runId);
      if (!r || r.state !== from || w.signatures.some(s => s.subjectId === runId)) return false;
      Object.assign(r, { state: 'IN_PROGRESS', frozenDigest: null, revision: r.revision + 1 }); return true;
    },
    // signatures
    listSignatures: async (kind, id) => w.signatures.filter(s => s.subject_kind === kind && s.subjectId === id && s.state === 'ACTIVE')
      .sort((a, b) => a.step_index - b.step_index).map(s => ({ ...s })),
    listSignaturesFor: async (kind, ids) => w.signatures.filter(s => s.subject_kind === kind && ids.includes(s.subjectId) && s.state === 'ACTIVE').map(s => ({ ...s })),
    insertSignature: async (s) => {
      if (w.signatures.some(x => x.subject_kind === s.kind && x.subjectId === s.subjectId && x.step_index === s.stepIndex)) return false;
      w.signatures.push({ subject_kind: s.kind, subjectId: s.subjectId, step_index: s.stepIndex, account_id: s.accountId,
        printedName: s.printedName, role: s.role, label: s.label, meaning: s.meaning, decision: s.decision,
        reason: s.reason, contentHash: s.contentHash, assuranceLevel: s.assuranceLevel, signedAt: s.signedAt,
        state: 'PENDING', auditEventId: s.auditEventId });
      return true;
    },
    activateSignature: async ({ kind, subjectId, stepIndex, auditEventId, proof }) => {
      const s = w.signatures.find(s => s.subject_kind === kind && s.subjectId === subjectId && s.step_index === stepIndex && s.auditEventId === auditEventId && s.state === 'PENDING');
      if (!s) return false;
      Object.assign(s, { state: 'ACTIVE', auditSeq: proof.seq, auditHash: proof.entryHash }); return true;
    },
    hasPendingSignatures: async (kind, id) => w.signatures.some(s => s.subject_kind === kind && s.subjectId === id && s.state !== 'ACTIVE'),
    recoverSignatures: async (kind, id) => {
      for (const s of w.signatures.filter(s => s.subject_kind === kind && s.subjectId === id && s.state === 'PENDING')) {
        const entry = w.audit.find(e => e.eventId?.toString('hex') === s.auditEventId);
        if (entry) await w.deps.activateSignature({ kind, subjectId: id, stepIndex: s.step_index, auditEventId: s.auditEventId, proof: entry.proof });
      }
    },
    deleteSignature: async ({ kind, subjectId, stepIndex, auditEventId }) => {
      w.signatures = w.signatures.filter(s => !(s.subject_kind === kind && s.subjectId === subjectId && s.step_index === stepIndex && s.auditEventId === auditEventId && s.state === 'PENDING'));
    },
    isEligibleFor: async ({ accountId, projectId, issueTypeId, role }) => {
      if (!issueTypeId) throw new Error('isEligibleFor: the subject\'s work type is required');
      return w.grants.map(grantRow).some(row => row.account_id === accountId && rowAuthorises(row, { projectId, issueTypeId, role }));
    },
    roleHolders: async ({ projectId, issueTypeId, roles }) => {
      if (!issueTypeId) throw new Error('roleHolders: the subject\'s work type is required');
      return holdersFrom(w.grants.map(grantRow), { projectId, issueTypeId, roles: [...new Set(roles)] });
    },
    verifyTotp: async (_a, code) => (code === '123456' ? { ok: true } : { ok: false, reason: 'CODE_INVALID_OR_REPLAYED', error: 'Invalid code.' }),
    audit: async (e) => { if (w.ledgerDown) throw new Error('ledger down'); const proof = { seq: w.audit.length + 1, entryHash: 'a'.repeat(64) }; w.audit.push({ ...e, proof }); return proof; },
    tryAudit: async (e) => { w.audit.push(e); },
    // bugs
    insertBugIntent: async ({ runId, projectId, parentIssueId, marker, now }) => {
      if (w.bugs.has(runId)) return false;
      w.bugs.set(runId, { runId, projectId: String(projectId), parentIssueId: parentIssueId == null ? null : String(parentIssueId),
        marker, state: 'INTENT', issueId: null, issueKey: null, attempts: 0, lastError: null, updatedAt: now });
      return true;
    },
    readBug: async (id) => structuredClone(w.bugs.get(id) ?? null),
    listBugsFor: async (ids) => ids.map(id => w.bugs.get(id)).filter(Boolean).map(b => structuredClone(b)),
    updateBug: async (id, { from, state, issueId, issueKey, lastError = null, attempted, expectedAttempts = null, now }) => {
      const b = w.bugs.get(id); if (!b || b.state !== from) return false;
      if (expectedAttempts != null && b.attempts !== expectedAttempts) return false;
      Object.assign(b, { state, issueId: issueId ?? b.issueId, issueKey: issueKey ?? b.issueKey, lastError,
        attempts: b.attempts + (attempted ? 1 : 0), updatedAt: now });
      return true;
    },
    // Created issues are numbered 5001, 5002, ... and carry their properties
    // and creation time. Search sees one only `searchLagMs` after it was made,
    // as Jira's index does.
    createIssueAsApp: async (fields, properties = []) => {
      const failure = w.createFails.shift();
      const make = () => {
        w.created.push(fields);
        const id = String(5000 + w.created.length);
        const mark = properties.find(p => p.key === 'va-tm-bug')?.value;
        w.markers.set(id, { projectId: String(fields.project?.id ?? ''), runId: mark?.runId ?? null, at: clock });
        return { id, key: `BUG-${w.created.length}` };
      };
      if (failure === 'lost-after-create') { make(); throw Object.assign(new Error('lost'), { status: null }); }
      if (failure) throw Object.assign(new Error('fail'), { status: failure });
      return make();
    },
    searchByLabelAsApp: async (label) => ({ complete: true, issues: w.created
      .map((f, i) => ({ f, id: String(5001 + i), key: `BUG-${i + 1}` }))
      .filter(x => (x.f.labels ?? []).includes(label) && clock - (w.markers.get(x.id)?.at ?? 0) >= w.searchLagMs)
      .map(({ id, key }) => ({ id, key })) }),
    readBugMarkerAsApp: async (id) => {
      const mark = w.markers.get(String(id));
      if (!mark) throw notFound();
      return { projectId: mark.projectId, runId: mark.runId };
    },
    linkIssueAsApp: async (link) => { w.links.push(link); },
    createScreenFields: async () => new Set(['summary', 'description', 'labels', 'parent', 'fixVersions']),
    hashAttachment: async (id) => ({ sha256: 'a'.repeat(63) + String(id).slice(-1), size: 10 })
  };
  w.deps.retainEvidence = async ({ attachment }) => {
    const proof = await w.deps.hashAttachment(attachment.id);
    return { attachmentId: String(attachment.id), filename: attachment.filename, mimeType: 'application/octet-stream', ...proof,
      retained: { kind: 'FORGE_OBJECT_STORE', objectKey: `sha256/${proof.sha256}`, ...proof } };
  };
  w.deps.verifyEvidence = async entries => { if (entries.some(e => !e.retained)) throw Object.assign(new Error('evidence not retained'), { reason: 'EVIDENCE_RETENTION_REQUIRED' }); return { ok: true }; };
  w.deps.recordSignature = (args, deps) => recordSignature(args, deps);
  return w;
}
