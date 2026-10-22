import test from 'node:test';
import assert from 'node:assert/strict';
import { tmWorld } from './helpers/tm-world.js';
import { createTestAuthoring } from '../src/usecases/testAuthoring.js';
import { createTestExecution } from '../src/usecases/testExecution.js';
import { executionGuard } from '../src/testmgmt/executionGuard.js';
import { chainPreflight } from '../src/testmgmt/chain.js';

const who = (w, accountId) => { w.viewer = accountId; return { accountId }; };
async function fixture({ signed = true } = {}) {
  const w = tmWorld();
  const parent = { id: '10', key: 'VAT-10' };
  w.addIssue('11', 'VAT-11', '1', { parent });
  w.addIssue('12', 'VAT-12', '2', { parent });
  w.grants.push({ accountId: 'approver', role: 'APPROVER' }, { accountId: 'tester', role: 'TESTER' }, { accountId: 'qa', role: 'QA' });
  const authoring = createTestAuthoring(w.deps), exec = createTestExecution(w.deps);
  let v = await authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0,
    draft: { steps: [{ id: 's1', action: 'Act', data: '', expected: 'Expected' }] } }, who(w, 'approver'));
  v = await authoring.publish({ issueKey: 'VAT-11', expectedRevision: v.draft.revision }, who(w, 'approver'));
  const version = v.versions[0];
  if (signed) await authoring.signVersion({ versionId: version.versionId, code: '123456', contentHash: version.digest }, who(w, 'approver'));
  return { w, authoring, exec, version };
}
async function run(c, status = null) {
  let v = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, who(c.w, 'tester'));
  let r = v.runs[0];
  if (status) {
    v = await c.exec.recordStep({ runId: r.runId, expectedRevision: r.revision, stepId: 's1', status }, who(c.w, 'tester'));
    r = v.runs[0];
  }
  return r;
}
const guard = c => executionGuard({ issue: c.w.issues.get('12'), readStatusCategory: async () => 'done' }, c.w.deps);

test('a countersigner cannot advance a signature whose audit entry is still pending', async () => {
  const c = await fixture(), r = await run(c, 'PASSED');
  const audit = c.w.deps.audit;
  let entered, rejectLedger;
  const reached = new Promise(resolve => { entered = resolve; });
  const pending = new Promise((_resolve, reject) => { rejectLedger = reject; });
  c.w.deps.audit = async e => {
    if (e.eventType === 'TM_SIGNED' && e.payload.kind === 'RUN' && e.payload.stepIndex === 0) { entered(); await pending; }
    return audit(e);
  };
  const first = c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, who(c.w, 'tester'))
    .then(value => ({ value }), error => ({ error }));
  await reached;
  let rejection;
  try { await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, who(c.w, 'qa')); }
  catch (error) { rejection = error; }
  rejectLedger(new Error('ledger failed'));
  await first;
  assert.ok(rejection, 'QA must not advance the pending tester signature');
  assert.notEqual(c.w.runs.get(r.runId).state, 'SIGNED');
  assert.equal((await guard(c)).open.length, 1);
});

test('an authentication exception cannot leave an unsigned terminal closure', async () => {
  const c = await fixture(), r = await run(c);
  let blockingDuringAuth;
  c.w.deps.verifyTotp = async () => {
    blockingDuringAuth = (await guard(c)).open.length;
    throw new Error('credential store unavailable');
  };
  await assert.rejects(c.exec.closeNotExecuted({ runId: r.runId, code: '000000', reason: 'Unavailable' }, who(c.w, 'tester')));
  assert.equal(blockingDuringAuth, 1);
  assert.notEqual(c.w.runs.get(r.runId).state, 'NOT_EXECUTED');
  assert.equal((await guard(c)).open.length, 1);
  assert.equal(c.w.signatures.filter(s => s.subject_kind === 'RUN_NOT_EXECUTED').length, 0);
});

test('a version whose confirmed final signature outlives its state write can be finished', async () => {
  const c = await fixture({ signed: false });
  const set = c.w.deps.setVersionState;
  c.w.deps.setVersionState = async () => { throw new Error('state write unavailable'); };
  const interim = await c.authoring.signVersion({ versionId: c.version.versionId, code: '123456', contentHash: c.version.digest }, who(c.w, 'approver'));
  assert.equal(interim.versions[0].state, 'PUBLISHED');
  assert.equal(interim.versions[0].canFinish, true);
  c.w.deps.setVersionState = set;
  const finished = await c.authoring.finishVersion({ versionId: c.version.versionId }, who(c.w, 'approver'));
  assert.equal(finished.versions[0].state, 'SIGNED');
  assert.equal(finished.versions[0].signatures.length, 1);
  const added = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, who(c.w, 'tester'));
  assert.equal(added.runs.length, 1);
});

test('a failed signature deletion never makes an unaudited signature effective', async () => {
  const c = await fixture(), r = await run(c, 'PASSED');
  c.w.ledgerDown = true;
  c.w.deps.deleteSignature = async () => { throw new Error('delete unavailable'); };
  await assert.rejects(c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, who(c.w, 'tester')));
  c.w.ledgerDown = false;
  const v = await c.exec.view('VAT-12', who(c.w, 'qa'));
  assert.equal(v.runs[0].signatures.length, 0);
  assert.equal(v.runs[0].canSign, false);
  assert.equal((await guard(c)).open.length, 1);
});

test('a signature promotion failure is recoverable from its durable audit event', async () => {
  const c = await fixture(), r = await run(c, 'PASSED');
  const activate = c.w.deps.activateSignature;
  c.w.deps.activateSignature = async () => { throw new Error('promotion unavailable'); };
  await assert.rejects(c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, who(c.w, 'tester')));
  c.w.deps.activateSignature = activate;
  await c.exec.retryBug({ runId: r.runId }, who(c.w, 'tester'));
  const v = await c.exec.view('VAT-12', who(c.w, 'qa'));
  assert.equal(v.runs[0].signatures.length, 1);
  assert.equal(v.runs[0].nextStep.index, 1);
});

test('a terminal run whose required signature proof is missing still holds Done', async () => {
  const c = await fixture(), r = await run(c, 'PASSED');
  const first = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, who(c.w, 'tester'));
  await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: first.runs[0].contentHash }, who(c.w, 'qa'));
  c.w.signatures = c.w.signatures.filter(s => !(s.subject_kind === 'RUN' && s.step_index === 0));
  assert.equal((await guard(c)).open[0].reason, 'RUN_PROOF_INVALID');
});

test('an impossible six-step signer chain is rejected with bounded holder visits', () => {
  let visits = 0;
  const holders = Array.from({ length: 40 }, (_, i) => `t${i}`);
  holders[Symbol.iterator] = function* () { for (let i = 0; i < this.length; i++) { visits++; yield this[i]; } };
  const chain = { distinctSigners: true, steps: ['TESTER', 'TESTER', 'TESTER', 'TESTER', 'QA', 'APPROVER'].map(role => ({ role })) };
  assert.equal(chainPreflight(chain, { TESTER: holders, QA: ['only'], APPROVER: ['only'] }, { mustInclude: 't0' }).ok, false);
  assert.ok(visits < 1000, `matching must not enumerate ${visits} assignments`);
});

test('results cannot advance a run before its creation audit is durable', async () => {
  const c = await fixture();
  const audit = c.w.deps.audit;
  let entered, fail;
  const reached = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise((_resolve, reject) => { fail = reject; });
  c.w.deps.audit = async e => { if (e.eventType === 'TM_RUN_CREATED') { entered(); await blocked; } return audit(e); };
  const adding = c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, who(c.w, 'tester')).catch(error => error);
  await reached;
  const pending = [...c.w.runs.values()][0];
  let refused = false;
  try { await c.exec.recordStep({ runId: pending.runId, expectedRevision: pending.revision, stepId: 's1', status: 'PASSED' }, who(c.w, 'tester')); }
  catch (error) { refused = error.reason === 'RUN_NOT_OPEN'; }
  fail(new Error('creation ledger failed')); await adding;
  assert.equal(refused, true);
  assert.equal(c.w.runs.size, 0, 'an unaudited draft run cannot survive by advancing its revision');
});

test('a version cannot be signed while its publication audit is pending', async () => {
  const c = await fixture({ signed: false });
  let draft = await c.authoring.view('VAT-11', who(c.w, 'approver'));
  await c.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: draft.draft.revision,
    draft: { steps: [{ id: 's1', action: 'Changed action', expected: 'Expected' }] } }, who(c.w, 'approver'));
  const audit = c.w.deps.audit;
  let entered, fail;
  const reached = new Promise(resolve => { entered = resolve; });
  const pending = new Promise((_resolve, reject) => { fail = reject; });
  c.w.deps.audit = async e => { if (e.eventType === 'TM_VERSION_PUBLISHED') { entered(); await pending; } return audit(e); };
  const publishing = c.authoring.publish({ issueKey: 'VAT-11', expectedRevision: 2 }, who(c.w, 'approver')).catch(e => e);
  await reached;
  const version = [...c.w.versions.values()].find(v => v.versionNo === 2);
  let refused = false;
  try { await c.authoring.signVersion({ versionId: version.versionId, contentHash: version.digest, code: '123456' }, who(c.w, 'approver')); }
  catch (e) { refused = e.reason === 'VERSION_NOT_PUBLISHED'; }
  fail(new Error('publication audit failed')); await publishing;
  assert.equal(refused, true);
  assert.equal([...c.w.versions.values()].some(v => v.versionNo === 2 && v.state === 'SIGNED'), false);
});
