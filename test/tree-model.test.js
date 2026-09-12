import test from 'node:test';
import assert from 'node:assert';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';

function threeLevelTree() {
  const fields = {};
  for (let i = 0; i < 16; i++) fields[`f${i}`] = 'v';
  return [
    { id: 1, fields },
    { id: 2, fields: { ...fields, parent: { id: 1 } } },
    { id: 3, fields: { ...fields, parent: { id: 2 } } }
  ];
}

function sixteenFields() {
  return Array.from({ length: 16 }, (_, i) => ({ field_id: `f${i}`, field_kind: 'TEXT', store_values: true }));
}

test('capture plan covers all 16 fields on every recursive node', () => {
  const plan = planTreeCapture({
    rootIssueId: 1, nodes: threeLevelTree(), controlledFields: sixteenFields()
  });
  assert.equal(plan.nodeCount, 3);
  assert.equal(plan.edgeCount, 2);
  assert.equal(plan.totalFieldCount, 48);
  assert.equal(plan.nodes.every(node => Object.keys(node.digests).length === 16), true);
});

test('rejects duplicate nodes', () => {
  assert.throws(() => planTreeCapture({
    rootIssueId: 1,
    nodes: [
      { id: 1, fields: { f0: 'v' } },
      { id: 1, fields: { f0: 'v' } }
    ],
    controlledFields: [{ field_id: 'f0', field_kind: 'TEXT', store_values: true }]
  }), e => e.reason === 'DUPLICATE_NODE');
});

test('rejects cycles', () => {
  assert.throws(() => planTreeCapture({
    rootIssueId: 1,
    nodes: [
      { id: 1, fields: { f0: 'v', parent: { id: 2 } } },
      { id: 2, fields: { f0: 'v', parent: { id: 1 } } }
    ],
    controlledFields: [{ field_id: 'f0', field_kind: 'TEXT', store_values: true }]
  }), e => e.reason === 'CYCLE_DETECTED');
});

test('rejects missing parents inside subtree', () => {
  assert.throws(() => planTreeCapture({
    rootIssueId: 1,
    nodes: [
      { id: 1, fields: { f0: 'v', parent: { id: 999 } } }
    ],
    controlledFields: [{ field_id: 'f0', field_kind: 'TEXT', store_values: true }]
  }), e => e.reason === 'MISSING_PARENT');
});

test('rejects incomplete field sets', () => {
  assert.throws(() => planTreeCapture({
    rootIssueId: 1,
    nodes: [
      { id: 1, fields: { f0: 'v' } }
    ],
    controlledFields: [
      { field_id: 'f0', field_kind: 'TEXT', store_values: true },
      { field_id: 'f1', field_kind: 'TEXT', store_values: false }
    ]
  }), e => e.reason === 'BASELINE_VALUES_REQUIRED');
});
