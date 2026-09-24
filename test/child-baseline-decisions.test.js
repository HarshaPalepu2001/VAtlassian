import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/content.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';
import { treeReviewDiff } from '../src/lib/tree/reviewDiff.js';
import { groupReview } from '../src/lib/tree/groupedReview.js';
import { withChildBaselines, ownsItsContent } from '../src/lib/tree/childBaselines.js';
import { nodeScope } from '../src/lib/tree/nodeFields.js';

/**
 * A PARENT DECISION COVERS ITS CHILDREN (spec 2026-09-24 §4.5, §4.7).
 *
 * Reject restores each issue to ITS OWN latest recorded baseline; the review
 * shows each drifted child against exactly that. Both come from one effective
 * baseline tree (lib/tree/childBaselines.js), so the review, the restore plan
 * and the post-restore verification can never compare against different things.
 */

const F = (id, kind = 'TEXT') => ({ field_id: id, field_name: id, field_kind: kind, store_values: true });
const parentFields = [F('summary'), F('description')];
const childFields = [F('summary')];
const fieldsFor = n => (nodeScope(n).issueTypeId === 'S' ? parentFields : childFields);
const raw = (id, key, type, parent, fields) => ({ id, key, fields: { ...fields, project: { id: '1' }, issuetype: { id: type },
  status: { id: '1' }, parent: parent ? { id: parent } : null } });

// The parent's capture at v3: P-1 plus subtasks P-2 and P-3.
const captured = planTreeCapture({ rootIssueId: '1', controlledFields: parentFields, fieldsFor, nodes: [
  raw('1', 'P-1', 'S', null, { summary: 'parent', description: 'd' }),
  raw('2', 'P-2', 'T', '1', { summary: 'captured by parent' }),
  raw('3', 'P-3', 'T', '1', { summary: 'three' })
] });
const baselineTree = () => {
  // As readBaselineTree returns it: digests non-enumerable, parent alias.
  const nodes = captured.nodes.map(n => {
    const copy = { ...n };
    Object.defineProperties(copy, { parentLogicalId: { value: n.parentLogicalNodeId, enumerable: false },
      digests: { value: JSON.parse(n.fieldDigests), enumerable: false } });
    return copy;
  });
  return { nodes, values: structuredClone(captured.values) };
};
const idOf = key => captured.nodes.find(n => n.issueKey === key).logicalNodeId;
const parentBaseline = { baseline_id: Buffer.alloc(16, 1), issue_id: 1, version: 3, captured_at: 1000 };

// P-2 was later approved in its own panel: its own v6 says 'child own v6'.
const own = { baseline_id: Buffer.alloc(16, 6), issue_id: 2, version: 6, tree_hash: null, captured_at: 2000,
  captured_by_baseline_id: null, field_digests: JSON.stringify(project({ summary: 'child own v6' }, childFields).digests) };
const stores = {
  activeBaselines: async ids => new Map(ids.map(Number).includes(2) ? [[2, own]] : []),
  readAllValues: async (issueId, version) => (assert.deepEqual([issueId, version], [2, 6]), { summary: 'child own v6' }),
  readBaselineTree: async () => assert.fail('a single-issue child baseline is read by its values')
};

const current = nodes => planTreeCapture({ rootIssueId: '1', controlledFields: parentFields, fieldsFor, nodes });
const liveTree = ({ p2 = 'child edited', p1 = 'parent' } = {}) => [
  raw('1', 'P-1', 'S', null, { summary: p1, description: 'd' }),
  raw('2', 'P-2', 'T', '1', { summary: p2 }),
  raw('3', 'P-3', 'T', '1', { summary: 'three' })
];

test('a child baseline written by this parent capture, or captured since, owns the child\'s content', () => {
  assert.equal(ownsItsContent({ captured_by_baseline_id: Buffer.alloc(16, 1), captured_at: 1 }, parentBaseline), true);
  assert.equal(ownsItsContent({ captured_by_baseline_id: null, captured_at: 2000 }, parentBaseline), true);
  assert.equal(ownsItsContent({ captured_by_baseline_id: null, captured_at: 999 }, parentBaseline), false,
    'a child baselined only before the parent capture: the parent\'s node is the latest record');
  assert.equal(ownsItsContent(null, parentBaseline), false);
});

test('the effective tree carries each owning child\'s own record and keeps the parent\'s structure', async () => {
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(), ...stores });
  const p2 = tree.nodes.find(n => n.issueKey === 'P-2');
  assert.deepEqual(tree.values[p2.logicalNodeId], { summary: 'child own v6' });
  assert.deepEqual(p2.digests, JSON.parse(own.field_digests));
  assert.deepEqual(p2.ownBaseline, { version: 6, baselineId: own.baseline_id.toString('hex'), capturedByParent: false });
  assert.equal(p2.parentLogicalId, idOf('P-1'));
  assert.deepEqual(tree.values[idOf('P-3')], { summary: 'three' }, 'a child without its own baseline is unchanged');
  assert.deepEqual(tree.values[idOf('P-1')], { summary: 'parent', description: 'd' });
});

test('a child whose own baseline is a tree (it has children of its own) is read from that tree\'s root node', async () => {
  const digests = project({ summary: 'own tree' }, childFields).digests;
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(),
    activeBaselines: async () => new Map([[2, { ...own, tree_hash: 't', field_digests: '{}' }]]),
    readAllValues: async () => assert.fail('a tree baseline keeps its values per node'),
    readBaselineTree: async () => {
      const root = { logicalNodeId: idOf('P-2'), parentLogicalNodeId: null };
      Object.defineProperty(root, 'digests', { value: digests, enumerable: false });
      return { nodes: [root], values: { [idOf('P-2')]: { summary: 'own tree' } } };
    } });
  assert.deepEqual(tree.values[idOf('P-2')], { summary: 'own tree' });
});

test('rejecting the parent restores the child to its OWN latest baseline, not the parent\'s older capture', async () => {
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(), ...stores });
  const now = current(liveTree({ p1: 'parent edited' }));
  const plan = planTreeRestore({ baselineTree: tree, currentTree: now, controlledFields: parentFields, fieldsFor });
  const restores = plan.steps.filter(s => s.kind === 'RESTORE_FIELDS').map(s => [s.logicalNodeId, s.fields]);
  assert.deepEqual(restores, [
    [idOf('P-1'), { summary: 'parent' }],
    [idOf('P-2'), { summary: 'child own v6' }]
  ]);
});

test('a child already at its own latest baseline is left alone by a parent reject', async () => {
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(), ...stores });
  const now = current(liveTree({ p1: 'parent edited', p2: 'child own v6' }));
  const plan = planTreeRestore({ baselineTree: tree, currentTree: now, controlledFields: parentFields, fieldsFor });
  assert.deepEqual(plan.steps.filter(s => s.kind === 'RESTORE_FIELDS').map(s => s.logicalNodeId), [idOf('P-1')]);
});

test('after the restore, verification checks each child against its own record', async () => {
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(), ...stores });
  const readStableTree = async () => ({ tree: { nodes: liveTree({ p2: 'child own v6' }) } });
  const verified = await verifyTreeRestore({ readStableTree, readTree: null, rootIssueKey: 'P-1', baselineTree: tree,
    controlledFields: parentFields, fieldsFor });
  assert.equal(verified.matches, true, JSON.stringify(verified.unmatched));
  const stale = await verifyTreeRestore({ readStableTree: async () => ({ tree: { nodes: liveTree({ p2: 'captured by parent' }) } }),
    readTree: null, rootIssueKey: 'P-1', baselineTree: tree, controlledFields: parentFields, fieldsFor });
  assert.equal(stale.matches, false, 'the parent\'s older value is not the child\'s record');
  assert.deepEqual(stale.unmatched.map(u => [u.issueKey, u.fieldId]), [['P-2', 'summary']]);
});

test('the review groups the parent, the structure and each drifted child, each child against its own version', async () => {
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(), ...stores });
  const nodes = [...liveTree({ p1: 'parent edited' }), raw('4', 'P-4', 'T', '1', { summary: 'new' })];
  const now = current(nodes);
  const treeDiff = diffTree({ baselineTree: tree, currentTree: now, controlledFields: parentFields, scopeFor: fieldsFor });
  const review = treeReviewDiff({ baseline: { ...parentBaseline, version: 3 }, baselineTree: tree,
    currentTree: { nodes: now.nodes, values: now.values }, treeDiff, controlledFields: parentFields, fieldsFor,
    summaryOf: id => ({ [idOf('P-2')]: 'child edited', [idOf('P-1')]: 'parent edited' })[id] ?? null });
  assert.deepEqual(review.groups.map(g => [g.kind, g.issueKey, g.baselineVersion, g.fields.map(f => f.label)]), [
    ['ISSUE', 'P-1', 3, ['summary']],
    ['STRUCTURE', null, null, ['Added node · P-4']],
    ['ISSUE', 'P-2', 6, ['summary']]
  ]);
  assert.equal(review.groups[2].summary, 'child edited');
  assert.equal(review.changedFieldCount, 3, 'one decision covers all three');
  assert.ok(!review.groups.some(g => g.issueKey === 'P-3'), 'an unchanged child is not listed');
});

test('grouping orders the root first, then structure, then children by key, and drops nothing', () => {
  const issue = (key, isRoot = false) => ({ group: { kind: 'ISSUE', logicalNodeId: key, issueKey: key, isRoot, baselineVersion: 1 } });
  const fields = [issue('P-10'), { group: { kind: 'STRUCTURE' } }, issue('P-2'), issue('P-1', true), issue('P-2')];
  const groups = groupReview(fields);
  assert.deepEqual(groups.map(g => g.issueKey ?? g.kind), ['P-1', 'STRUCTURE', 'P-2', 'P-10']);
  assert.equal(groups.reduce((n, g) => n + g.fields.length, 0), fields.length);
  assert.deepEqual(groupReview([]), []);
});

test('a child whose own baseline matches what the parent captured costs no value read', async () => {
  const same = { ...own, field_digests: JSON.stringify(project({ summary: 'captured by parent' }, childFields).digests),
    captured_by_baseline_id: parentBaseline.baseline_id };
  const tree = await withChildBaselines({ parentBaseline, baselineTree: baselineTree(),
    activeBaselines: async () => new Map([[2, same]]),
    readAllValues: async () => assert.fail('the parent already holds these values'),
    readBaselineTree: async () => assert.fail('not a tree') });
  const p2 = tree.nodes.find(n => n.issueKey === 'P-2');
  assert.deepEqual(tree.values[p2.logicalNodeId], { summary: 'captured by parent' });
  assert.equal(p2.ownBaseline.version, 6);
});
