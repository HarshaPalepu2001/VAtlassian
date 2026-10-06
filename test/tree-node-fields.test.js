import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { readTreeWithNodeFields, scopeKey, nodeScope, fieldScope } from '../src/lib/tree/nodeFields.js';

const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true });
const story = [F('summary'), F('customfield_1')];
const subtask = [F('summary')];
const node = (id, type, parent, fields) => ({ id, key: `K-${id}`, fields: { ...fields,
  project: { id: '1' }, issuetype: { id: type }, parent: parent ? { id: parent } : null } });
const nodes = [node('1', 'S', null, { summary: 'root', customfield_1: 'a' }), node('2', 'T', '1', { summary: 'child', customfield_1: 'ignored' })];
const fieldsFor = n => (nodeScope(n).issueTypeId === 'S' ? story : subtask);

test('each node is projected with its own issue type\'s fields', () => {
  const plan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story, fieldsFor });
  const child = plan.nodes.find(n => n.originalIssueId === 2);
  assert.deepEqual(Object.keys(JSON.parse(child.fieldDigests)), ['summary']);
  assert.deepEqual(Object.keys(plan.values[child.logicalNodeId]), ['summary']);
  assert.equal(plan.totalFieldCount, 3);
});

test('without fieldsFor every node uses the given list, exactly as before', () => {
  const plan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story });
  assert.equal(plan.totalFieldCount, 4);
});

test('a child whose type tracks nothing is still a node, with no fields', () => {
  const plan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story,
    fieldsFor: n => (nodeScope(n).issueTypeId === 'S' ? story : []) });
  assert.equal(plan.nodeCount, 2);
  assert.equal(plan.totalFieldCount, 2);
});

test('a change to a field the child does not track is not a child change', () => {
  const base = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story, fieldsFor });
  const edited = [nodes[0], node('2', 'T', '1', { summary: 'child', customfield_1: 'changed' })];
  const now = planTreeCapture({ rootIssueId: '1', nodes: edited, controlledFields: story, fieldsFor });
  assert.deepEqual(diffTree({ baselineTree: base, currentTree: now, controlledFields: story, scopeFor: fieldsFor }).changes, []);
});

test('a change to a field only the child tracks is found with per-node scope', () => {
  const extra = [F('summary'), F('customfield_9')];
  const own = n => (nodeScope(n).issueTypeId === 'S' ? story : extra);
  const base = planTreeCapture({ rootIssueId: '1', nodes: [nodes[0], node('2', 'T', '1', { summary: 'c', customfield_9: 'a' })],
    controlledFields: story, fieldsFor: own });
  const now = planTreeCapture({ rootIssueId: '1', nodes: [nodes[0], node('2', 'T', '1', { summary: 'c', customfield_9: 'b' })],
    controlledFields: story, fieldsFor: own });
  const { changes } = diffTree({ baselineTree: base, currentTree: now, controlledFields: story, scopeFor: own });
  assert.deepEqual(changes.map(c => [c.kind, c.fields]), [['FIELD_CHANGED', ['customfield_9']]]);
});

// ─── Every node of a tree tracks the ROOT's fields ──────────────────────────
//
// Decided 2026-09-25, replacing the per-issue-type rule of the 24th: the
// approval being made is the root's, so the root's Controlled Fields are what
// every node it covers is held to. A Task under an Epic tracks the Epic's
// fields — attachments included — whether or not anyone configured Task.

test('a child of another issue type is read and tracked with the root\'s fields', async () => {
  const reads = [];
  const tree = { nodes: [node('1', 'S', null, { summary: 'r', customfield_1: 'a' }), node('2', 'X', '1', { summary: 'c' })] };
  const result = await readTreeWithNodeFields({
    readStableTree: async ({ fieldIds }) => { reads.push([...fieldIds].sort()); return { tree }; },
    readTree: null, rootIssueKey: 'K-1', rootFields: story
  });
  assert.equal(reads.length, 1, 'one read: every node needs exactly the root\'s fields');
  assert.ok(reads[0].includes('customfield_1'));
  assert.deepEqual(result.fieldsFor(tree.nodes[1]), story);
  assert.deepEqual(result.fieldsFor({ projectId: 9, issueTypeId: 'Z' }), story, 'planned nodes resolve too');
  assert.equal(scopeKey(1, 'S'), '1:S');
});

test('a child field the root does not track is not a child change', () => {
  const rootOnly = () => story;
  const base = planTreeCapture({ rootIssueId: '1', nodes: [nodes[0], node('2', 'T', '1', { summary: 'c', customfield_9: 'a' })],
    controlledFields: story, fieldsFor: rootOnly });
  const now = planTreeCapture({ rootIssueId: '1', nodes: [nodes[0], node('2', 'T', '1', { summary: 'c', customfield_9: 'b' })],
    controlledFields: story, fieldsFor: rootOnly });
  assert.deepEqual(diffTree({ baselineTree: base, currentTree: now, controlledFields: story, scopeFor: rootOnly }).changes, []);
});

test('an item\'s fields come with the rule scope they came from, and the version that imposed it', async () => {
  const controlledFields = async ({ projectId, issueTypeId }) => [{ field_id: `${projectId}:${issueTypeId}` }];
  const own = await fieldScope({ issueId: 7, projectId: 1, issueTypeId: 'T' },
    { activeRootsForNode: async () => [], controlledFields });
  assert.deepEqual(own.fields, [{ field_id: '1:T' }]);
  assert.deepEqual(own.ruleScope, { source: 'OWN', projectId: 1, issueTypeId: 'T', imposedByBaselineId: null, imposedByVersion: null });
  const root = { rootIssueId: 1, baselineId: Buffer.alloc(16, 2), version: 4, projectId: 1, issueTypeId: 'E', capturedAt: 10 };
  const child = await fieldScope({ issueId: 7, projectId: 1, issueTypeId: 'T' },
    { activeRootsForNode: async () => [root], controlledFields });
  assert.deepEqual(child.fields, [{ field_id: '1:E' }]);
  assert.equal(child.ruleScope.source, 'INHERITED');
  assert.deepEqual([child.ruleScope.projectId, child.ruleScope.issueTypeId], [1, 'E']);
  assert.ok(child.ruleScope.imposedByBaselineId.equals(Buffer.alloc(16, 2)));
  assert.equal(child.ruleScope.imposedByVersion, 4);
});
