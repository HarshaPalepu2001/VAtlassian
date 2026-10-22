import test from 'node:test';
import assert from 'node:assert/strict';
import { planningWorld } from './helpers/tm-planning-world.js';

const module = await import('../src/usecases/testPlanExecution.js').catch(() => ({}));
const actor = { accountId: 'author' };
async function fixture() {
  const w = planningWorld();
  const { createTestPlanning } = await import('../src/usecases/testPlanning.js');
  const planning = createTestPlanning(w.deps);
  const saved = await planning.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0,
    draft: { members: [{ testIssueId: '11' }], environment: 'Bench', configurations: [{ id: 'a', name: 'A' }], releaseId: '900' } }, actor);
  let model = await planning.publish({ issueKey: 'VAT-21', expectedRevision: saved.draft.revision }, actor);
  model = await planning.sign({ revisionId: model.revisions[0].revisionId, contentHash: model.revisions[0].digest, code: '123456' }, actor);
  const r = model.revisions[0];
  const project = await w.deps.readProject(); project.executionTypeId = '2';
  w.deps.testManagementRole = async issue => ({ role: issue.fields.issuetype.id === '2' ? 'EXECUTION' : 'TEST', project });
  w.issues.set('12', { id: '12', key: 'VAT-12', fields: { project: { id: '100' }, issuetype: { id: '2' }, parent: { id: '10' }, status: { statusCategory: { key: 'new' } } } });
  const calls = [];
  w.deps.listRunsForExecution = async () => [];
  w.deps.addRunFromPlan = async (...args) => { calls.push(args); return { issue: { key: 'VAT-12' } }; };
  assert.equal(typeof module.createTestPlanExecution, 'function', 'plan execution orchestration must exist');
  return { w, calls, uc: module.createTestPlanExecution(w.deps), request: { revisionId: r.revisionId, contentHash: r.digest, executionKey: 'VAT-12', requestId: 'request-1234' } };
}
test('starting a plan passes only server-selected signed scope and stable child request IDs', async () => {
  const c = await fixture();
  const first = await c.uc.start(c.request, actor);
  await c.uc.start(c.request, actor);
  assert.equal(first.complete, true); assert.equal(c.calls.length, 2);
  const [payload, viewer, selection] = c.calls[0];
  assert.equal(payload.testVersionId, 'a'.repeat(32)); assert.equal(payload.releaseId, '900');
  assert.equal(payload.environment, 'Bench'); assert.equal(viewer.accountId, 'author');
  assert.equal(selection.plan.revisionId, c.request.revisionId);
  assert.equal(payload.requestId, c.calls[1][0].requestId);
});
test('a done or differently parented execution receives no plan runs', async () => {
  const c = await fixture(); const target = c.w.issues.get('12');
  target.fields.parent.id = 'other';
  await assert.rejects(c.uc.start(c.request, actor), { reason: 'PLAN_EXECUTION_SCOPE' });
  target.fields.parent.id = '10'; target.fields.status.statusCategory.key = 'done';
  await assert.rejects(c.uc.start(c.request, actor), { reason: 'EXECUTION_DONE' });
  assert.equal(c.calls.length, 0);
});

test('a plan that exceeds the execution bound is refused before any child run is created', async () => {
  const c = await fixture();
  c.w.deps.listRunsForExecution = async () => Array.from({ length: 500 }, () => ({ creationKey: null }));
  await assert.rejects(c.uc.start(c.request, actor), { reason: 'PLAN_SCOPE_TOO_LARGE' });
  assert.equal(c.calls.length, 0);
});
