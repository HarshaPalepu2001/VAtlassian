import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { FIELD_KIND } from '../src/lib/content.js';

function treeRestoreFixture() {
  return {
    baselineTree: {
      nodes: [
        { logicalNodeId: '1', digests: { summary: 'A' }, parentLogicalId: null },
        { logicalNodeId: '2', digests: { summary: 'B' }, parentLogicalId: '1' },
        { logicalNodeId: '3', digests: { summary: 'C' }, parentLogicalId: '1' },
        { logicalNodeId: '4', digests: { summary: 'D' }, parentLogicalId: '1' }
      ],
      values: {
        '1': { summary: 'A' },
        '2': { summary: 'B' },
        '3': { summary: 'C' },
        '4': { summary: 'D' }
      }
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
    'CREATE_REPLACEMENT', 'MOVE_NODE', 'RESTORE_FIELDS', 'RESTORE_FIELDS', 'DELETE_ADDED_NODE'
  ]);
});

test('move and field restore on one node have distinct durable keys', () => {
  const fixture = treeRestoreFixture();
  fixture.currentTree.nodes = fixture.currentTree.nodes.map(node => node.logicalNodeId === '2'
    ? { ...node, digests: { summary: 'CHANGED' } }
    : node);
  const plan = planTreeRestore(fixture);
  const nodeSteps = plan.steps.filter(step => step.logicalNodeId === '2');
  assert.deepEqual(nodeSteps.map(step => step.kind), ['MOVE_NODE', 'RESTORE_FIELDS']);
  assert.equal(new Set(plan.steps.map(step => step.stepKey)).size, plan.steps.length);
  assert.deepEqual(nodeSteps[1].fields, { summary: 'B' });
});

test('missing descendants are recreated parent-first and additions are deleted deepest-first', () => {
  const baselineTree = {
    nodes: [
      { logicalNodeId: 'root', parentLogicalId: null, digests: {} },
      { logicalNodeId: 'parent', parentLogicalId: 'root', digests: {} },
      { logicalNodeId: 'child', parentLogicalId: 'parent', digests: {} }
    ],
    values: { root: {}, parent: {}, child: {} }
  };
  const currentTree = {
    nodes: [
      { logicalNodeId: 'root', parentLogicalId: null, digests: {} },
      { logicalNodeId: 'extra-parent', parentLogicalId: 'root', digests: {} },
      { logicalNodeId: 'extra-child', parentLogicalId: 'extra-parent', digests: {} }
    ]
  };
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields: [] });
  assert.deepEqual(plan.steps.filter(step => step.kind === 'CREATE_REPLACEMENT').map(step => step.logicalNodeId), ['parent', 'child']);
  assert.deepEqual(plan.steps.filter(step => step.kind === 'DELETE_ADDED_NODE').map(step => step.logicalNodeId), ['extra-child', 'extra-parent']);
});

test('a deleted governed root fails closed instead of creating a replacement', () => {
  assert.throws(() => planTreeRestore({
    baselineTree: { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: {} }], values: { root: {} } },
    currentTree: { nodes: [] },
    controlledFields: []
  }), /BASELINE_ROOT_MISSING/);
});

test('issue links get a dedicated restore step instead of being sent as ordinary fields', () => {
  const fields = [
    { field_id: 'summary', field_name: 'summary', field_kind: 'TEXT' },
    { field_id: 'issuelinks', field_name: 'Linked Issues', field_kind: FIELD_KIND.LINKS }
  ];
  const link = { id: '100', type: { id: '10', name: 'Blocks' }, outwardIssue: { id: '20', key: 'T-20' }, inwardIssue: { id: '1', key: 'T-1' } };
  const baselineTree = {
    nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { summary: 'approved', issuelinks: 'approved-link' } }],
    values: { root: { summary: 'approved', issuelinks: [link] } }
  };
  const currentTree = {
    nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { summary: 'changed', issuelinks: 'changed-link' } }]
  };
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields: fields });

  assert.deepEqual(plan.steps.map(step => step.kind), ['RESTORE_FIELDS', 'RESTORE_LINKS']);
  assert.deepEqual(plan.steps[0].fields, { summary: 'approved' });
  assert.deepEqual(plan.steps[1].links, [link]);
});
