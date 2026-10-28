import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';
import { claimRestoreAction, finishRestoreAction, readRestoreActions } from '../src/db/restoreTreeStore.js';

function trees() {
  return {
    baselineTree: {
      nodes: [
        { logicalNodeId: 'root', id: '1', key: 'ROOT-1', parentLogicalId: null, digests: {} },
        { logicalNodeId: 'child', id: '2', key: 'ROOT-2', parentLogicalId: 'root', digests: { summary: 'approved' } }
      ],
      values: { root: {}, child: { summary: 'approved' } }
    },
    currentTree: {
      nodes: [
        { logicalNodeId: 'root', id: '1', key: 'ROOT-1', parentLogicalId: null, digests: {} },
        { logicalNodeId: 'child', id: '2', key: 'ROOT-2', parentLogicalId: null, digests: { summary: 'changed' } }
      ]
    },
    controlledFields: [{ field_id: 'summary' }]
  };
}

function createJournalAdapters(options = {}) {
  const state = {
    actions: [], replacements: [],
    mutations: { create: [], edit: [], move: [], delete: [], links: [] },
    ledger: [],
    failFieldOnce: options.failFieldOnce ?? false,
    permissionResponse: options.permissionResponse ?? 200
  };
  const adapters = {
    checkPermissions: async () => state.permissionResponse === 200,
    readRestoreActions: async () => state.actions.map(action => ({ ...action })),
    claimRestoreAction: async (_restoreId, step, issueId) => {
      const existing = state.actions.find(action => action.stepKey === step.stepKey);
      if (existing?.state === 'COMPLETE') return false;
      if (existing) {
        existing.state = 'RUNNING';
        existing.attempts += 1;
        return true;
      }
      state.actions.push({ stepKey: step.stepKey, logicalNodeId: step.logicalNodeId, kind: step.kind,
        issueId, state: 'RUNNING', attempts: 1 });
      return true;
    },
    finishRestoreAction: async (_restoreId, stepKey, success, detail) => {
      const action = state.actions.find(candidate => candidate.stepKey === stepKey);
      action.state = success ? 'COMPLETE' : 'FAILED';
      action.detail = detail;
      return true;
    },
    readReplacements: async () => state.replacements.map(replacement => ({ ...replacement })),
    recordReplacement: async (_restoreId, logicalNodeId, oldIssueId, newIssueId) => {
      state.replacements.push({ logicalNodeId, oldIssueId, newIssueId });
    },
    createIssue: async (_parentKey, node) => {
      state.mutations.create.push(node.logicalNodeId);
      return { newIssueId: `new-${node.logicalNodeId}`, newIssueKey: `NEW-${node.logicalNodeId}` };
    },
    moveIssue: async (issueId, parentKey) => { state.mutations.move.push({ issueId, parentKey }); },
    editIssue: async (issueId, fields) => {
      state.mutations.edit.push({ issueId, fields });
      if (state.failFieldOnce) {
        state.failFieldOnce = false;
        throw new Error('field write refused');
      }
    },
    deleteIssue: async issueId => { state.mutations.delete.push(issueId); },
    restoreLinks: async (issueId, links) => { state.mutations.links.push({ issueId, links }); },
    // Required, not optional: the executor will not destroy a work item it
    // cannot first record. See the DELETE_ADDED_NODE branch.
    appendLedger: async (eventType, payload) => { state.ledger.push({ eventType, payload }); }
  };
  return { adapters, state };
}

test('a failed field action resumes without replaying a completed move', async () => {
  const fixture = trees();
  const { adapters, state } = createJournalAdapters({ failFieldOnce: true });
  const first = await executeTreeRestore({ restoreId: 'restore-1', rootIssueKey: 'ROOT-1', ...fixture, adapters, maxActions: 2 });
  assert.equal(first.state, 'PARTIAL');
  assert.equal(first.retryableError.detail, 'field write refused');
  assert.equal(first.attempted, 2);
  assert.equal(state.mutations.move.length, 1);
  const second = await executeTreeRestore({ restoreId: 'restore-1', rootIssueKey: 'ROOT-1', ...fixture, adapters, maxActions: 10 });
  assert.equal(second.state, 'READY_TO_VERIFY');
  assert.equal(state.mutations.move.length, 1);
  assert.equal(state.mutations.edit.length, 2);
  assert.equal(second.remaining, 0);
});

test('no Jira mutation occurs when preflight cannot prove permissions', async () => {
  const fixture = trees();
  const { adapters, state } = createJournalAdapters({ permissionResponse: 403 });
  const result = await executeTreeRestore({ restoreId: 'restore-2', rootIssueKey: 'ROOT-1', ...fixture, adapters, maxActions: 10 });
  assert.equal(result.state, 'FAILED');
  assert.deepEqual(state.mutations, { create: [], edit: [], move: [], delete: [], links: [] });
  assert.equal(state.actions.length, 0);
});

test('an unavailable permission service is retryable rather than a permanent permission refusal', async () => {
  const fixture = trees();
  const { adapters, state } = createJournalAdapters();
  adapters.checkPermissions = async () => { throw Object.assign(new Error('Jira unavailable'), { status: 503 }); };
  const result = await executeTreeRestore({ restoreId: 'preflight-outage', rootIssueKey: 'ROOT-1', ...fixture, adapters });
  assert.equal(result.retryableError?.status, 503);
  assert.equal(state.actions.length, 0);
});

test('maxActions bounds one invocation and reports durable progress', async () => {
  const fixture = trees();
  const { adapters } = createJournalAdapters();
  const first = await executeTreeRestore({ restoreId: 'restore-3', rootIssueKey: 'ROOT-1', ...fixture, adapters, maxActions: 1 });
  assert.deepEqual({ state: first.state, attempted: first.attempted, completed: first.completed, remaining: first.remaining },
    { state: 'PARTIAL', attempted: 1, completed: 1, remaining: 1 });
});

test('a delete 404 is idempotent only after the same added-node action was previously claimed', async () => {
  const baselineTree = { nodes: [{ logicalNodeId: 'root', id: '1', key: 'ROOT-1', parentLogicalId: null, digests: {} }], values: { root: {} } };
  const currentTree = { nodes: [
    { logicalNodeId: 'root', id: '1', key: 'ROOT-1', parentLogicalId: null, digests: {} },
    { logicalNodeId: 'added', id: '9', key: 'ROOT-9', parentLogicalId: 'root', digests: {} }
  ] };
  const { adapters } = createJournalAdapters();
  adapters.deleteIssue = async () => { const error = new Error('not found'); error.status = 404; throw error; };

  const first = await executeTreeRestore({ restoreId: 'restore-404', rootIssueKey: 'ROOT-1', baselineTree, currentTree,
    controlledFields: [], adapters, maxActions: 10 });
  const second = await executeTreeRestore({ restoreId: 'restore-404', rootIssueKey: 'ROOT-1', baselineTree, currentTree,
    controlledFields: [], adapters, maxActions: 10 });

  assert.equal(first.state, 'PARTIAL');
  assert.equal(second.state, 'READY_TO_VERIFY');
});

test('a Jira mutation is not counted complete when its journal finish is not durable', async () => {
  const fixture = trees();
  const { adapters, state } = createJournalAdapters();
  adapters.finishRestoreAction = async () => false;

  const result = await executeTreeRestore({ restoreId: 'restore-finish-race', rootIssueKey: 'ROOT-1',
    ...fixture, adapters, maxActions: 1 });

  assert.equal(state.mutations.move.length, 1);
  assert.equal(result.state, 'PARTIAL');
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, 2);
});

test('legacy field restore plans reconcile links separately from ordinary fields', async () => {
  const fixture = trees();
  const { adapters, state } = createJournalAdapters();
  const links = [{ id: 'link-1' }];
  const persistedPlan = {
    steps: [{ stepKey: 'legacy-links', logicalNodeId: 'root', parentLogicalNodeId: null,
      kind: 'RESTORE_FIELDS', fields: { summary: 'approved', issuelinks: links } }]
  };

  const result = await executeTreeRestore({ restoreId: 'restore-legacy-links', rootIssueKey: 'ROOT-1',
    ...fixture, adapters, plan: persistedPlan, maxActions: 10 });

  assert.equal(result.state, 'READY_TO_VERIFY');
  assert.deepEqual(state.mutations.edit, [{ issueId: 'ROOT-1', fields: { summary: 'approved' } }]);
  assert.deepEqual(state.mutations.links, [{ issueId: 'ROOT-1', links }]);
});

test('action journal store uses the step key rather than the node as its identity', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT')) return [{
      stepKey: 'a'.repeat(64), logicalNodeId: 'child', kind: 'MOVE_NODE', issueId: 2,
      issueKey: 'ROOT-2', state: 'COMPLETE', attempts: 1, startedAt: 1, finishedAt: 2, detail: null
    }];
    return { affectedRows: 1 };
  };
  const step = { stepKey: 'a'.repeat(64), logicalNodeId: 'child', kind: 'MOVE_NODE' };
  await claimRestoreAction('restore-id', step, { issueId: 2, issueKey: 'ROOT-2', now: 1 }, query);
  await finishRestoreAction('restore-id', step.stepKey, true, { moved: true }, { now: 2 }, query);
  const rows = await readRestoreActions('restore-id', query);
  assert.ok(calls[0].sql.includes('step_key'));
  assert.ok(calls[1].sql.includes('step_key = ?'));
  assert.equal(rows[0].stepKey, step.stepKey);
  assert.equal(rows[0].state, 'COMPLETE');
});
