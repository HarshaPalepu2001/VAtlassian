import test from 'node:test';
import assert from 'node:assert/strict';

import { project, withAlwaysControlled } from '../src/lib/content.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { logicalNodeId } from '../src/lib/tree/model.js';

/**
 * The whole life of a subtask inside a governed hierarchy.
 *
 * A subtask is not a linked issue. A link can be detached and both work items
 * carry on; a subtask has no existence apart from its parent, so returning a
 * hierarchy to its approved shape means the subtask is either created or
 * destroyed — there is no third option. These tests walk that through end to
 * end, because every individual piece of it passed its own unit test while the
 * sequence still could not reach a clean result.
 */

const controlledFields = withAlwaysControlled([
  { field_id: 'summary', field_kind: 'TEXT', field_name: 'Summary', store_values: true },
  { field_id: 'description', field_kind: 'ADF', field_name: 'Description', store_values: true }
]).map(field => ({ ...field, store_values: true }));

const ROOT_ID = '66430';
const CHILD_ID = '66431';

function issueFields(summary, { subtasks = [], parent = null } = {}) {
  return { summary, description: null, issuelinks: [], subtasks, parent,
    project: { id: '10236' }, issuetype: { id: '10045' }, status: { id: '3' } };
}

/** A tree exactly as the reader hands it to planTreeCapture. */
function capture(nodes) {
  return planTreeCapture({ rootIssueId: ROOT_ID, nodes, controlledFields });
}

const rootAlone = [{ id: ROOT_ID, key: 'VJIRA-16', fields: issueFields('Approved root') }];
const rootWithChild = [
  { id: ROOT_ID, key: 'VJIRA-16', fields: issueFields('Approved root', { subtasks: [{ id: CHILD_ID }] }) },
  { id: CHILD_ID, key: 'VJIRA-17', fields: issueFields('Approved child', { parent: { id: ROOT_ID, key: 'VJIRA-16' } }) }
];

function adapters(overrides = {}) {
  const calls = { create: [], delete: [], edit: [], move: [], ledger: [] };
  return {
    calls,
    adapters: {
      checkPermissions: async () => true,
      readRestoreActions: async () => [],
      readReplacements: async () => [],
      claimRestoreAction: async () => true,
      finishRestoreAction: async () => true,
      recordReplacement: async () => {},
      appendLedger: async (eventType, payload) => { calls.ledger.push({ eventType, payload }); },
      editIssue: async (key, fields) => { calls.edit.push({ key, fields }); return {}; },
      moveIssue: async (key, parentKey) => { calls.move.push({ key, parentKey }); return {}; },
      deleteIssue: async key => { calls.delete.push(key); return {}; },
      createIssue: async (parentKey, node) => {
        calls.create.push({ parentKey, logicalNodeId: node.logicalNodeId });
        return { newIssueId: '70001', newIssueKey: 'VJIRA-40' };
      },
      restoreLinks: async () => ({}),
      ...overrides
    }
  };
}

// ── A subtask added after approval ───────────────────────────────────────────

test('a subtask added after approval is a structural change, not a field change on its parent', () => {
  const baseline = capture(rootAlone);
  const current = capture(rootWithChild);
  const { changes } = diffTree({ baselineTree: baseline, currentTree: current, controlledFields });

  assert.equal(changes.length, 1, `one new work item is one change: ${JSON.stringify(changes)}`);
  assert.equal(changes[0].kind, 'NODE_ADDED');
  assert.equal(changes[0].logicalNodeId, logicalNodeId(CHILD_ID));
});

test('rejecting deletes the added subtask outright — a subtask cannot be left detached', async () => {
  const baseline = capture(rootAlone);
  const current = capture(rootWithChild);
  const plan = planTreeRestore({ baselineTree: baseline, currentTree: current, controlledFields });

  assert.deepEqual(plan.steps.map(step => step.kind), ['DELETE_ADDED_NODE']);
  assert.deepEqual(plan.preflight.willDelete.map(entry => entry.issueKey), ['VJIRA-17']);

  const fixture = adapters();
  const executed = await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'VJIRA-16',
    baselineTree: baseline, currentTree: current, controlledFields,
    adapters: fixture.adapters, plan, maxActions: 10 });

  assert.equal(executed.state, 'READY_TO_VERIFY');
  assert.deepEqual(fixture.calls.delete, ['VJIRA-17']);
  const destroyed = fixture.calls.ledger.find(entry => entry.eventType === 'TREE_RESTORE_NODE_DESTROYED');
  assert.equal(destroyed.payload.issueKey, 'VJIRA-17');
  assert.equal(destroyed.payload.values.summary, 'Approved child');
});

test('once the added subtask is gone the hierarchy verifies clean', async () => {
  const baseline = capture(rootAlone);
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: { nodes: rootAlone } }),
    readTree: async () => {}, rootIssueKey: 'VJIRA-16', baselineTree: baseline,
    controlledFields, replacements: []
  });
  assert.equal(verified.matches, true, JSON.stringify(verified.unmatched));
});

test('approving an added subtask captures it into the next baseline, with its own controlled fields', () => {
  // The user-facing rule: approve means the new shape becomes the approved
  // shape. The capture has to cover the child as a node of its own, not as an
  // id inside the parent's subtasks list, or the child's contents would be
  // ratified without ever being hashed.
  const next = capture(rootWithChild);
  const childNode = next.nodes.find(node => node.logicalNodeId === logicalNodeId(CHILD_ID));

  assert.ok(childNode, 'the approved tree must carry the new subtask as a node');
  assert.equal(childNode.issueKey, 'VJIRA-17');
  assert.equal(childNode.parentLogicalNodeId, logicalNodeId(ROOT_ID));
  assert.equal(next.nodeCount, 2);
  assert.equal(next.edgeCount, 1);
  // Its controlled fields are hashed and retained under the same baseline.
  assert.deepEqual(JSON.parse(childNode.fieldDigests),
    project(issueFields('Approved child', { parent: { id: ROOT_ID } }), controlledFields).digests);
  assert.equal(next.values[logicalNodeId(CHILD_ID)].summary, 'Approved child');
  // And the tree hash — the thing the reviewer's signature binds to — changes
  // because of it, so the new subtask cannot be inside an old signature.
  assert.notEqual(next.treeHash, capture(rootAlone).treeHash);
});

// ── A subtask deleted after approval ─────────────────────────────────────────

test('a subtask deleted after approval is recreated, and the restore can now reach a clean result', async () => {
  const baseline = capture(rootWithChild);
  const current = capture(rootAlone);
  const plan = planTreeRestore({ baselineTree: baseline, currentTree: current, controlledFields });

  assert.ok(plan.steps.some(step => step.kind === 'CREATE_REPLACEMENT'));
  assert.deepEqual(plan.preflight.willRecreate.map(entry => entry.issueKey), ['VJIRA-17']);
  for (const step of plan.steps) {
    assert.ok(!step.fieldIds.includes('subtasks'), JSON.stringify(step));
  }

  const fixture = adapters();
  const executed = await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'VJIRA-16',
    baselineTree: baseline, currentTree: current, controlledFields,
    adapters: fixture.adapters, plan, maxActions: 10 });
  assert.equal(executed.state, 'READY_TO_VERIFY', JSON.stringify(executed));

  // Jira gave the recreated work item a new id and key. The parent's subtasks
  // list and the child's parent pointer both differ from the approved values,
  // and the restore is nonetheless exactly right.
  const live = [
    { id: ROOT_ID, key: 'VJIRA-16', fields: issueFields('Approved root', { subtasks: [{ id: '70001' }] }) },
    { id: '70001', key: 'VJIRA-40', fields: issueFields('Approved child', { parent: { id: ROOT_ID, key: 'VJIRA-16' } }) }
  ];
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: { nodes: live } }),
    readTree: async () => {}, rootIssueKey: 'VJIRA-16', baselineTree: baseline, controlledFields,
    replacements: [{ logicalNodeId: logicalNodeId(CHILD_ID), oldIssueId: CHILD_ID,
      newIssueId: '70001', newIssueKey: 'VJIRA-40' }]
  });

  assert.equal(verified.matches, true,
    `a recreated subtask must be able to verify clean, or COMPLETE_WITH_REPLACEMENTS is unreachable: ${JSON.stringify(verified.unmatched)}`);
});

test('a recreated subtask that came back with the WRONG contents still fails verification', async () => {
  // The replacement map must not become a blanket excuse. Identity is remapped;
  // content is not.
  const baseline = capture(rootWithChild);
  const live = [
    { id: ROOT_ID, key: 'VJIRA-16', fields: issueFields('Approved root', { subtasks: [{ id: '70001' }] }) },
    { id: '70001', key: 'VJIRA-40', fields: issueFields('Something else entirely', { parent: { id: ROOT_ID, key: 'VJIRA-16' } }) }
  ];
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: { nodes: live } }),
    readTree: async () => {}, rootIssueKey: 'VJIRA-16', baselineTree: baseline, controlledFields,
    replacements: [{ logicalNodeId: logicalNodeId(CHILD_ID), oldIssueId: CHILD_ID,
      newIssueId: '70001', newIssueKey: 'VJIRA-40' }]
  });

  assert.equal(verified.matches, false);
  const summary = verified.unmatched.find(entry => entry.fieldId === 'summary');
  assert.ok(summary, JSON.stringify(verified.unmatched));
  assert.equal(summary.issueKey, 'VJIRA-40', 'the reviewer is told the key that actually holds the wrong value');
});

test('a subtask moved under a different parent is reported and repaired as a move', async () => {
  const baseline = capture(rootWithChild);
  const moved = [
    { id: ROOT_ID, key: 'VJIRA-16', fields: issueFields('Approved root') },
    { id: CHILD_ID, key: 'VJIRA-17', fields: issueFields('Approved child', { parent: { id: '99999', key: 'OTHER-1' } }) }
  ];
  // capturePlan refuses a dangling edge, so the moved child is compared through
  // the verifier's own projection, which is what runs in production.
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: { nodes: moved } }),
    readTree: async () => {}, rootIssueKey: 'VJIRA-16', baselineTree: baseline, controlledFields, replacements: []
  });
  assert.equal(verified.matches, false);
  assert.ok(verified.unmatched.some(entry => entry.kind === 'NODE_MOVED'), JSON.stringify(verified.unmatched));
});
