import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';

function treeRestoreFixture() {
  return {
    baselineTree: {
      nodes: [
        { logicalNodeId: '1', digests: { summary: 'A' }, parentLogicalId: null },
        { logicalNodeId: '2', digests: { summary: 'B' }, parentLogicalId: '1' },
        { logicalNodeId: '3', digests: { summary: 'C' }, parentLogicalId: '1' },
        { logicalNodeId: '4', digests: { summary: 'D' }, parentLogicalId: '1' }
      ]
    },
    currentTree: {
      nodes: [
        { logicalNodeId: '1', digests: { summary: 'A' }, parentLogicalId: null },
        { logicalNodeId: '2', digests: { summary: 'B' }, parentLogicalId: '4' },
        { logicalNodeId: '4', digests: { summary: 'CHANGED' }, parentLogicalId: '1' },
        { logicalNodeId: '5', digests: { summary: 'E' }, parentLogicalId: '1' }
      ]
    },
    controlledFields: [
      { field_id: 'summary', field_name: 'summary', field_kind: 'TEXT' },
      { field_id: 'parent', field_name: 'parent', field_kind: 'PARENT' }
    ]
  };
}

test('restore plan reverses fields, moves, deletions, and additions in safe order', () => {
  const plan = planTreeRestore(treeRestoreFixture());
  assert.deepEqual(plan.steps.map(step => step.kind), [
    'CREATE_REPLACEMENT', 'MOVE_NODE', 'RESTORE_FIELDS', 'DELETE_ADDED_NODE'
  ]);
});
