import test from 'node:test';
import assert from 'node:assert/strict';
import { tmWorld } from './helpers/tm-world.js';
import { planningWorld } from './helpers/tm-planning-world.js';
import { createTestAuthoring } from '../src/usecases/testAuthoring.js';
import { createTestExecution } from '../src/usecases/testExecution.js';
import { createTestPlanning } from '../src/usecases/testPlanning.js';
import { authorsFor, withEditor } from '../src/testmgmt/authorship.js';
import { runContent, runSteps, contentDigest } from '../src/testmgmt/content.js';

// Independent review (authors never sign) and append-only step results
// (a recorded result is changed only with a reason, and only with its audit event).

const EPIC = { id: '10', key: 'VAT-10' };
const STEPS = [{ id: 's1', action: 'Power on', data: '', expected: 'Boots' }, { id: 's2', action: 'Read VIN', data: '', expected: 'VIN' }];
const as = (w, accountId) => { w.viewer = accountId; return { accountId }; };

function setup() {
  const w = tmWorld();
  w.addIssue('11', 'VAT-11', '1', { parent: EPIC });
  w.addIssue('12', 'VAT-12', '2', { parent: EPIC });
  w.grants.push({ accountId: 'ann', role: 'APPROVER' }, { accountId: 'bob', role: 'APPROVER' }, { accountId: 'cat', role: 'APPROVER' },
    { accountId: 'tester', role: 'TESTER' }, { accountId: 'qa', role: 'QA' });
  return { w, authoring: createTestAuthoring(w.deps), exec: createTestExecution(w.deps) };
}
const sign = (c, v, who) => c.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, as(c.w, who));
async function save(c, who, draft) {
  const current = await c.authoring.view('VAT-11', as(c.w, who));
  return c.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: current.draft.revision, draft: { steps: STEPS, ...draft } }, as(c.w, who));
}
const publish = async (c, who) => (await c.authoring.publish({ issueKey: 'VAT-11', expectedRevision: c.w.drafts.get('11').revision }, as(c.w, who))).versions[0];

test('whoever published a test version cannot sign or reject it, and the panel says why', async () => {
  const c = setup();
  await save(c, 'ann');
  const v = await publish(c, 'ann');
  assert.deepEqual(v.authors, ['ann']);
  assert.equal(v.canSign, false);
  assert.equal(v.signBlocked, 'AUTHOR_CANNOT_SIGN');
  await assert.rejects(sign(c, v, 'ann'), { reason: 'AUTHOR_CANNOT_SIGN' });
  await assert.rejects(c.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest, decision: 'REJECT', reason: 'no' }, as(c.w, 'ann')),
    { reason: 'AUTHOR_CANNOT_SIGN' });
  assert.equal((await sign(c, v, 'bob')).versions[0].state, 'SIGNED');
  assert.deepEqual(c.w.audit.find(e => e.eventType === 'TM_VERSION_PUBLISHED').payload.authors, ['ann']);
});

test('an editor of the draft is an author even when someone else publishes it', async () => {
  const c = setup();
  await save(c, 'ann', { objective: 'Written by ann' });
  const v = await publish(c, 'bob');
  assert.deepEqual(v.authors, ['ann', 'bob']);
  await assert.rejects(sign(c, v, 'ann'), { reason: 'AUTHOR_CANNOT_SIGN' });
  await assert.rejects(sign(c, v, 'bob'), { reason: 'AUTHOR_CANNOT_SIGN' });
  assert.equal((await sign(c, v, 'cat')).versions[0].state, 'SIGNED');
});

test('content never signed keeps its authors when someone else republishes it', async () => {
  const c = setup();
  await save(c, 'ann');
  const v1 = await publish(c, 'ann');
  await c.authoring.signVersion({ versionId: v1.versionId, code: '123456', contentHash: v1.digest, decision: 'REJECT', reason: 'Too vague' }, as(c.w, 'cat'));
  const v2 = await publish(c, 'bob');
  assert.deepEqual(v2.authors, ['ann', 'bob'], 'a republish does not launder who wrote the rejected content');
  await assert.rejects(sign(c, v2, 'ann'), { reason: 'AUTHOR_CANNOT_SIGN' });
});

test('after a signed version, only the people who changed it since are authors of the next', async () => {
  const c = setup();
  await save(c, 'ann');
  await sign(c, await publish(c, 'ann'), 'bob');
  await save(c, 'cat', { objective: 'Tightened by cat' });
  const v2 = await publish(c, 'cat');
  assert.deepEqual(v2.authors, ['cat']);
  assert.equal((await sign(c, v2, 'ann')).versions[0].state, 'SIGNED', 'the first author may review a change written by someone else');
});

test('a version published before authors were recorded still refuses its publisher', async () => {
  const c = setup();
  await save(c, 'ann');
  const v = await publish(c, 'ann');
  c.w.versions.get(v.versionId).authors = null;
  await assert.rejects(sign(c, v, 'ann'), { reason: 'AUTHOR_CANNOT_SIGN' });
});

test('authorsFor reads a legacy draft by its last editor and keeps the list sorted and unique', () => {
  assert.deepEqual(authorsFor({ draft: { editors: null, updatedBy: 'zed', revision: 4 }, history: [], publisher: 'amy' }),
    { accounts: ['amy', 'zed'], draftRevision: 4 });
  assert.deepEqual(withEditor(withEditor([], 'amy', 1), 'amy', 2), [{ accountId: 'amy', revision: 2 }]);
});

test('a plan revision editor or publisher cannot sign it', async () => {
  const w = planningWorld();
  const uc = createTestPlanning(w.deps);
  const saved = await uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueId: '11' }],
    environment: 'Bench', configurations: [{ id: 'a', name: 'A' }], releaseId: '900' } }, { accountId: 'ann' });
  const model = await uc.publish({ issueKey: 'VAT-21', expectedRevision: saved.draft.revision }, { accountId: 'bob' });
  const r = model.revisions[0];
  assert.deepEqual(r.authors, ['ann', 'bob']);
  assert.equal(r.canSign, false);
  for (const who of ['ann', 'bob']) {
    await assert.rejects(uc.sign({ revisionId: r.revisionId, contentHash: r.digest, code: '123456' }, { accountId: who }), { reason: 'AUTHOR_CANNOT_SIGN' });
  }
  const signed = await uc.sign({ revisionId: r.revisionId, contentHash: r.digest, code: '123456' }, { accountId: 'cat' });
  assert.equal(signed.revisions[0].state, 'SIGNED');
});

// ── step results ─────────────────────────────────────────────────────────

async function signedRun() {
  const c = setup();
  await save(c, 'ann');
  await sign(c, await publish(c, 'ann'), 'bob');
  const view = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, as(c.w, 'tester'));
  return { c, run: view.runs[0] };
}
const record = (c, run, args) => c.exec.recordStep({ runId: run.runId, expectedRevision: run.revision, stepId: 's1', ...args }, as(c.w, 'tester'));

test('the first result needs no reason; changing it needs one, and the earlier result is kept', async () => {
  const { c, run } = await signedRun();
  let view = await record(c, run, { status: 'FAILED', actual: 'Motor overheats' });
  let r = view.runs[0];
  await assert.rejects(record(c, r, { status: 'PASSED', actual: 'OK' }), { reason: 'CHANGE_REASON_REQUIRED' });
  await assert.rejects(record(c, r, { status: 'PASSED', actual: 'OK', reason: '   ' }), { reason: 'CHANGE_REASON_REQUIRED' });
  view = await record(c, r, { status: 'PASSED', actual: 'OK', reason: 'Wrong bench wiring; re-run after fixing it' });
  r = view.runs[0];
  const step = r.steps.find(s => s.id === 's1');
  assert.equal(step.status, 'PASSED');
  assert.equal(step.history.length, 1);
  assert.deepEqual({ kind: step.history[0].kind, status: step.history[0].status, actual: step.history[0].actual,
    recordedBy: step.history[0].recordedBy, changedBy: step.history[0].changedBy, reason: step.history[0].reason },
  { kind: 'RESULT', status: 'FAILED', actual: 'Motor overheats', recordedBy: 'tester', changedBy: 'tester', reason: 'Wrong bench wiring; re-run after fixing it' });
  const events = c.w.audit.filter(e => e.eventType === 'TM_STEP_RECORDED');
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.from.actual, 'Motor overheats', 'the audit entry carries the replaced text, not only the status');
  assert.equal(events[1].payload.to.actual, 'OK');
  assert.equal(events[1].payload.reason, 'Wrong bench wiring; re-run after fixing it');
});

test('re-saving an identical result writes nothing and needs no reason', async () => {
  const { c, run } = await signedRun();
  const r = (await record(c, run, { status: 'PASSED', actual: 'OK' })).runs[0];
  const again = (await record(c, r, { status: 'PASSED', actual: 'OK' })).runs[0];
  assert.equal(again.revision, r.revision);
  assert.equal(c.w.audit.filter(e => e.eventType === 'TM_STEP_RECORDED').length, 1);
});

test('the signed run content includes the correction, and an uncorrected run keeps its old digest shape', async () => {
  const { c, run } = await signedRun();
  let r = (await record(c, run, { status: 'FAILED', actual: 'x' })).runs[0];
  const before = r.contentHash;
  r = (await record(c, r, { status: 'PASSED', actual: 'y', reason: 'Misread the display' })).runs[0];
  const stored = c.w.runs.get(r.runId);
  const version = c.w.versions.get(stored.testVersionId);
  const steps = runSteps(version.content.steps, stored.steps);
  const content = runContent(stored, steps, r.result);
  assert.equal(content.steps[0].history[0].reason, 'Misread the display');
  assert.equal(content.steps[0].history[0].changedAt, undefined, 'timestamps stay out of what is signed');
  assert.equal(contentDigest(content), r.contentHash);
  assert.notEqual(before, r.contentHash);
  assert.equal('history' in runContent(stored, runSteps(version.content.steps, []), 'NOT_RUN').steps[0], false);
});

test('a result change whose audit entry cannot be written does not take effect', async () => {
  const { c, run } = await signedRun();
  const r = (await record(c, run, { status: 'FAILED', actual: 'Overheats' })).runs[0];
  c.w.ledgerDown = true;
  await assert.rejects(record(c, r, { status: 'PASSED', actual: 'OK', reason: 'Changed my mind' }), { reason: 'LEDGER_UNAVAILABLE' });
  c.w.ledgerDown = false;
  const stored = c.w.runs.get(r.runId);
  assert.equal(stored.stepEventId, null);
  const step = runSteps(STEPS, stored.steps).find(s => s.id === 's1');
  assert.equal(step.status, 'FAILED');
  assert.equal(step.actual, 'Overheats');
  assert.equal(step.history, undefined);
});

test('evidence removal needs a reason and is kept in the step history', async () => {
  const { c, run } = await signedRun();
  c.w.issues.get('12').fields.attachment = [{ id: '700', filename: 'trace.log', size: 10 }];
  let r = (await c.exec.attachEvidence({ runId: run.runId, expectedRevision: run.revision, stepId: 's1', attachmentId: '700' }, as(c.w, 'tester'))).runs[0];
  const args = { runId: r.runId, expectedRevision: r.revision, stepId: 's1', attachmentId: '700' };
  await assert.rejects(c.exec.removeEvidence(args, as(c.w, 'tester')), { reason: 'CHANGE_REASON_REQUIRED' });
  r = (await c.exec.removeEvidence({ ...args, reason: 'Wrong file attached' }, as(c.w, 'tester'))).runs[0];
  const step = r.steps.find(s => s.id === 's1');
  assert.equal(step.evidence.length, 0);
  assert.equal(step.history[0].kind, 'EVIDENCE_REMOVED');
  assert.equal(step.history[0].evidence.attachmentId, '700');
  assert.equal(c.w.audit.at(-1).payload.evidenceRemoved.sha256, step.history[0].evidence.sha256);
});

test('an interrupted change blocks sign-off until the audit chain decides it, then signs what was shown', async () => {
  const { c, run } = await signedRun();
  let r = (await record(c, run, { status: 'PASSED', actual: 'OK' })).runs[0];
  r = (await c.exec.recordStep({ runId: r.runId, expectedRevision: r.revision, stepId: 's2', status: 'PASSED', actual: 'VIN' }, as(c.w, 'tester'))).runs[0];
  // The change is written, its audit event lands, and the confirmation is lost.
  const confirm = c.w.deps.confirmRunSteps;
  c.w.deps.confirmRunSteps = async () => { throw new Error('lost'); };
  r = (await record(c, r, { status: 'PASSED', actual: 'OK, 1.9 s', reason: 'Added the boot time' })).runs[0];
  c.w.deps.confirmRunSteps = confirm;
  assert.equal(r.resultPending, true);
  assert.equal(r.canSign, false);
  const frozen = await c.w.deps.setRunState({ runId: r.runId, from: 'IN_PROGRESS', to: 'SIGNING', expectedRevision: r.revision, frozenDigest: r.contentHash });
  assert.equal(frozen, false, 'a pending change can never be frozen for sign-off');
  // Signing confirms the change from its audit event, then signs exactly what the tester saw.
  const signed = (await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, as(c.w, 'tester'))).runs[0];
  assert.equal(signed.state, 'SIGNING');
  assert.equal(signed.steps[0].actual, 'OK, 1.9 s');
  assert.equal(c.w.runs.get(r.runId).stepEventId, null);
});

test('an abandoned change with no audit event is rolled back after the invocation budget', async () => {
  const { c, run } = await signedRun();
  const r = (await record(c, run, { status: 'FAILED', actual: 'Overheats' })).runs[0];
  // A writer that died between the row and its audit event.
  const stored = c.w.runs.get(r.runId);
  const prior = { steps: structuredClone(stored.steps), result: stored.result };
  await c.w.deps.updateRunSteps({ runId: r.runId, expectedRevision: stored.revision, steps: [], result: 'NOT_RUN', now: c.w.deps.now(), eventId: 'f'.repeat(32), prior });
  await assert.rejects(record(c, { ...r, revision: stored.revision }, { status: 'PASSED', reason: 'x' }), { reason: 'RESULT_PENDING' });
  c.w.advance(6 * 60_000);
  assert.equal(await c.w.deps.settleRunSteps(r.runId, { now: c.w.deps.now() }), true);
  const after = c.w.runs.get(r.runId);
  assert.equal(after.stepEventId, null);
  assert.equal(runSteps(STEPS, after.steps)[0].actual, 'Overheats');
});
