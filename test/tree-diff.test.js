import test from 'node:test';
import assert from 'node:assert';
import { diffTree } from '../src/lib/tree/diff.js';

function treeDiffFixture() {
  return {
    baselineTree: {
      nodes: [
        { logicalNodeId: 'node1', digests: { f1: 'hashA' }, parentLogicalId: null },
        { logicalNodeId: 'node2', digests: { f1: 'hashB' }, parentLogicalId: 'node1' },
        { logicalNodeId: 'node3', digests: { f1: 'hashC' }, parentLogicalId: 'node1' }
      ]
    },
    currentTree: {
      nodes: [
        { logicalNodeId: 'node1', digests: { f1: 'hashA_changed' }, parentLogicalId: null },
        { logicalNodeId: 'node2', digests: { f1: 'hashB' }, parentLogicalId: 'node3' },
        { logicalNodeId: 'node4', digests: { f1: 'hashD' }, parentLogicalId: 'node1' }
      ]
    },
    controlledFields: [{ field_id: 'f1', field_kind: 'TEXT' }]
  };
}

test('tree diff separates every drift category', () => {
  assert.deepEqual(diffTree(treeDiffFixture()).changes.map(change => change.kind).sort(),
    ['FIELD_CHANGED', 'NODE_ADDED', 'NODE_MOVED', 'NODE_REMOVED']);
});
