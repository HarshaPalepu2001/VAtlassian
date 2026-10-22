import test from 'node:test';
import assert from 'node:assert/strict';
import { retestWorld } from './helpers/tm-retest-world.js';
const module = await import('../src/usecases/testRetest.js').catch(() => ({}));
const actor = { accountId: 'tester' };
const payload = { issueKey: 'VAT-12', requestId: 'f'.repeat(32) };
function service(w) { assert.equal(typeof module.createTestRetest, 'function', 'selective rerun service must exist'); return module.createTestRetest(w.deps); }
test('default selection creates a separate execution and preserves immutable originals and context', async () => {
  const w = retestWorld(), before = structuredClone([...w.runs]);
  const result = await service(w).retest(payload, actor);
  assert.equal(result.complete, true); assert.equal(w.creates.length, 1); assert.equal(w.newRuns.length, 3);
  assert.equal(w.creates[0].fields.parent.id, '10');
  assert.deepEqual([...w.runs], before);
  for (const next of w.newRuns) {
    const original = w.runs.get(next.retestOf);
    assert.equal(next.testVersionId, original.testVersionId); assert.equal(next.environment, original.environment);
    assert.equal(next.configuration, original.configuration); assert.equal(next.releaseId, original.release.id);
    assert.equal(next.selection.required, true); assert.equal(next.selection.retest.sourceExecutionIssueId, '12');
  }
  assert.equal((await service(w).retest(payload, actor)).complete, true);
  assert.equal(w.creates.length, 1); assert.equal(w.newRuns.length, 3);
});
test('permission loss, hidden tests and cross-project tests block before any new Jira issue', async () => {
  for (const mutate of [w => w.denied.add('12:CREATE_ISSUES'), w => w.denied.add('12:EDIT_ISSUES'),
    w => w.hidden.add('21'), w => { w.issues.get('21').fields.project.id = '200'; }]) {
    const w = retestWorld(); mutate(w);
    await assert.rejects(service(w).retest(payload, actor)); assert.equal(w.creates.length, 0);
  }
});
test('unproved terminal labels cannot authorize a retest', async () => {
  const w = retestWorld(); w.signatures = [];
  await assert.rejects(service(w).retest(payload, actor)); assert.equal(w.creates.length, 0);
});
test('a hidden frozen plan or reusable precondition blocks the retest before Jira creation', async () => {
  const w = retestWorld(); w.deps.validateRunPlanningSnapshot = async () => { throw new Error('hidden plan'); };
  await assert.rejects(service(w).retest(payload, actor)); assert.equal(w.creates.length, 0);
});
test('request identity cannot be reused for a different selection', async () => {
  const w = retestWorld(), uc = service(w); await uc.retest(payload, actor);
  await assert.rejects(uc.retest({ ...payload, runIds: ['4'.padStart(32, '0')] }, actor)); assert.equal(w.creates.length, 1);
});
test('lost execution create with lagging search never creates a second execution', async () => {
  const w = retestWorld(), uc = service(w); w.createFailure = 'lost'; w.searchLag = true;
  const first = await uc.retest(payload, actor); assert.equal(first.state, 'CREATING');
  w.advance(10 * 60_000);
  const retry = await uc.retest(payload, actor);
  assert.equal(retry.state, 'NEEDS_REPAIR'); assert.equal(w.creates.length, 1); assert.equal(w.newRuns.length, 0);
});
test('a confirmed lost execution create is recovered without another create', async () => {
  const w = retestWorld(), uc = service(w); w.createFailure = 'lost';
  await uc.retest(payload, actor); w.advance(10 * 60_000);
  const retry = await uc.retest(payload, actor);
  assert.equal(retry.complete, true); assert.equal(w.creates.length, 1); assert.equal(w.newRuns.length, 3);
});
test('partial fan-out resumes with deterministic child request IDs and no duplicate runs', async () => {
  const w = retestWorld(), uc = service(w); const failId = '2'.padStart(32, '0'); w.addFailures.add(failId);
  const first = await uc.retest(payload, actor); assert.equal(first.state, 'ADDING_RUNS'); assert.equal(w.newRuns.length, 1);
  const childRequest = w.newRuns[0].requestId; w.addFailures.clear();
  const retry = await uc.retest(payload, actor); assert.equal(retry.complete, true); assert.equal(w.creates.length, 1);
  assert.equal(w.newRuns.length, 3); assert.equal(w.newRuns[0].requestId, childRequest);
});
test('latest-version choice is frozen in the request and never rewrites the original run', async () => {
  const w = retestWorld(), uc = service(w), original = w.runs.get('1'.padStart(32, '0'));
  const version = structuredClone(w.versions.get(original.testVersionId));
  version.versionId = 'e'.repeat(32); version.versionNo = 2;
  w.versions.set(version.versionId, version);
  w.signatures.push(...w.signatures.filter(s => s.subjectId === original.testVersionId).map(s => ({ ...s, subjectId: version.versionId })));
  const result = await uc.retest({ ...payload, runIds: [original.runId], useLatestVersion: true }, actor);
  assert.equal(result.complete, true); assert.equal(w.newRuns[0].testVersionId, version.versionId);
  assert.notEqual(original.testVersionId, version.versionId);
});
