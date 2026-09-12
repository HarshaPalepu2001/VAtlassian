import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'test:forge-api', shortCircuit: true };
    if (specifier.endsWith('/db/restoreTreeStore.js')) return { url: 'test:restore-tree-store', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:forge-api') return { format: 'module', shortCircuit: true, source: 'export default { requestJira: globalThis.mockRequestJira };' };
    if (url === 'test:restore-tree-store') return { format: 'module', shortCircuit: true,
      source: 'export async function claimRestoreStep(rId, step) { return globalThis.mockClaim(rId, step); } export async function finishRestoreStep(rId, step, ok, d) { return globalThis.mockFinish(rId, step, ok, d); } export async function recordReplacement(r, o, n) { return globalThis.mockReplace(r, o, n); }' };
    return next(url, context);
  }
});

globalThis.mockClaim = async () => {};
globalThis.mockFinish = async () => {};
globalThis.mockReplace = async () => {};
const { executeTreeRestore } = await import('../src/lib/tree/restoreExecutor.js');
hooks.deregister();

let _fixtureCalls = { deleteCalls: [], mutationCalls: [] };
globalThis._fixtureCalls = _fixtureCalls;
function fixture() { return _fixtureCalls; }

function fixtureThatFailsAfterDelete() {
  _fixtureCalls.deleteCalls = [];
  _fixtureCalls.mutationCalls = [];
  return {
    restoreId: 1, rootIssueKey: 'ROOT-1',
    baselineTree: { nodes: [] }, currentTree: { nodes: [{ logicalNodeId: 'added', digests: {}, parentLogicalId: 'root' }] }, controlledFields: []
  };
}
function fixtureThatRetriesSameRestore() {
  return {
    restoreId: 1, rootIssueKey: 'ROOT-1',
    baselineTree: { nodes: [] }, currentTree: { nodes: [{ logicalNodeId: 'added', digests: {}, parentLogicalId: 'root' }] }, controlledFields: []
  };
}
function deletedBaselineNodeFixture() {
  _fixtureCalls.deleteCalls = [];
  _fixtureCalls.mutationCalls = [];
  return {
    restoreId: 2, rootIssueKey: 'ROOT-1',
    baselineTree: { nodes: [{ logicalNodeId: 'story-logical', digests: {}, parentLogicalId: 'root' }] }, currentTree: { nodes: [] }, controlledFields: []
  };
}
function fixtureWithoutDeletePermission() {
  _fixtureCalls.deleteCalls = [];
  _fixtureCalls.mutationCalls = [];
  return {
    restoreId: 3, rootIssueKey: 'ROOT-1',
    baselineTree: { nodes: [] }, currentTree: { nodes: [{ logicalNodeId: 'added', digests: {}, parentLogicalId: 'root' }] }, controlledFields: []
  };
}

test('an added descendant is deleted exactly once across retry', async () => {
  const first = await executeTreeRestore(fixtureThatFailsAfterDelete());
  assert.equal(first.state, 'PARTIAL');
  const second = await executeTreeRestore(fixtureThatRetriesSameRestore());
  assert.equal(fixture().deleteCalls.length, 1);
  assert.equal(second.state, 'COMPLETE');
});

test('a deleted baseline node is recreated and mapped to its logical identity', async () => {
  const result = await executeTreeRestore(deletedBaselineNodeFixture());
  assert.equal(result.state, 'COMPLETE_WITH_REPLACEMENTS');
  assert.deepEqual(result.replacements, [{ logicalNodeId: 'story-logical', issueKey: 'FEAT-22' }]);
});

test('preflight refuses a structural restore before the first Jira mutation', async () => {
  const result = await executeTreeRestore(fixtureWithoutDeletePermission());
  assert.equal(result.state, 'FAILED');
  assert.equal(fixture().mutationCalls.length, 0);
});
