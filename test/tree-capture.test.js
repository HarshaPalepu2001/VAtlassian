import test from 'node:test';
import assert from 'node:assert/strict';
import { writeCapturedTreeBaseline } from '../src/lib/capture.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';

let calls = [];

function threeNodeFixture() {
  calls = [];
  return {
    rootIssue: { id: 1, key: 'VA-1', fields: { summary: 'Root' } },
    policy: {
      transition_id: '31', from_status_id: 'review', to_status_id: 'approved',
      required_role: 'Quality Reviewer', required_assurance: 'ESIGNATURE'
    },
    approval: { approvalId: 'approval', accountId: 'user', displayName: 'Reviewer', assuranceLevel: 'ESIGNATURE', content_hash: 'hash' },
    controlledFields: Array(48).fill({ store_values: true }),
    deps: {
      readStableTree: async () => { calls.push('read-stable-tree'); return { tree: { nodes: [1, 2, 3] } }; },
      planTreeCapture: () => { calls.push('plan-tree-capture'); return {
        treeHash: 'hash', nodeCount: 3, edgeCount: 2, totalFieldCount: 48,
        nodes: [{ logicalNodeId: 'root', originalIssueId: 1, projectId: 100, issueTypeId: '200' }],
        values: { root: {} }
      }; },
      baselineForApproval: async () => null,
      currentVersion: async () => 0,
      beginTreeBaseline: async () => ({ baselineId: 'id', version: 1 }),
      writeTreeCapture: async () => { calls.push('write-tree'); return { baselineId: 'id', valueBytes: 0 }; },
      verifyTreeCapture: async () => { calls.push('verify-tree'); },
      publishTreeBaseline: async () => { calls.push('publish-active'); return {}; },
      upsertBaselined: async () => {},
      tryAppend: async () => {}
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
  assert.deepEqual(calls.filter(call => ['write-tree', 'verify-tree', 'publish-active'].includes(call)),
    ['write-tree', 'verify-tree', 'publish-active']);
});

test('one unretained controlled field refuses the whole baseline', async () => {
  const result = await writeCapturedTreeBaseline(fixtureWithUnretainedField());
  assert.equal(result.reason, 'BASELINE_VALUES_REQUIRED');
  assert.equal(calls.includes('publish-active'), false);
});

test('tree capture refuses an empty controlled-field scope before reading Jira', async () => {
  const result = await writeCapturedTreeBaseline({
    rootIssue: { id: '1', key: 'VA-1' },
    policy: {},
    approval: {
      approvalId: Buffer.alloc(16, 1), accountId: 'user-1', displayName: 'Reviewer',
      assuranceLevel: 'ESIGNATURE', content_hash: 'hash'
    },
    controlledFields: [],
    transitionAt: 1700000000000,
    deps: { readStableTree: async () => assert.fail('empty scope must not read Jira') }
  });

  assert.deepEqual(result, { captured: false, reason: 'NO_TRACKED_FIELDS' });
});

test('tree capture refuses incomplete signed approval identity before persistence', async () => {
  const result = await writeCapturedTreeBaseline({
    rootIssue: { id: '1', key: 'VA-1' },
    policy: {},
    approval: { approvalId: Buffer.alloc(16, 1), accountId: 'user-1', content_hash: 'hash' },
    controlledFields: [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }],
    transitionAt: 1700000000000,
    deps: { baselineForApproval: async () => assert.fail('invalid approval must not query persistence') }
  });

  assert.deepEqual(result, { captured: false, reason: 'NO_APPROVAL' });
});

function storageContractFixture() {
  return {
    rootIssueId: '1',
    nodes: [{
      id: '1',
      key: 'VA-1',
      fields: {
        summary: 'Signed root',
        project: { id: '100' },
        issuetype: { id: '200' },
        status: { id: '300' },
        parent: null
      }
    }],
    controlledFields: [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }]
  };
}

test('capture plan separates durable node metadata from retained values', () => {
  const input = storageContractFixture();
  const before = structuredClone(input);
  const plan = planTreeCapture(input);

  assert.deepEqual(Object.keys(plan.nodes[0]).sort(), [
    'contentHash', 'currentIssueId', 'fieldDigests', 'issueKey',
    'issueTypeId', 'logicalNodeId', 'nodeOrder', 'originalIssueId',
    'parentLogicalNodeId', 'projectId'
  ]);
  assert.equal(plan.values[plan.nodes[0].logicalNodeId].summary, 'Signed root');
  assert.deepEqual(input, before);
});

function publicationFixture() {
  calls = [];
  const writeState = { args: null };
  const rootIssue = {
    id: '1',
    key: 'VA-1',
    fields: {
      summary: 'Signed root',
      project: { id: '100' },
      issuetype: { id: '200' },
      status: { id: '300' },
      parent: null
    }
  };
  const approval = {
    approvalId: 'approval-1',
    accountId: 'user-1',
    displayName: 'Reviewer',
    assuranceLevel: 'ESIGNATURE',
    content_hash: 'tree-hash'
  };
  const nodes = [{
    logicalNodeId: 'node-1', originalIssueId: 1, currentIssueId: 1,
    issueKey: 'VA-1', parentLogicalNodeId: null, projectId: 100,
    issueTypeId: '200', contentHash: 'content-hash', fieldDigests: '{}', nodeOrder: 0
  }];
  const values = { 'node-1': { summary: 'Signed root' } };
  return {
    writeState,
    rootIssue,
    approval,
    policy: {
      transition_id: '5', from_status_id: '1', to_status_id: '2',
      required_role: 'Quality Reviewer', required_assurance: 'ESIGNATURE'
    },
    controlledFields: [{
      field_id: 'summary', field_kind: 'TEXT', schema_type: 'string',
      materiality: 'MAJOR', store_values: true, writable: true
    }],
    transitionAt: 1700000000000,
    deps: {
      readStableTree: async ({ fieldIds }) => {
        assert.deepEqual(fieldIds.sort(), ['issuetype', 'parent', 'project', 'status', 'summary']);
        return { tree: { nodes: [rootIssue] } };
      },
      planTreeCapture: () => ({
        treeHash: 'tree-hash', nodeCount: 1, edgeCount: 0, totalFieldCount: 1, nodes, values
      }),
      baselineForApproval: async () => { calls.push('find-existing'); return null; },
      currentVersion: async () => { calls.push('next-version'); return 0; },
      beginTreeBaseline: async ({ baseline }) => {
        calls.push('begin');
        assert.equal(baseline.version, 1);
        assert.equal(baseline.project_id, 100);
        assert.equal(baseline.issue_type_id, '200');
        assert.equal(baseline.state, 'CAPTURING');
        assert.equal(baseline.required_role, 'Quality Reviewer');
        assert.equal(baseline.required_assurance, 'ESIGNATURE');
        assert.equal(
          baseline.controlled_fields_hash,
          'fd72aecbb8f6bb81b736aef9a8487475cbd738237f347353fbc93b37c8599e5f'
        );
        return { baselineId: 'baseline-1', version: 1 };
      },
      writeTreeCapture: async args => {
        calls.push('write-tree');
        writeState.args = args;
        return { baselineId: args.baselineId, valueBytes: 11 };
      },
      verifyTreeCapture: async () => { calls.push('verify-durable'); return true; },
      publishTreeBaseline: async () => { calls.push('publish'); return true; },
      upsertBaselined: async () => { calls.push('item-state'); },
      tryAppend: async () => { calls.push('ledger'); }
    }
  };
}

test('tree capture reserves a baseline id, writes all nodes, then publishes', async () => {
  const fixture = publicationFixture();
  const result = await writeCapturedTreeBaseline(fixture);

  assert.deepEqual(calls, [
    'find-existing', 'next-version', 'begin', 'write-tree', 'verify-durable',
    'publish', 'item-state', 'ledger'
  ]);
  assert.equal(result.baselineId, 'baseline-1');
  assert.equal(result.version, 1);
});

test('approval id is never used as a baseline id', async () => {
  const fixture = publicationFixture();
  await writeCapturedTreeBaseline(fixture);

  assert.equal(fixture.writeState.args.baselineId, 'baseline-1');
  assert.notEqual(fixture.writeState.args.baselineId, fixture.approval.approvalId);
});

test('tree capture refuses incomplete baseline-owned policy before reading Jira', async () => {
  const result = await writeCapturedTreeBaseline({
    rootIssue: { id: '1', key: 'VA-1' },
    policy: { transition_id: '5', from_status_id: '1', to_status_id: '2' },
    approval: {
      approvalId: Buffer.alloc(16, 1), accountId: 'user-1', displayName: 'Reviewer',
      assuranceLevel: 'ESIGNATURE', content_hash: 'hash'
    },
    controlledFields: [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }],
    transitionAt: 1700000000000,
    deps: {
      baselineForApproval: async () => null,
      readStableTree: async () => assert.fail('incomplete policy must not read Jira')
    }
  });

  assert.deepEqual(result, { captured: false, reason: 'BASELINE_POLICY_INCOMPLETE' });
});

test('a completed capture is idempotent without rereading changed Jira content', async () => {
  const baselineId = Buffer.alloc(16, 9);
  const result = await writeCapturedTreeBaseline({
    rootIssue: { id: '1', key: 'VA-1', fields: { summary: 'changed later' } },
    policy: { transition_id: '5', from_status_id: '1', to_status_id: '2' },
    approval: {
      approvalId: Buffer.alloc(16, 7), accountId: 'user-1', displayName: 'Reviewer',
      assuranceLevel: 'ESIGNATURE', content_hash: 'signed-tree-hash'
    },
    controlledFields: [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }],
    transitionAt: 1700000000000,
    deps: {
      baselineForApproval: async () => ({
        baseline_id: baselineId, state: 'ACTIVE', version: 2,
        content_hash: 'signed-tree-hash', tree_hash: 'signed-tree-hash',
        node_count: 1, total_field_count: 1
      }),
      readStableTree: async () => assert.fail('completed capture must not reread Jira')
    }
  });

  assert.equal(result.captured, true);
  assert.equal(result.alreadyCaptured, true);
  assert.deepEqual(result.baselineId, baselineId);
  assert.equal(result.version, 2);
});

test('a completed capture cannot be borrowed by mismatched signed evidence', async () => {
  const result = await writeCapturedTreeBaseline({
    rootIssue: { id: '1', key: 'VA-1', fields: { summary: 'current' } },
    policy: {},
    approval: {
      approvalId: Buffer.alloc(16, 7), accountId: 'user-1', displayName: 'Reviewer',
      assuranceLevel: 'ESIGNATURE', content_hash: 'different-signed-hash'
    },
    controlledFields: [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }],
    transitionAt: 1700000000000,
    deps: {
      baselineForApproval: async () => ({
        baseline_id: Buffer.alloc(16, 9), state: 'ACTIVE', version: 2,
        content_hash: 'stored-tree-hash', tree_hash: 'stored-tree-hash',
        node_count: 1, total_field_count: 1
      }),
      readStableTree: async () => assert.fail('mismatched completed capture must fail before Jira')
    }
  });

  assert.deepEqual(result, { captured: false, reason: 'CAPTURE_INCOMPLETE' });
});
