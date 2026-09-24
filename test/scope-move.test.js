import test from 'node:test';
import assert from 'node:assert/strict';
import { recordScopeMove } from '../src/lib/scopeMove.js';

const review = { project_id: 10, issue_type_id: '20', baseline_version: 3 };
const deps = (won = true) => {
  const calls = { move: [], audit: [] };
  return { calls, deps: { moveScope: async a => { calls.move.push(a); return won; }, tryAppend: async e => { calls.audit.push(e); } } };
};

test('the same scope is not a move', async () => {
  const d = deps();
  assert.equal(await recordScopeMove({ issueId: 1, review, projectId: 10, issueTypeId: '20', deps: d.deps }), false);
  assert.equal(d.calls.move.length, 0);
});

test('a new project or issue type is recorded, with where it came from and where it went', async () => {
  for (const [projectId, issueTypeId] of [[11, '20'], [10, '21']]) {
    const d = deps();
    assert.equal(await recordScopeMove({ issueId: 1, review, projectId, issueTypeId, actorAccountId: 'u', destinationFieldCount: 4, deps: d.deps }), true);
    assert.equal(d.calls.audit.length, 1);
    assert.deepEqual(d.calls.audit[0].payload, { fromProjectId: 10, fromIssueTypeId: '20', toProjectId: projectId,
      toIssueTypeId: issueTypeId, baselineVersion: 3, destinationTrackedFields: 4 });
    assert.equal(d.calls.audit[0].actorAccountId, 'u');
  }
});

test('only the collector that wins the conditional update writes the audit entry', async () => {
  const d = deps(false);
  assert.equal(await recordScopeMove({ issueId: 1, review, projectId: 11, issueTypeId: '20', deps: d.deps }), true);
  assert.equal(d.calls.audit.length, 0);
});

test('an item with no recorded scope, or a failed update, is never treated as recorded', async () => {
  const d = deps();
  assert.equal(await recordScopeMove({ issueId: 1, review: { project_id: null }, projectId: 11, issueTypeId: '20', deps: d.deps }), false);
  const failing = { moveScope: async () => { throw new Error('db down'); }, tryAppend: async () => { throw new Error('unreachable'); } };
  assert.equal(await recordScopeMove({ issueId: 1, review, projectId: 11, issueTypeId: '20', deps: failing }), true);
});
