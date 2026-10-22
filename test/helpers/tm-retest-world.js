import { contentDigest, runContent, runSteps } from '../../src/testmgmt/content.js';
import { chainDigest, DEFAULT_RUN_CHAIN, DEFAULT_VERSION_CHAIN } from '../../src/testmgmt/chain.js';

export function retestWorld() {
  let time = 1_790_000_000_000;
  const w = { issues: new Map(), runs: new Map(), versions: new Map(), signatures: [], intents: new Map(), progress: new Map(),
    creates: [], newRuns: [], audits: new Map(), hidden: new Set(), denied: new Set(), addFailures: new Set(), createFailure: null, searchLag: false };
  w.advance = ms => { time += ms; };
  w.project = { projectId: '100', enabled: true, testTypeId: '1', executionTypeId: '2', defectTypeId: '3', runChain: DEFAULT_RUN_CHAIN };
  const issue = (id, key, type, done = false) => ({ id, key, fields: { project: { id: '100' }, issuetype: { id: type },
    summary: key, parent: { id: '10', key: 'VAT-10' }, status: { statusCategory: { key: done ? 'done' : 'new' } } } });
  w.issues.set('10', issue('10', 'VAT-10', '9')); w.issues.set('12', issue('12', 'VAT-12', '2', true));
  const makeSig = (subjectId, kind, chain, digest, decision = 'SIGN') => chain.steps.map((step, i) => ({ subjectId,
    subject_kind: kind, step_index: i, account_id: i ? 'qa' : 'tester', role: step.role, state: 'ACTIVE',
    decision: i === chain.steps.length - 1 ? decision : 'SIGN', contentHash: digest, auditSeq: i + 1, auditHash: 'a'.repeat(64) }));
  for (const [index, state, result] of [[1, 'SIGNED', 'FAILED'], [2, 'REJECTED', 'PASSED'], [3, 'NOT_EXECUTED', 'NOT_RUN'], [4, 'SIGNED', 'PASSED']]) {
    const testId = String(20 + index), versionId = String(index + 10).padStart(32, '0'), runId = String(index).padStart(32, '0');
    w.issues.set(testId, issue(testId, `VAT-${testId}`, '1'));
    const content = { kind: 'TEST_VERSION', schema: 1, testIssueId: testId, projectId: '100', versionNo: 1, parentIssueId: '10',
      objective: 'Objective', preconditions: '', steps: [{ id: 'step1', action: 'Act', data: '', expected: 'Expected' }], verifies: [], dataset: null };
    const version = { versionId, testIssueId: testId, projectId: '100', versionNo: 1, content, digest: contentDigest(content),
      chain: DEFAULT_VERSION_CHAIN, chainDigest: chainDigest(DEFAULT_VERSION_CHAIN), state: 'SIGNED' };
    w.versions.set(versionId, version); w.signatures.push(...makeSig(versionId, 'TEST_VERSION', version.chain, version.digest));
    const steps = runSteps(content.steps, [{ id: 'step1', status: result === 'NOT_RUN' ? 'NOT_RUN' : result, actual: 'Actual', recordedBy: 'tester', evidence: [] }]);
    const run = { runId, executionIssueId: '12', testIssueId: testId, projectId: '100', testVersionId: versionId, testDigest: version.digest,
      chain: DEFAULT_RUN_CHAIN, chainDigest: chainDigest(DEFAULT_RUN_CHAIN), state, result, steps,
      environment: 'HIL', configuration: 'ECU B', release: { id: '900', name: 'R1' },
      planningSnapshot: { required: true, plan: { issueId: '40', revisionId: 'b'.repeat(32) } }, retestOf: null };
    run.frozenDigest = contentDigest(runContent(run, steps, result)); w.runs.set(runId, run);
    if (state === 'NOT_EXECUTED') w.signatures.push({ ...makeSig(runId, 'RUN_NOT_EXECUTED', { steps: [run.chain.steps[0]] }, run.frozenDigest)[0], decision: 'NOT_EXECUTED', reason: 'Bench unavailable' });
    else w.signatures.push(...makeSig(runId, 'RUN', run.chain, run.frozenDigest, state === 'REJECTED' ? 'REJECT' : 'SIGN'));
  }
  const findIssue = key => [...w.issues.values()].find(i => i.id === String(key) || i.key === key);
  w.deps = {
    now: () => ++time,
    readIssueAsUser: async key => { const found = findIssue(key); if (!found || w.hidden.has(found.id)) throw Object.assign(new Error('hidden'), { reason: 'NOT_FOUND' }); return structuredClone(found); },
    hasIssuePermission: async (id, permission) => !w.denied.has(`${id}:${permission}`),
    readProject: async () => w.project,
    testManagementRole: async i => ({ role: i.fields.issuetype.id === '2' ? 'EXECUTION' : i.fields.issuetype.id === '1' ? 'TEST' : null, project: w.project }),
    listRunsForExecution: async id => [...w.runs.values()].filter(r => r.executionIssueId === String(id)).map(r => structuredClone(r)),
    readRun: async id => structuredClone(w.runs.get(id)), readVersion: async id => structuredClone(w.versions.get(id)),
    latestSignedVersion: async testId => [...w.versions.values()].filter(v => v.testIssueId === testId && v.state === 'SIGNED').sort((a, b) => b.versionNo - a.versionNo)[0],
    listSignatures: async (kind, id) => w.signatures.filter(s => s.subject_kind === kind && s.subjectId === id),
    roleHolders: async () => ({ TESTER: ['tester'], QA: ['qa'], APPROVER: ['approver'] }),
    createScreenFields: async () => new Set(['summary', 'parent', 'labels']),
    insertRetestIntent: async intent => { if (w.intents.has(intent.requestId)) return false; w.intents.set(intent.requestId, structuredClone(intent)); return true; },
    readRetestIntent: async id => structuredClone(w.intents.get(id) ?? null),
    transitionRetestIntent: async (id, { from, to, now, ...patch }) => {
      const intent = w.intents.get(id); if (!intent || intent.state !== from) return false;
      Object.assign(intent, structuredClone(patch), { state: to, updatedAt: now }); return true;
    },
    listRetestRunLinks: async id => structuredClone(w.progress.get(id) ?? []),
    insertRetestRunLink: async link => { const links = w.progress.get(link.requestId) ?? [];
      if (!links.some(l => l.sourceRunId === link.sourceRunId)) links.push(structuredClone(link)); w.progress.set(link.requestId, links); return true; },
    readRetestAuditEvent: async id => w.audits.get(id) ?? null,
    audit: async event => { w.audits.set(event.eventId.toString('hex'), { ...event, seq: w.audits.size + 1, entryHash: 'a'.repeat(64) }); return { seq: w.audits.size, entryHash: 'a'.repeat(64) }; },
    createIssueAsApp: async (fields, properties) => {
      const id = String(1000 + w.creates.length), created = issue(id, `VAT-${id}`, fields.issuetype.id);
      created.fields.parent = fields.parent; created.properties = Object.fromEntries(properties.map(p => [p.key, p.value]));
      w.creates.push({ fields, properties, id, key: created.key }); w.issues.set(id, created);
      if (w.createFailure) throw Object.assign(new Error('answer lost'), { status: w.createFailure === 'lost' ? null : w.createFailure });
      return { id, key: created.key };
    },
    searchByLabelAsApp: async label => ({ complete: true, issues: w.searchLag ? [] : w.creates.filter(c => c.fields.labels.includes(label)).map(c => ({ id: c.id, key: c.key })) }),
    readRetestMarkerAsApp: async id => { const i = w.issues.get(id); return { projectId: i.fields.project.id, issueTypeId: i.fields.issuetype.id,
      parentIssueId: i.fields.parent.id, ...i.properties['va-tm-retest'] }; },
    addRunForRetest: async (payload, actor, selection) => {
      if (w.addFailures.has(payload.retestOf)) throw new Error('interrupted fan-out');
      const prior = w.newRuns.find(r => r.requestId === payload.requestId);
      if (!prior) w.newRuns.push({ ...payload, selection, actor, runId: String(500 + w.newRuns.length).padStart(32, '0') });
      return { runs: w.newRuns.map(r => ({ runId: r.runId, retestOf: r.retestOf })) };
    }
  };
  return w;
}
