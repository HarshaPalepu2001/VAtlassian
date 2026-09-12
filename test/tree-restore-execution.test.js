import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';

function createMockAdapters(initialState = {}) {
  const state = {
    steps: initialState.steps || [],
    replacements: initialState.replacements || [],
    mutations: {
      create: [], edit: [], move: [], delete: []
    },
    failOnDeleteOnce: initialState.failOnDeleteOnce || false,
    preflightFail: initialState.preflightFail || false,
    ledger: []
  };

  const adapters = {
    checkPermissions: async (plan) => !state.preflightFail,
    readRestoreSteps: async (restoreId) => state.steps,
    claimRestoreStep: async (restoreId, logicalNodeId, issueId) => {
      if (state.steps.some(s => s.logicalNodeId === logicalNodeId)) {
        throw new Error('Duplicate claim');
      }
      state.steps.push({ logicalNodeId, issueId, success: false, finished: false, detail: null });
    },
    finishRestoreStep: async (restoreId, logicalNodeId, success, detail) => {
      const step = state.steps.find(s => s.logicalNodeId === logicalNodeId);
      if (step) {
        step.success = success;
        step.finished = true;
        step.detail = detail;
      }
    },
    recordReplacement: async (restoreId, logicalNodeId, oldIssueId, newIssueId) => {
      state.replacements.push({ logicalNodeId, oldIssueId, newIssueId });
    },
    readReplacements: async (restoreId) => state.replacements,
    createIssue: async (parentKey, node) => {
      state.mutations.create.push({ parentKey, node });
      return { newIssueId: 'new-' + node.logicalNodeId, newIssueKey: 'NEW-' + node.logicalNodeId };
    },
    editIssue: async (issueId, fields) => {
      state.mutations.edit.push({ issueId, fields });
      return true;
    },
    moveIssue: async (issueId, parentKey) => {
      state.mutations.move.push({ issueId, parentKey });
      return true;
    },
    deleteIssue: async (issueId) => {
      if (state.failOnDeleteOnce) {
        state.failOnDeleteOnce = false;
        throw new Error('Mock network failure');
      }
      state.mutations.delete.push(issueId);
      return true;
    },
    appendLedger: async (eventType, payload) => {
      state.ledger.push({ eventType, payload });
    }
  };
  return { adapters, state };
}

test('an added descendant is deleted exactly once across retry', async () => {
  const baselineTree = { nodes: [] };
  const currentTree = { nodes: [{ logicalNodeId: 'added', digests: {}, parentLogicalId: 'root' }] };

  const { adapters, state } = createMockAdapters({ failOnDeleteOnce: true });

  const first = await executeTreeRestore({
    restoreId: 1, rootIssueKey: 'ROOT-1', baselineTree, currentTree, controlledFields: [], adapters
  });

  assert.equal(first.state, 'PARTIAL');
  assert.equal(state.mutations.delete.length, 0); // threw before recording
  assert.equal(state.steps[0].success, false); // claimed but failed

  // Retry same plan
  const second = await executeTreeRestore({
    restoreId: 1, rootIssueKey: 'ROOT-1', baselineTree, currentTree, controlledFields: [], adapters
  });

  assert.equal(second.state, 'COMPLETE');
  assert.equal(state.mutations.delete.length, 1);
  assert.equal(state.steps.length, 1); // no double claim
  assert.equal(state.steps[0].success, true);
});

test('a deleted baseline node is recreated and mapped to its logical identity', async () => {
  const baselineTree = { nodes: [{ logicalNodeId: 'story-logical', digests: {}, parentLogicalId: null }] };
  const currentTree = { nodes: [] };

  const { adapters, state } = createMockAdapters();
  const result = await executeTreeRestore({
    restoreId: 2, rootIssueKey: 'ROOT-1', baselineTree, currentTree, controlledFields: [], adapters
  });

  assert.equal(result.state, 'COMPLETE_WITH_REPLACEMENTS');
  assert.deepEqual(state.replacements.map(r => r.logicalNodeId), ['story-logical']);
  assert.equal(state.mutations.create.length, 1);
});

test('preflight refuses a structural restore before the first Jira mutation', async () => {
  const currentTree = { nodes: [{ logicalNodeId: 'added', digests: {}, parentLogicalId: 'root' }] };
  const { adapters, state } = createMockAdapters({ preflightFail: true });

  const result = await executeTreeRestore({
    restoreId: 3, rootIssueKey: 'ROOT-1', baselineTree: { nodes: [] }, currentTree, controlledFields: [], adapters
  });

  assert.equal(result.state, 'FAILED');
  assert.equal(state.mutations.delete.length, 0);
  assert.equal(state.steps.length, 0); // no claims written!
});
