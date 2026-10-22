import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/testmgmt/requestReads.js').catch(() => ({}));
test('read caching stays inside one request and checks differing frozen plan inputs separately', async () => {
  assert.equal(typeof module.requestReads, 'function');
  let calls = 0;
  const deps = { validateRunPlanningSnapshot: async () => { calls++; return { ok: true }; } };
  const cached = module.requestReads(deps), actor = { viewer: { accountId: 'a' } };
  const run = { projectId: '100', planningSnapshot: { plan: { revisionId: 'plan', digest: 'hash' }, preconditions: [{ text: 'Safe' }] } };
  await cached.validateRunPlanningSnapshot(run, {}, actor);
  await cached.validateRunPlanningSnapshot({ ...run, runId: 'other' }, {}, actor);
  assert.equal(calls, 1);
  await cached.validateRunPlanningSnapshot({ ...run, planningSnapshot: { ...run.planningSnapshot, preconditions: [] } }, {}, actor);
  assert.equal(calls, 2);
  await module.requestReads(deps).validateRunPlanningSnapshot(run, {}, actor);
  assert.equal(calls, 3, 'a later request must recheck current authorization and source state');
});
test('identical issue and source reads share work without sharing authorization across viewers', async () => {
  assert.equal(typeof module.requestReads, 'function');
  let issues = 0, sources = 0;
  const deps = module.requestReads({ readIssueAsUser: async () => { issues++; return {}; },
    resolveTestSources: async () => { sources++; return []; } });
  await Promise.all([deps.readIssueAsUser('11'), deps.readIssueAsUser('11')]);
  await deps.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: { accountId: 'a' } });
  await deps.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: { accountId: 'a' } });
  await deps.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: { accountId: 'b' } });
  assert.equal(issues, 1); assert.equal(sources, 2);
});
