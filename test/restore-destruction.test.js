import test from 'node:test';
import assert from 'node:assert/strict';

import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';
import { project } from '../src/lib/content.js';

/**
 * Destroying a work item is the one thing a restore does that cannot be undone.
 *
 * A subtask added after approval genuinely has to be DELETED rather than
 * detached — unlike an issue link, a subtask has no existence apart from its
 * parent, so leaving it means the hierarchy was not returned to its approved
 * shape. But deletion takes a Jira record with it: its changelog, its comments,
 * and the trail of who created it.
 *
 * 21 CFR Part 11 §11.10(e) requires audit trails that record the actions which
 * create, modify OR DELETE electronic records, and says record changes "shall
 * not obscure previously recorded information". Deleting a work item and
 * writing nothing down obscures it completely. So the rule these tests hold the
 * code to is: nothing is destroyed until what it contained is durably recorded,
 * and nothing outside what the reviewer approved is destroyed at all.
 */

const controlledFields = [
  { field_id: 'summary', field_kind: 'TEXT', field_name: 'Summary', store_values: true },
  { field_id: 'description', field_kind: 'ADF', field_name: 'Description', store_values: true }
];

function addedTree() {
  const rootFields = { summary: 'Approved root', description: null };
  const addedFields = { summary: 'Subtask nobody approved', description: null };
  const rootProjection = project(rootFields, controlledFields);
  const addedProjection = project(addedFields, controlledFields);
  return {
    baselineTree: {
      nodes: [{ logicalNodeId: 'root', originalIssueId: 1, currentIssueId: 1, issueKey: 'VJIRA-16',
        parentLogicalNodeId: null, parentLogicalId: null, digests: rootProjection.digests }],
      values: { root: rootProjection.raw }
    },
    currentTree: {
      nodes: [
        { logicalNodeId: 'root', currentIssueId: 1, issueKey: 'VJIRA-16', parentLogicalNodeId: null,
          parentLogicalId: null, digests: rootProjection.digests, contentHash: rootProjection.contentHash },
        { logicalNodeId: 'added', currentIssueId: 9, issueKey: 'VJIRA-31', parentLogicalNodeId: 'root',
          parentLogicalId: 'root', digests: addedProjection.digests, contentHash: addedProjection.contentHash }
      ],
      values: { root: rootProjection.raw, added: addedProjection.raw }
    }
  };
}

function adapters({ appendLedger, deleteIssue } = {}) {
  const deleted = [];
  const ledger = [];
  return {
    deleted, ledger,
    adapters: {
      checkPermissions: async () => true,
      readRestoreActions: async () => [],
      readReplacements: async () => [],
      claimRestoreAction: async () => true,
      finishRestoreAction: async () => true,
      recordReplacement: async () => {},
      editIssue: async () => ({}),
      appendLedger: appendLedger ?? (async (eventType, payload) => { ledger.push({ eventType, payload }); }),
      deleteIssue: deleteIssue ?? (async key => { deleted.push(key); return {}; })
    }
  };
}

test('the plan names every work item a rejection will permanently delete, before it is signed', () => {
  const { baselineTree, currentTree } = addedTree();
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });

  assert.ok(plan.preflight, 'a tree plan must state its consequences the way the single-issue planner does');
  assert.deepEqual(plan.preflight.willDelete, [{ logicalNodeId: 'added', issueKey: 'VJIRA-31' }],
    `a reviewer must read which work items disappear before they sign: ${JSON.stringify(plan.preflight)}`);
});

test('what a deleted work item contained is written to the ledger before Jira is asked to delete it', async () => {
  const { baselineTree, currentTree } = addedTree();
  const order = [];
  const fixture = adapters({
    appendLedger: async (eventType, payload) => { order.push(['ledger', eventType, payload]); },
    deleteIssue: async key => { order.push(['delete', key]); return {}; }
  });
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });

  await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'VJIRA-16', baselineTree, currentTree,
    controlledFields, adapters: fixture.adapters, plan, maxActions: 10 });

  const destroyedAt = order.findIndex(entry => entry[1] === 'TREE_RESTORE_NODE_DESTROYED');
  const deletedAt = order.findIndex(entry => entry[0] === 'delete');
  assert.ok(destroyedAt >= 0, `the destruction of a record must itself be a record: ${JSON.stringify(order)}`);
  assert.ok(destroyedAt < deletedAt, 'the evidence has to be durable BEFORE the record it describes is gone');

  const preserved = order[destroyedAt][2];
  assert.equal(preserved.issueKey, 'VJIRA-31');
  assert.equal(preserved.contentHash, project({ summary: 'Subtask nobody approved', description: null },
    controlledFields).contentHash);
  assert.equal(preserved.values.summary, 'Subtask nobody approved',
    'the content is preserved, not just its hash — a hash alone cannot show an auditor what was removed');
});

test('a work item is never destroyed when its content could not be recorded', async () => {
  const { baselineTree, currentTree } = addedTree();
  // Only the destruction entry fails, so this isolates the guarantee from the
  // separate (and also correct) refusal to start a restore whose plan cannot be
  // written to the ledger at all.
  const fixture = adapters({
    appendLedger: async eventType => {
      if (eventType === 'TREE_RESTORE_NODE_DESTROYED') throw new Error('ledger unavailable');
    }
  });
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });

  const result = await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'VJIRA-16', baselineTree, currentTree,
    controlledFields, adapters: fixture.adapters, plan, maxActions: 10 });

  assert.deepEqual(fixture.deleted, [],
    'losing the audit trail is a reason to keep the work item, never a reason to delete it quietly');
  assert.ok(result.remaining > 0 || result.refused.length > 0);
});

test('a restore with no ledger to write to cannot delete anything at all', async () => {
  const { baselineTree, currentTree } = addedTree();
  const fixture = adapters();
  delete fixture.adapters.appendLedger;
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });

  await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'VJIRA-16', baselineTree, currentTree,
    controlledFields, adapters: fixture.adapters, plan, maxActions: 10 });

  assert.deepEqual(fixture.deleted, [],
    'a caller that wired no ledger must not be able to destroy records through this path');
});

test('deletion is never cascaded beyond what the reviewer approved', async () => {
  // Jira refuses to delete an issue that still has subtasks unless the caller
  // passes deleteSubtasks=true. Passing it would destroy work items created
  // after the reviewer looked, which they never saw and never agreed to lose.
  // Refusing, and saying so, is the only defensible behaviour.
  const { baselineTree, currentTree } = addedTree();
  const fixture = adapters({
    deleteIssue: async () => { const error = new Error('Cannot delete: has subtasks'); error.status = 400; throw error; }
  });
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });

  const result = await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'VJIRA-16', baselineTree, currentTree,
    controlledFields, adapters: fixture.adapters, plan, maxActions: 10 });

  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].kind, 'DELETE_ADDED_NODE');
});
