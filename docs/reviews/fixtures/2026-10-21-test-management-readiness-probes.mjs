import assert from 'node:assert/strict';
import { tmWorld } from '../../../test/helpers/tm-world.js';
import { fixture, request } from '../../../test/admin-fixture.js';
import { createTestAuthoring } from '../../../src/usecases/testAuthoring.js';
import { createTestExecution } from '../../../src/usecases/testExecution.js';
import { repairTestBug } from '../../../src/usecases/testManagementAdmin.js';
import { executionGuard } from '../../../src/testmgmt/executionGuard.js';
import { SETTLE_MS } from '../../../src/testmgmt/bug.js';

const parent = { id: '10', key: 'VAT-10' };
const actor = (w, accountId) => { w.viewer = accountId; return { accountId }; };
async function setup({ sign = true } = {}) {
  const w = tmWorld();
  w.addIssue('11', 'VAT-11', '1', { parent });
  w.addIssue('12', 'VAT-12', '2', { parent, attachments: [{ id: '700', filename: 'trace.log', size: 10 }] });
  w.grants.push({ accountId: 'approver', role: 'APPROVER' }, { accountId: 'tester', role: 'TESTER' }, { accountId: 'qa', role: 'QA' });
  const authoring = createTestAuthoring(w.deps), exec = createTestExecution(w.deps);
  let v = await authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0,
    draft: { objective: 'Probe', steps: [{ id: 's1', action: 'Act', data: '', expected: 'Expected' }] } }, actor(w, 'approver'));
  v = await authoring.publish({ issueKey: 'VAT-11', expectedRevision: v.draft.revision }, actor(w, 'approver'));
  const version = v.versions[0];
  if (sign) await authoring.signVersion({ versionId: version.versionId, code: '123456', contentHash: version.digest }, actor(w, 'approver'));
  return { w, authoring, exec, version };
}
async function add(c, status) {
  let v = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(c.w, 'tester'));
  let r = v.runs.at(-1);
  if (status) {
    v = await c.exec.recordStep({ runId: r.runId, expectedRevision: r.revision, stepId: 's1', status }, actor(c.w, 'tester'));
    r = v.runs.find(x => x.runId === r.runId);
  }
  return r;
}
async function guard(c) {
  return executionGuard({ issue: c.w.issues.get('12'), readStatusCategory: async () => 'done' }, c.w.deps);
}
const out = [];

// The terminal state is committed before authentication starts.
{
  const c = await setup(), r = await add(c);
  let openDuringAuth;
  c.w.deps.verifyTotp = async () => {
    openDuringAuth = (await guard(c)).open.length;
    throw new Error('credential storage unavailable');
  };
  await assert.rejects(c.exec.closeNotExecuted({ runId: r.runId, code: '000000', reason: 'Cannot execute' }, actor(c.w, 'tester')));
  const state = c.w.runs.get(r.runId).state;
  const signatures = c.w.signatures.filter(s => s.subject_kind === 'RUN_NOT_EXECUTED').length;
  const open = (await guard(c)).open.length;
  assert.equal(state, 'NOT_EXECUTED'); assert.equal(signatures, 0); assert.equal(open, 0); assert.equal(openDuringAuth, 0);
  out.push({ probe: 'unsigned terminal closure after authentication exception', state, closureSignatures: signatures, blockingRuns: open, blockingRunsDuringAuthentication: openDuringAuth });
}

// A final version signature is durable before its version state is updated.
{
  const c = await setup({ sign: false });
  const original = c.w.deps.setVersionState;
  c.w.deps.setVersionState = async () => { throw new Error('SQL state write unavailable'); };
  await assert.rejects(c.authoring.signVersion({ versionId: c.version.versionId, code: '123456', contentHash: c.version.digest }, actor(c.w, 'approver')));
  c.w.deps.setVersionState = original;
  const v = (await c.authoring.view('VAT-11', actor(c.w, 'approver'))).versions[0];
  await assert.rejects(c.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, actor(c.w, 'approver')), { reason: 'VERSION_NOT_PUBLISHED' });
  await assert.rejects(c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(c.w, 'tester')), { reason: 'NO_SIGNED_VERSION' });
  assert.equal(v.state, 'PUBLISHED'); assert.equal(v.signatures.length, 1); assert.equal(v.nextStep, null); assert.equal(v.canSign, false);
  out.push({ probe: 'completed version signature stranded before state write', state: v.state, signatureCount: v.signatures.length, nextStep: v.nextStep, canSign: v.canSign, addRun: 'NO_SIGNED_VERSION' });
}

// Evidence is hashed when attached, but loss is not checked before signing.
{
  const c = await setup(); let hashes = 0;
  c.w.deps.hashAttachment = async () => { hashes++; return { sha256: 'a'.repeat(64), size: 10 }; };
  let r = await add(c, 'PASSED');
  let v = await c.exec.attachEvidence({ runId: r.runId, expectedRevision: r.revision, stepId: 's1', attachmentId: '700' }, actor(c.w, 'tester'));
  r = v.runs[0];
  c.w.issues.get('12').fields.attachment = [];
  c.w.deps.hashAttachment = async () => { hashes++; throw new Error('evidence deleted'); };
  v = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, actor(c.w, 'tester'));
  v = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: v.runs[0].contentHash }, actor(c.w, 'qa'));
  assert.equal(v.runs[0].state, 'SIGNED'); assert.equal(v.runs[0].result, 'PASSED'); assert.equal(hashes, 1);
  out.push({ probe: 'deleted evidence still permits signed passing run', state: v.runs[0].state, result: v.runs[0].result, evidenceHashesRead: hashes, remainingAttachments: v.attachments.length });
}

// Search page completeness does not establish visibility after a fixed delay.
{
  const c = await setup(); c.w.searchLagMs = 20 * 60_000;
  let r = await add(c, 'FAILED');
  let v = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, actor(c.w, 'tester'));
  c.w.createFails.push('lost-after-create');
  v = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: v.runs[0].contentHash }, actor(c.w, 'qa'));
  assert.equal(c.w.created.length, 1);
  c.w.advance(SETTLE_MS + 1000);
  v = await c.exec.retryBug({ runId: r.runId }, actor(c.w, 'qa'));
  assert.equal(c.w.created.length, 2);
  out.push({ probe: 'duplicate bug while Jira search still lags beyond settle interval', jiraIssuesCreated: c.w.created.length, recordedIssue: v.runs[0].bug.issueKey, state: v.runs[0].bug.state });
}

// Repair accepts any work type in the project and writes no relationship.
{
  const c = await setup(); c.w.createFails.push(400);
  let r = await add(c, 'FAILED');
  let v = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, actor(c.w, 'tester'));
  v = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: v.runs[0].contentHash }, actor(c.w, 'qa'));
  assert.equal(v.runs[0].bug.state, 'NEEDS_REPAIR');
  c.w.addIssue('777', 'VAT-777', '7');
  const d = fixture(); d.tm = c.w.deps;
  const repaired = await repairTestBug(request({ runId: r.runId, bugKey: 'VAT-777', reason: 'Repair probe' }), d);
  assert.equal(repaired.success, true, repaired.error);
  const bug = await c.w.deps.readBug(r.runId);
  const open = (await guard(c)).open.length;
  assert.equal(bug.issueId, '777'); assert.equal(bug.state, 'CREATED'); assert.equal(open, 0); assert.equal(c.w.links.length, 0);
  out.push({ probe: 'same-project Story accepted as bug repair', repairedType: 'Story', bugState: bug.state, blockingRuns: open, linksCreated: c.w.links.length });
}

// A signature is visible to the next signer before its ledger entry succeeds.
{
  const c = await setup(); const r = await add(c, 'PASSED');
  const audit = c.w.deps.audit;
  let entered, failLedger;
  const reached = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise((_resolve, reject) => { failLedger = reject; });
  c.w.deps.audit = async event => {
    if (event.eventType === 'TM_SIGNED' && event.payload.kind === 'RUN' && event.payload.stepIndex === 0) {
      entered(); await blocked;
    }
    return audit(event);
  };
  const first = c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, actor(c.w, 'tester'))
    .then(value => ({ value }), error => ({ error: error.reason ?? error.message }));
  await reached;
  const during = (await c.exec.view('VAT-12', actor(c.w, 'qa'))).runs[0];
  await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: during.contentHash }, actor(c.w, 'qa'));
  failLedger(new Error('tester audit write failed'));
  const firstResult = await first;
  const remaining = c.w.signatures.filter(s => s.subject_kind === 'RUN');
  assert.equal(c.w.runs.get(r.runId).state, 'SIGNED');
  assert.deepEqual(remaining.map(s => s.step_index), [1]);
  assert.equal(firstResult.error, 'LEDGER_UNAVAILABLE');
  assert.equal((await guard(c)).open.length, 0);
  out.push({ probe: 'countersignature completes before earlier signature ledger rollback', state: c.w.runs.get(r.runId).state,
    remainingSignatureSteps: remaining.map(s => s.step_index), testerSignResult: firstResult.error, blockingRuns: (await guard(c)).open.length });
}

console.log(JSON.stringify({ localReproductions: out.length, results: out }, null, 2));
