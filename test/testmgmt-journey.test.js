import test from 'node:test';
import assert from 'node:assert/strict';
import { tmWorld } from './helpers/tm-world.js';
import { createTestAuthoring } from '../src/usecases/testAuthoring.js';
import { createTestExecution } from '../src/usecases/testExecution.js';
import { contentDigest } from '../src/testmgmt/content.js';

const EPIC = { id: '10', key: 'VAT-10' };
const STEPS = [
  { id: 's1', action: 'Power on the ECU', data: '12 V', expected: 'Boot banner within 2 s' },
  { id: 's2', action: 'Send diagnostic request 0x22', data: 'DID F190', expected: 'VIN returned' }
];

function setup(options) {
  const w = tmWorld(options);
  w.addIssue('11', 'VAT-11', '1', { parent: EPIC });
  w.addIssue('12', 'VAT-12', '2', { parent: EPIC, attachments: [{ id: '700', filename: 'trace.log', size: 10 }] });
  w.grants.push({ accountId: 'author-1', role: 'APPROVER' }, { accountId: 'approver-1', role: 'APPROVER' },
    { accountId: 'tester-1', role: 'TESTER' }, { accountId: 'qa-1', role: 'QA' });
  return { w, authoring: createTestAuthoring(w.deps), exec: createTestExecution(w.deps) };
}
const as = (w, accountId) => { w.viewer = accountId; return { accountId }; };

async function signedTest({ w, authoring }) {
  let view = await authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0, draft: { objective: 'VIN readout', steps: STEPS } }, as(w, 'author-1'));
  view = await authoring.publish({ issueKey: 'VAT-11', expectedRevision: view.draft.revision }, as(w, 'author-1'));
  const v1 = view.versions[0];
  view = await authoring.signVersion({ versionId: v1.versionId, code: '123456', contentHash: v1.digest }, as(w, 'approver-1'));
  return view.versions[0];
}

async function runToSigning(ctx, statuses) {
  const { w, exec } = ctx;
  let view = await exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11', environment: 'HIL bench 3', configuration: 'ECU rev B', releaseId: '900' }, as(w, 'tester-1'));
  let run = view.runs.at(-1);
  for (const [i, status] of statuses.entries()) {
    view = await exec.recordStep({ runId: run.runId, expectedRevision: run.revision, stepId: STEPS[i].id, status,
      actual: status === 'FAILED' ? 'No response' : 'As expected' }, as(w, 'tester-1'));
    run = view.runs.find(r => r.runId === run.runId);
  }
  return run;
}

test('a test is published and signed through its version chain before it can be run', async () => {
  const ctx = setup();
  const version = await signedTest(ctx);
  assert.equal(version.state, 'SIGNED');
  assert.equal(version.signatures[0].printedName, 'Name of approver-1');
  assert.equal(version.content.parentIssueId, EPIC.id, 'the parent is part of the signed version');
  assert.ok(ctx.w.audit.some(e => e.eventType === 'TM_VERSION_PUBLISHED'));
  assert.ok(ctx.w.audit.some(e => e.eventType === 'TM_SIGNED' && e.payload.kind === 'TEST_VERSION'));
});

test('a test without a parent cannot be published, and an unsigned test cannot be run', async () => {
  const ctx = setup();
  ctx.w.addIssue('13', 'VAT-13', '1');
  const author = as(ctx.w, 'author-1');
  const view = await ctx.authoring.saveDraft({ issueKey: 'VAT-13', expectedRevision: 0, draft: { steps: STEPS } }, author);
  await assert.rejects(ctx.authoring.publish({ issueKey: 'VAT-13', expectedRevision: view.draft.revision }, author), { reason: 'NO_PARENT' });
  const draft = await ctx.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0, draft: { steps: STEPS } }, author);
  await ctx.authoring.publish({ issueKey: 'VAT-11', expectedRevision: draft.draft.revision }, author);
  await assert.rejects(ctx.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, as(ctx.w, 'tester-1')), { reason: 'NO_SIGNED_VERSION' });
});

test('publishing the same content again is refused, and a signed version is never edited in place', async () => {
  const ctx = setup();
  const v1 = await signedTest(ctx);
  const author = as(ctx.w, 'author-1');
  const draft = (await ctx.authoring.view('VAT-11', author)).draft;
  await assert.rejects(ctx.authoring.publish({ issueKey: 'VAT-11', expectedRevision: draft.revision }, author), { reason: 'NO_CHANGES' });
  const edited = await ctx.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: draft.revision,
    draft: { steps: [...STEPS, { id: 's3', action: 'Power off', data: '', expected: 'No current draw' }] } }, author);
  const view = await ctx.authoring.publish({ issueKey: 'VAT-11', expectedRevision: edited.draft.revision }, author);
  assert.equal(view.versions[0].versionNo, 2);
  assert.equal(view.versions[1].digest, v1.digest, 'version 1 keeps its digest');
  assert.equal(contentDigest(view.versions[1].content), v1.digest);
});

test('the version signer cannot sign a step twice, and a changed hash is refused', async () => {
  const ctx = setup({ versionChain: { steps: [
    { label: 'Reviewed by', role: 'APPROVER', meaning: 'Reviewed.' }, { label: 'Approved by', role: 'APPROVER', meaning: 'Approved.' }
  ], distinctSigners: true } });
  const author = as(ctx.w, 'author-1');
  const draft = await ctx.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0, draft: { steps: STEPS } }, author);
  const pub = await ctx.authoring.publish({ issueKey: 'VAT-11', expectedRevision: draft.draft.revision }, author);
  const v = pub.versions[0];
  await assert.rejects(ctx.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: 'f'.repeat(64) }, as(ctx.w, 'approver-1')), { reason: 'CONTENT_CHANGED' });
  await ctx.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, as(ctx.w, 'approver-1'));
  await assert.rejects(ctx.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, as(ctx.w, 'approver-1')), { reason: 'SAME_SIGNER' });
  const done = await ctx.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, as(ctx.w, 'author-1'));
  assert.equal(done.versions[0].state, 'SIGNED');
});

test('a passing run is executed, frozen by the tester, countersigned by QA, and creates no bug', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  assert.equal(run.result, 'PASSED');
  assert.equal(run.signabilityProblem, null);
  let view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  let after = view.runs[0];
  assert.equal(after.state, 'SIGNING');
  await assert.rejects(ctx.exec.recordStep({ runId: run.runId, expectedRevision: after.revision, stepId: 's1', status: 'FAILED' }, as(ctx.w, 'tester-1')), { reason: 'RUN_NOT_OPEN' });
  view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: after.contentHash }, as(ctx.w, 'qa-1'));
  after = view.runs[0];
  assert.equal(after.state, 'SIGNED');
  assert.deepEqual(after.signatures.map(s => s.label), ['Executed by', 'Reviewed by']);
  assert.equal(ctx.w.created.length, 0);
  assert.equal(ctx.w.runs.get(run.runId).frozenDigest, run.contentHash, 'both steps signed the digest the tester saw');
});

test('a fully signed failed run creates exactly one bug, under the test\'s parent, linked to test and execution', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'FAILED']);
  assert.equal(run.result, 'FAILED');
  let view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  assert.equal(ctx.w.created.length, 0, 'no bug until the whole chain has signed');
  view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, as(ctx.w, 'qa-1'));
  assert.equal(ctx.w.created.length, 1);
  const bug = ctx.w.created[0];
  assert.deepEqual(bug.parent, { id: EPIC.id });
  assert.deepEqual(bug.issuetype, { id: '3' });
  assert.deepEqual(bug.fixVersions, [{ id: '900' }]);
  assert.ok(bug.labels.includes(`va-run-${run.runId}`));
  assert.deepEqual(ctx.w.links.map(l => l.outwardId).sort(), ['11', '12']);
  assert.equal(view.runs[0].bug.state, 'CREATED');
  await ctx.exec.retryBug({ runId: run.runId }, as(ctx.w, 'qa-1'));
  assert.equal(ctx.w.created.length, 1, 'a retry after creation creates nothing');
});

test('the same person cannot sign as tester and QA, and only a recorder signs as executed', async () => {
  const ctx = setup();
  ctx.w.grants.push({ accountId: 'tester-1', role: 'QA' }, { accountId: 'qa-1', role: 'TESTER' });
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  await assert.rejects(ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'qa-1')), { reason: 'NOT_A_RECORDER' });
  const view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  await assert.rejects(ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, as(ctx.w, 'tester-1')), { reason: 'SAME_SIGNER' });
});

test('a result recorded after the tester opened the run makes the signature fail, never cover it', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  await ctx.exec.recordStep({ runId: run.runId, expectedRevision: run.revision, stepId: 's2', status: 'FAILED', actual: 'late' }, as(ctx.w, 'tester-1'));
  await assert.rejects(ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1')), { reason: 'CONTENT_CHANGED' });
  assert.equal(ctx.w.signatures.filter(s => s.subjectId === run.runId).length, 0);
});

test('a wrong authenticator code leaves the run open and unsigned', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  const out = await ctx.exec.signRun({ runId: run.runId, code: '000000', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  assert.equal(out.reason, 'CODE_INVALID_OR_REPLAYED');
  assert.equal(ctx.w.runs.get(run.runId).state, 'IN_PROGRESS');
  assert.equal(ctx.w.runs.get(run.runId).frozenDigest, null);
});

test('an unfinished or blocked run cannot be signed; it can be closed as not executed with a reason', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const partial = await runToSigning(ctx, ['PASSED']);
  await assert.rejects(ctx.exec.signRun({ runId: partial.runId, code: '123456', contentHash: partial.contentHash }, as(ctx.w, 'tester-1')), { reason: 'STEPS_NOT_RUN' });
  const blocked = await runToSigning(ctx, ['PASSED', 'BLOCKED']);
  await assert.rejects(ctx.exec.signRun({ runId: blocked.runId, code: '123456', contentHash: blocked.contentHash }, as(ctx.w, 'tester-1')), { reason: 'RUN_BLOCKED' });
  await assert.rejects(ctx.exec.closeNotExecuted({ runId: blocked.runId, code: '123456', reason: ' ' }, as(ctx.w, 'tester-1')), { reason: 'REASON_REQUIRED' });
  const view = await ctx.exec.closeNotExecuted({ runId: blocked.runId, code: '123456', reason: 'Bench power supply failed' }, as(ctx.w, 'tester-1'));
  assert.equal(view.runs.find(r => r.runId === blocked.runId).state, 'NOT_EXECUTED');
});

test('QA can reject a run with a reason; the tester\'s signature stays and no bug is made', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['FAILED', 'PASSED']);
  const view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  await assert.rejects(ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash, decision: 'REJECT' }, as(ctx.w, 'qa-1')), { reason: 'REASON_REQUIRED' });
  const rejected = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash,
    decision: 'REJECT', reason: 'Wrong harness revision' }, as(ctx.w, 'qa-1'));
  assert.equal(rejected.runs[0].state, 'REJECTED');
  assert.equal(rejected.runs[0].signatures.length, 2);
  assert.equal(ctx.w.created.length, 0);
});

test('a run cannot start when nobody holds a chain role, or when the starter cannot sign step one', async () => {
  const ctx = setup();
  await signedTest(ctx);
  await assert.rejects(ctx.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, as(ctx.w, 'qa-1')), { reason: 'STARTER_NOT_ELIGIBLE' });
  ctx.w.grants = ctx.w.grants.filter(g => g.role !== 'QA');
  await assert.rejects(ctx.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, as(ctx.w, 'tester-1')), { reason: 'NO_ELIGIBLE_SIGNER' });
});

test('evidence must be an attachment on the execution, and its SHA-256 enters the signed digest', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  await assert.rejects(ctx.exec.attachEvidence({ runId: run.runId, expectedRevision: run.revision, stepId: 's1', attachmentId: '999' }, as(ctx.w, 'tester-1')), { reason: 'EVIDENCE_NOT_ON_EXECUTION' });
  const view = await ctx.exec.attachEvidence({ runId: run.runId, expectedRevision: run.revision, stepId: 's1', attachmentId: '700' }, as(ctx.w, 'tester-1'));
  const after = view.runs[0];
  assert.equal(after.steps[0].evidence[0].sha256.length, 64);
  assert.notEqual(after.contentHash, run.contentHash);
});

test('an audit ledger that cannot be written leaves no signature behind', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  ctx.w.ledgerDown = true;
  await assert.rejects(ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1')), { reason: 'LEDGER_UNAVAILABLE' });
  assert.equal(ctx.w.signatures.length, 1, 'only the version signature from setup');
  assert.equal(ctx.w.runs.get(run.runId).state, 'IN_PROGRESS');
});

test('a done execution takes no new runs', async () => {
  const ctx = setup();
  await signedTest(ctx);
  ctx.w.addIssue('14', 'VAT-14', '2', { parent: EPIC, done: true });
  await assert.rejects(ctx.exec.addRun({ issueKey: 'VAT-14', testKey: 'VAT-11' }, as(ctx.w, 'tester-1')), { reason: 'EXECUTION_DONE' });
});

// ── review 2026-10-21: paths that could fail or misstate a governed result ──
test('a test the viewer cannot open shows no steps or preconditions, and they cannot sign or record its run', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  ctx.w.hiddenFromViewer.add('tester-1:11');
  const view = await ctx.exec.view('VAT-12', as(ctx.w, 'tester-1'));
  const hidden = view.runs[0];
  assert.equal(hidden.test.hidden, true);
  assert.deepEqual(hidden.steps, []);
  assert.equal(hidden.preconditions, '');
  assert.equal(hidden.canSign, false);
  assert.ok(!JSON.stringify(view).includes('Power on the ECU'), 'no signed step text reaches the panel');
  await assert.rejects(ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1')), { reason: 'NOT_FOUND' });
  await assert.rejects(ctx.exec.recordStep({ runId: run.runId, expectedRevision: run.revision, stepId: 's1', status: 'FAILED' }, as(ctx.w, 'tester-1')), { reason: 'NOT_FOUND' });
  assert.equal(ctx.w.runs.get(run.runId).state, 'IN_PROGRESS');
});

test('a run with a recorded failure cannot be closed as not executed, so its bug cannot be avoided', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['FAILED']);
  await assert.rejects(ctx.exec.closeNotExecuted({ runId: run.runId, code: '123456', reason: 'Never mind' }, as(ctx.w, 'tester-1')), { reason: 'RUN_HAS_FAILURE' });
  assert.equal(ctx.w.runs.get(run.runId).state, 'IN_PROGRESS');
  assert.equal(ctx.w.signatures.filter(s => s.subject_kind === 'RUN_NOT_EXECUTED').length, 0);
});

test('a bug that fails before its intent row leaves the signed run finishable, not stranded', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'FAILED']);
  let view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  const readAsApp = ctx.w.deps.readIssueAsApp;
  ctx.w.deps.readIssueAsApp = async () => { throw Object.assign(new Error('Jira down'), { reason: 'SERVICE_UNAVAILABLE' }); };
  view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, as(ctx.w, 'qa-1'));
  assert.equal(view.error, undefined, 'the recorded signature is not reported as a failure');
  assert.equal(view.runs[0].state, 'SIGNED');
  assert.equal(view.runs[0].bug, null);
  assert.equal(view.runs[0].canFinish, true, 'the panel offers to create the bug');
  ctx.w.deps.readIssueAsApp = readAsApp;
  view = await ctx.exec.retryBug({ runId: run.runId }, as(ctx.w, 'qa-1'));
  assert.equal(view.runs[0].bug.state, 'CREATED');
  assert.equal(view.runs[0].canFinish, false);
  assert.equal(ctx.w.created.length, 1);
});

test('a run whose last signature is recorded but whose outcome is not is finished from the panel', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  let view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  const setRunState = ctx.w.deps.setRunState;
  ctx.w.deps.setRunState = async () => { throw Object.assign(new Error('SQL down'), { reason: 'SERVICE_UNAVAILABLE' }); };
  view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, as(ctx.w, 'qa-1'));
  assert.equal(view.runs[0].state, 'SIGNING');
  assert.equal(view.runs[0].nextStep, null);
  assert.equal(view.runs[0].canFinish, true);
  ctx.w.deps.setRunState = setRunState;
  view = await ctx.exec.retryBug({ runId: run.runId }, as(ctx.w, 'tester-1'));
  assert.equal(view.runs[0].state, 'SIGNED');
  assert.equal(view.runs[0].canFinish, false);
});

test('a failed run whose test is gone shows Bug needs repair instead of waiting for ever', async () => {
  const ctx = setup();
  await signedTest(ctx);
  const run = await runToSigning(ctx, ['FAILED', 'BLOCKED']);
  let view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  ctx.w.deps.readIssueAsApp = async () => { throw Object.assign(new Error('gone'), { reason: 'NOT_FOUND' }); };
  view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, as(ctx.w, 'qa-1'));
  assert.equal(view.runs[0].bug.state, 'NEEDS_REPAIR');
  assert.equal(view.runs[0].bug.lastError, 'TEST_UNREADABLE');
  assert.equal(view.runs[0].canFinish, false, 'an administrator repairs it');
});

test('a role granted for another work type neither starts a run nor signs one; a grant for the execution type does', async () => {
  const ctx = setup();
  await signedTest(ctx);
  ctx.w.grants = ctx.w.grants.filter(g => g.role !== 'TESTER').concat({ accountId: 'tester-1', role: 'TESTER', issueTypeId: '7' });
  await assert.rejects(ctx.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, as(ctx.w, 'tester-1')), { reason: 'NO_ELIGIBLE_SIGNER' });
  ctx.w.grants.push({ accountId: 'tester-1', role: 'TESTER', issueTypeId: '2' });
  const run = await runToSigning(ctx, ['PASSED', 'PASSED']);
  const view = await ctx.exec.signRun({ runId: run.runId, code: '123456', contentHash: run.contentHash }, as(ctx.w, 'tester-1'));
  assert.equal(view.runs[0].state, 'SIGNING');
});
