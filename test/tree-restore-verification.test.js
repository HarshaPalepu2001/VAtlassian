import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/content.js';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';

const controlledFields = [{ field_id: 'summary', field_kind: 'TEXT' }];
const approvedRoot = project({ summary: 'Approved root' }, controlledFields);
const approvedChild = project({ summary: 'Approved child' }, controlledFields);
const baselineTree = {
  nodes: [
    { logicalNodeId: 'root', originalIssueId: 1, currentIssueId: 1, issueKey: 'ROOT-1', parentLogicalId: null, digests: approvedRoot.digests },
    { logicalNodeId: 'child', originalIssueId: 2, currentIssueId: 2, issueKey: 'ROOT-2', parentLogicalId: 'root', digests: approvedChild.digests }
  ],
  values: { root: approvedRoot.raw, child: approvedChild.raw }
};

function liveTree({ childParent = '1', status = '10' } = {}) {
  return {
    nodes: [
      { id: '1', key: 'ROOT-1', fields: { summary: 'Approved root', status: { id: status }, parent: null } },
      { id: '2', key: 'ROOT-2', fields: { summary: 'Approved child', status: { id: '11' }, parent: { id: childParent, key: 'ROOT-1' } } }
    ]
  };
}

test('verification uses the stable-reader contract and checks nodes, edges, fields, and root status', async () => {
  let call;
  const verified = await verifyTreeRestore({
    readStableTree: async args => { call = args; return { tree: liveTree() }; },
    readTree: async () => assert.fail('the verifier should pass this through to readStableTree'),
    rootIssueKey: 'ROOT-1', baselineTree, controlledFields, replacements: [], expectedRootStatusId: '10'
  });
  assert.equal(typeof call, 'object');
  assert.equal(call.rootIssueKey, 'ROOT-1');
  assert.deepEqual(call.fieldIds.sort(), ['parent', 'status', 'summary']);
  assert.equal(verified.matches, true);
  assert.equal(verified.statusMatches, true);
});

test('verification refuses a wrong parent even when every value matches', async () => {
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: liveTree({ childParent: '999' }) }),
    readTree: async () => {}, rootIssueKey: 'ROOT-1', baselineTree, controlledFields,
    replacements: [], expectedRootStatusId: '10'
  });
  assert.equal(verified.matches, false);
});

test('verification refuses a root left outside the baseline review status', async () => {
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: liveTree({ status: '20' }) }),
    readTree: async () => {}, rootIssueKey: 'ROOT-1', baselineTree, controlledFields,
    replacements: [], expectedRootStatusId: '10'
  });
  assert.equal(verified.matches, false);
  assert.equal(verified.statusMatches, false);
});
