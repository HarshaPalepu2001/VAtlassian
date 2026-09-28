import test from 'node:test';
import assert from 'node:assert/strict';
import { project, FIELD_KIND } from '../src/lib/content.js';
import { treeReviewDiff } from '../src/lib/tree/reviewDiff.js';
import { buildPayload, degraded } from '../src/lib/report.js';

const fields = [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' }];

function node(id, key, values) {
  const projection = project(values, fields);
  const result = { logicalNodeId: id, issueKey: key, parentLogicalNodeId: null };
  Object.defineProperties(result, { digests: { value: projection.digests } });
  return result;
}

test('tree review diff exposes a changed field instead of returning a null flat diff', () => {
  const before = project({ summary: 'approved' }, fields);
  const baseline = { issue_id: 10, version: 3, field_digests: JSON.stringify(before.digests) };
  const result = treeReviewDiff({
    baseline,
    baselineTree: { nodes: [node('root', 'T-10', { summary: 'approved' })], values: { root: { summary: 'approved' } } },
    currentTree: { nodes: [node('root', 'T-10', { summary: 'edited' })], values: { root: { summary: 'edited' } } },
    treeDiff: { changes: [{ kind: 'FIELD_CHANGED', logicalNodeId: 'root', fields: ['summary'] }] },
    controlledFields: fields
  });

  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].fieldName, 'T-10 · Summary');
  assert.equal(result.fields[0].before, 'approved');
  assert.equal(result.fields[0].after, 'edited');
  assert.equal(result.changedFieldCount, 1);
});

test('tree review diff preserves root changelog attribution for the audit trail', () => {
  const before = project({ summary: 'approved' }, fields);
  const baseline = { issue_id: 10, version: 3, transition_at: 100, field_digests: JSON.stringify(before.digests) };
  const result = treeReviewDiff({
    baseline,
    baselineTree: { nodes: [{ logicalNodeId: 'root', originalIssueId: 10, issueKey: 'T-10', parentLogicalId: null, digests: before.digests }], values: { root: { summary: 'approved' } } },
    currentTree: { nodes: [{ logicalNodeId: 'root', originalIssueId: 10, issueKey: 'T-10', parentLogicalId: null, digests: project({ summary: 'edited' }, fields).digests }], values: { root: { summary: 'edited' } } },
    treeDiff: { changes: [{ kind: 'FIELD_CHANGED', logicalNodeId: 'root', fields: ['summary'] }] },
    controlledFields: fields,
    changelogEntries: [{ changelogId: '7', at: 200, authorId: 'reviewer-1', authorName: 'Priya Reviewer', source: 'USER', items: [{ fieldId: 'summary', fieldName: 'Summary', fromString: 'approved', toString: 'edited' }] }]
  });

  assert.deepEqual(result.fields[0].attribution.map(item => [item.authorName, item.at]), [['Priya Reviewer', 200]]);
  assert.equal(result.timeline.length, 1);
});

test('tree review diff counts changed fields, not only changed nodes', () => {
  const twoFields = [
    ...fields,
    { field_id: 'priority', field_name: 'Priority', field_kind: FIELD_KIND.SCALAR, store_values: true, materiality: 'MAJOR' }
  ];
  const before = project({ summary: 'approved', priority: { id: '1', name: 'High' } }, twoFields);
  const result = treeReviewDiff({
    baseline: { issue_id: 10, version: 3, field_digests: JSON.stringify(before.digests) },
    baselineTree: { nodes: [{ logicalNodeId: 'root', issueKey: 'T-10', parentLogicalId: null }], values: { root: { summary: 'approved', priority: { id: '1', name: 'High' } } } },
    currentTree: { nodes: [{ logicalNodeId: 'root', issueKey: 'T-10', parentLogicalId: null }], values: { root: { summary: 'edited', priority: { id: '2', name: 'Highest' } } } },
    treeDiff: { changes: [{ kind: 'FIELD_CHANGED', logicalNodeId: 'root', fields: ['summary', 'priority'] }] },
    controlledFields: twoFields
  });

  assert.equal(result.fields.length, 2);
  assert.equal(result.changedFieldCount, 2);
  assert.equal(result.materialFieldCount, 2);
});

test('tree review diff remains renderable for structural changes', () => {
  const result = treeReviewDiff({
    baseline: { issue_id: 10, version: 3 },
    baselineTree: { nodes: [{ logicalNodeId: 'root', issueKey: 'T-10' }] },
    currentTree: { nodes: [{ logicalNodeId: 'root', issueKey: 'T-10' }, { logicalNodeId: 'child', issueKey: 'T-11' }] },
    treeDiff: { changes: [{ kind: 'NODE_ADDED', logicalNodeId: 'child' }] },
    controlledFields: fields
  });

  assert.equal(result.fields.length, 1);
  assert.match(result.fields[0].fieldName, /Added node/);
});

test('a structural change still yields a report, with and without the model', () => {
  const diff = treeReviewDiff({
    baseline: { issue_id: 10, version: 3 },
    baselineTree: { nodes: [{ logicalNodeId: 'root', issueKey: 'T-10' }] },
    currentTree: { nodes: [{ logicalNodeId: 'root', issueKey: 'T-10' }, { logicalNodeId: 'child', issueKey: 'T-11' }] },
    treeDiff: { changes: [{ kind: 'NODE_ADDED', logicalNodeId: 'child' }] },
    controlledFields: fields
  });

  assert.deepEqual(diff.fields[0].attribution, []);
  assert.equal(degraded(diff, 'rule-based', 'DISABLED').body.changeGroups[0].whoAndWhen, 'Author not recorded.');
  const payload = buildPayload({ issue: { key: 'T-10', fields: {} }, baseline: { version: 3 }, diff });
  assert.deepEqual(payload.changes[0].changedBy, []);
});
