import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldsForItem, scopeForItem, fieldScope } from '../src/lib/tree/nodeFields.js';

// A work item's tracked fields are the fields of the approval that governs it.
// A child covered by a parent's approved tree is held to the PARENT's
// Controlled Fields on every single-item path, including drift, the panel, a decision,
// and a restore, as well as while reading the parent's tree. Otherwise the
// child's own baseline (captured with the parent's fields) would be measured
// over its own issue type's fields, and anything only the parent tracks, like
// an attachment on a Task, would never register.

const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true });
const epicFields = [F('summary'), F('attachment'), F('priority')];
const taskFields = [F('summary')];
const byScope = ({ projectId, issueTypeId }) => {
  if (Number(projectId) === 11851 && issueTypeId === '10000') return epicFields;
  if (Number(projectId) === 11851 && issueTypeId === '10004') return taskFields;
  return [];
};
const deps = (roots) => ({
  activeRootsForNode: async () => roots,
  controlledFields: async (scope) => byScope(scope)
});
const task = { issueId: 43929, projectId: 11851, issueTypeId: '10004' };

test('a child in an approved tree tracks its root\'s fields', async () => {
  const fields = await fieldsForItem(task, deps([
    { rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 1 }
  ]));
  assert.deepEqual(fields.map(f => f.field_id), ['summary', 'attachment', 'priority']);
});

test('an item in no approved tree tracks its own issue type\'s fields', async () => {
  assert.deepEqual(await fieldsForItem(task, deps([])), taskFields);
});

test('a root with no other tree above it tracks its own fields', async () => {
  const epic = { issueId: 43925, projectId: 11851, issueTypeId: '10000' };
  const fields = await fieldsForItem(epic, deps([
    { rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 1 }
  ]));
  assert.deepEqual(fields, epicFields);
});

// ─── The scope an item resolves to, as the validator and the logs read it ───
// These pin the three cases that were already right, so a change to the
// "covered child that is also its own root" case cannot move them.

test('scope: an item in no approved tree is its own, with no governing root', async () => {
  assert.deepEqual(await scopeForItem(task, deps([])),
    { projectId: 11851, issueTypeId: '10004', source: 'own', rootIssueId: null });
});

test('scope: a root with no other tree above it is its own, naming itself', async () => {
  const epic = { issueId: 43925, projectId: 11851, issueTypeId: '10000' };
  assert.deepEqual(await scopeForItem(epic, deps([{ rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 1 }])),
    { projectId: 11851, issueTypeId: '10000', source: 'own', rootIssueId: 43925 });
});

test('scope: a covered child is governed by its root, naming the baseline and version', async () => {
  const baselineId = Buffer.alloc(16, 7);
  const found = await scopeForItem(task, deps([
    { rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 1, baselineId, version: 3 }
  ]));
  assert.deepEqual(found, { projectId: 11851, issueTypeId: '10000', source: 'governing-root',
    rootIssueId: 43925, rootBaselineId: baselineId, rootVersion: 3 });
});

// ─── A covered child that has since been captured on its own ────────────────
//
// Found live 2026-10-12 (VAT-59, VAT-68, VAT-69). A child signs under its
// root's fields; the capture that signature triggers makes the child the root of
// its own baseline too. Resolving it to its own issue type from then on gave the
// validator a different field set than the one just signed, so the first
// approval of every covered child was refused as "changed after approval".
// A child covered by another root stays governed by that root's fields.

test('a covered child that is also its own root is still governed by the covering root', async () => {
  const fields = await fieldsForItem(task, deps([
    { rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 1 },
    { rootIssueId: 43929, projectId: 11851, issueTypeId: '10004', capturedAt: 2 }
  ]));
  assert.deepEqual(fields, epicFields);
});

test('the same child resolves to the same scope before and after its own capture', async () => {
  const covering = { rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 1 };
  const own = { rootIssueId: 43929, projectId: 11851, issueTypeId: '10004', capturedAt: 2 };
  const before = await scopeForItem(task, deps([covering]));
  const after = await scopeForItem(task, deps([covering, own]));
  assert.deepEqual(after, before);
  const recorded = await fieldScope(task, { ...deps([covering, own]) });
  assert.equal(recorded.ruleScope.source, 'INHERITED', 'a child held to its root\'s fields records them as inherited');
});

test('a root whose covering root has no recorded scope still falls back to its own fields', async () => {
  const fields = await fieldsForItem(task, deps([
    { rootIssueId: 43925, capturedAt: 1 },
    { rootIssueId: 43929, projectId: 11851, issueTypeId: '10004', capturedAt: 2 }
  ]));
  assert.deepEqual(fields, taskFields);
});

test('under two roots, the most recent approval governs', async () => {
  const fields = await fieldsForItem(task, deps([
    { rootIssueId: 7, projectId: 11851, issueTypeId: '10004', capturedAt: 1 },
    { rootIssueId: 43925, projectId: 11851, issueTypeId: '10000', capturedAt: 5 }
  ]));
  assert.deepEqual(fields, epicFields);
});

test('a root row from before the scope columns existed falls back to the item\'s own fields', async () => {
  assert.deepEqual(await fieldsForItem(task, deps([{ rootIssueId: 43925, capturedAt: 1 }])), taskFields);
});
