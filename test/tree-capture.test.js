import test from 'node:test';
import assert from 'node:assert/strict';
import { writeCapturedTreeBaseline } from '../src/lib/capture.js';

let calls = [];

function threeNodeFixture() {
  calls = [];
  return {
    rootIssue: { id: 1, key: 'VA-1' },
    approval: { content_hash: 'hash' },
    controlledFields: Array(48).fill({ store_values: true }),
    deps: {
      readStableTree: async () => { calls.push('read-stable-tree'); return { tree: { nodes: [1, 2, 3] } }; },
      planTreeCapture: () => { calls.push('plan-tree-capture'); return { treeHash: 'hash', nodeCount: 3, totalFieldCount: 48 }; },
      writeTreeCapture: async () => { return { baselineId: 'id' }; },
      publishTreeBaseline: async () => { calls.push('publish-active'); return {}; },
      verifyTree: () => { calls.push('verify-tree'); }
    }
  };
}

function fixtureWithUnretainedField() {
  calls = [];
  return {
    rootIssue: { id: 1, key: 'VA-1' },
    approval: { content_hash: 'hash' },
    controlledFields: [{ store_values: false }],
    deps: {
      readStableTree: async () => { calls.push('read-stable-tree'); return { tree: { nodes: [1] } }; },
      planTreeCapture: () => { calls.push('plan-tree-capture'); return { treeHash: 'hash', nodeCount: 1, totalFieldCount: 1 }; },
      writeTreeCapture: async () => { calls.push('write-tree-capture'); return { baselineId: 'id' }; },
      publishTreeBaseline: async () => { calls.push('publish-active'); return {}; },
      verifyTree: () => { calls.push('verify-tree'); }
    }
  };
}

test('capture publishes only after every node and field is durable', async () => {
  const result = await writeCapturedTreeBaseline(threeNodeFixture());
  assert.equal(result.captured, true);
  assert.equal(result.nodeCount, 3);
  assert.equal(result.fieldCount, 48);
  assert.deepEqual(calls.slice(-2), ['verify-tree', 'publish-active']);
});

test('one unretained controlled field refuses the whole baseline', async () => {
  const result = await writeCapturedTreeBaseline(fixtureWithUnretainedField());
  assert.equal(result.reason, 'BASELINE_VALUES_REQUIRED');
  assert.equal(calls.includes('publish-active'), false);
});
