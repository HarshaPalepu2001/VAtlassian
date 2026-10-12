import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScopedBaselineTree, resolveBaselineTree, sliceBaselineTree } from '../src/lib/tree/scopedBaseline.js';

const ROOT = 'root';
const CHILD = 'child';
const GRANDCHILD = 'grandchild';
const SIBLING = 'sibling';

function node(logicalNodeId, parentLogicalId, digests, issueId = logicalNodeId) {
  return { logicalNodeId, originalIssueId: issueId, currentIssueId: issueId, parentLogicalId, digests };
}

function tree() {
  return {
    nodes: [
      node(ROOT, null, { summary: 'root-old' }, '1'),
      node(CHILD, ROOT, { summary: 'child-old' }, '2'),
      node(GRANDCHILD, CHILD, { summary: 'grand-old' }, '3'),
      node(SIBLING, ROOT, { summary: 'sibling-old' }, '4')
    ],
    values: {
      [ROOT]: { summary: 'root old' },
      [CHILD]: { summary: 'child old' },
      [GRANDCHILD]: { summary: 'grand old' },
      [SIBLING]: { summary: 'sibling old' }
    }
  };
}

test('sliceBaselineTree keeps the clicked node and every descendant, but not siblings or ancestors', () => {
  const result = sliceBaselineTree(tree(), CHILD);
  assert.deepEqual(result.nodes.map(item => item.logicalNodeId), [CHILD, GRANDCHILD]);
  assert.deepEqual(result.values, {
    [CHILD]: { summary: 'child old' },
    [GRANDCHILD]: { summary: 'grand old' }
  });
  assert.equal(result.nodes[0].parentLogicalId, null, 'the clicked node becomes the scoped root');
  assert.equal(result.nodes[1].parentLogicalId, CHILD);
});

test('effectiveScopedBaselineTree overlays the clicked field baseline on the governed subtree root', () => {
  const governed = tree();
  const ownBaseline = {
    baseline_id: Buffer.from('child-baseline'),
    version: 3,
    field_digests: JSON.stringify({ summary: 'child-approved', priority: 'medium' })
  };
  const result = effectiveScopedBaselineTree({ governedTree: governed, rootLogicalNodeId: CHILD, ownBaseline,
    ownValues: { summary: 'child approved', priority: 'Medium' } });

  assert.deepEqual(result.nodes.map(item => item.logicalNodeId), [CHILD, GRANDCHILD]);
  assert.deepEqual(result.nodes[0].digests, { summary: 'child-approved', priority: 'medium' });
  assert.deepEqual(result.values[CHILD], { summary: 'child approved', priority: 'Medium' });
  assert.deepEqual(result.nodes[1].digests, { summary: 'grand-old' });
  assert.deepEqual(result.values[GRANDCHILD], { summary: 'grand old' });
  assert.deepEqual(governed.nodes[1].digests, { summary: 'child-old' }, 'the governing tree is immutable');
});

test('effectiveScopedBaselineTree refuses a missing governing tree instead of inventing descendant history', () => {
  assert.equal(effectiveScopedBaselineTree({ governedTree: null, rootLogicalNodeId: CHILD,
    ownBaseline: { field_digests: '{}' }, ownValues: {} }), null);
});

test('resolveBaselineTree gives a parent-captured child its scoped governing tree', async () => {
  const governing = { baseline_id: Buffer.from('parent-baseline'), tree_hash: 'tree-hash' };
  const child = {
    baseline_id: Buffer.from('child-baseline'),
    captured_by_baseline_id: governing.baseline_id,
    field_digests: JSON.stringify({ summary: 'child-approved' })
  };
  const result = await resolveBaselineTree({
    baseline: child,
    baselineValues: { summary: 'child approved' },
    rootLogicalNodeId: CHILD,
    baselineById: async id => Buffer.from(id).equals(governing.baseline_id) ? governing : null,
    readBaselineTree: async id => {
      assert.deepEqual(Buffer.from(id), governing.baseline_id, 'never read a tree from the child field baseline');
      return tree();
    }
  });

  assert.equal(result.governingBaseline, governing);
  assert.deepEqual(result.tree.nodes.map(item => item.logicalNodeId), [CHILD, GRANDCHILD]);
  assert.deepEqual(result.tree.nodes[0].digests, { summary: 'child-approved' });
  assert.deepEqual(result.tree.values[CHILD], { summary: 'child approved' });
});
