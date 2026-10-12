import test from 'node:test';
import assert from 'node:assert/strict';
import { project, FIELD_KIND } from '../src/lib/content.js';
import { compareBaselineSnapshots, recordSnapshot } from '../src/lib/baselineVersions.js';

const fields = [
  { field_id: 'description', field_name: 'Description', field_kind: FIELD_KIND.ADF, store_values: true, materiality: 'MAJOR' },
  { field_id: 'attachment', field_name: 'Attachments', field_kind: FIELD_KIND.ATTACHMENTS, store_values: true, materiality: 'MAJOR' },
  { field_id: 'customfield_5', field_name: 'New requirement', field_kind: FIELD_KIND.TEXT, store_values: true, materiality: 'MAJOR' }
];
const doc = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const saved = (version, values, scoped = fields, issueId = 10) => {
  const projection = project(values, scoped);
  return { baseline: { version, issue_id: issueId, transition_at: version * 1000,
    approved_name: `Reviewer ${version}`, field_digests: JSON.stringify(projection.digests) },
    nodes: [{ logicalNodeId: 'root', originalIssueId: issueId, currentIssueId: issueId,
      issueKey: 'T-10', parentLogicalNodeId: null, fieldDigests: JSON.stringify(projection.digests) }],
    values: { root: projection.raw } };
};

test('record snapshot reads tree root values and only fields actually signed in that version', () => {
  const old = saved(1, { description: doc('First') }, fields.slice(0, 1));
  const result = recordSnapshot(old, fields);
  assert.deepEqual(result.fields.map(f => f.fieldId), ['description']);
  assert.match(result.fields[0].preview.text, /First/);
  assert.equal(result.retainedCount, 1);
});

test('comparison names newly tracked fields and shows their first saved value without inventing an older value', () => {
  const old = saved(1, { description: doc('First') }, fields.slice(0, 1));
  const next = saved(2, { description: doc('Second'), attachment: [{ id: '500', filename: 'proof.pdf', size: 4096 }], customfield_5: 'New clause' });
  const result = compareBaselineSnapshots(old, next, fields);
  const description = result.fields.find(f => f.rawFieldId === 'description');
  const attachment = result.fields.find(f => f.rawFieldId === 'attachment');
  const added = result.fields.find(f => f.rawFieldId === 'customfield_5');
  assert.ok(description.blocks.some(b => b.op !== 'equal'));
  assert.equal(attachment.scopeChange, 'ADDED');
  assert.equal(attachment.added[0].filename, 'proof.pdf');
  assert.equal(attachment.added[0].id, '500');
  assert.equal(added.scopeChange, 'ADDED');
  assert.equal(added.after, 'New clause');
  assert.equal(added.before, null);
});

test('same-name file replacement is an add and removal with each file identity', () => {
  const old = saved(1, { attachment: [{ id: '500', filename: 'proof.pdf', size: 4096 }] }, fields.slice(1, 2));
  const next = saved(2, { attachment: [{ id: '501', filename: 'proof.pdf', size: 8192 }] }, fields.slice(1, 2));
  const result = compareBaselineSnapshots(old, next, fields);
  assert.deepEqual(result.fields[0].removed.map(a => a.id), ['500']);
  assert.deepEqual(result.fields[0].added.map(a => a.id), ['501']);
});

test('comparison reports digest-only changes honestly and uses historical node scope', () => {
  const digestOnly = [{ field_id: 'customfield_5', field_name: 'New requirement', field_kind: FIELD_KIND.TEXT, store_values: false }];
  const old = saved(1, { customfield_5: 'old' }, digestOnly);
  const next = saved(2, { customfield_5: 'new' }, digestOnly);
  const result = compareBaselineSnapshots(old, next, fields);
  assert.equal(result.fields[0].retained, false);
  assert.equal(result.fields[0].before, null);
  assert.equal(result.fields[0].after, null);
});

test('comparison includes descendant and structural changes, with no false edit attribution', () => {
  const old = saved(1, { description: doc('Same') }, fields.slice(0, 1));
  const next = saved(2, { description: doc('Same') }, fields.slice(0, 1));
  const oldChild = saved(1, { customfield_5: 'A' }, fields.slice(2), 11);
  const nextChild = saved(2, { customfield_5: 'B' }, fields.slice(2), 11);
  old.nodes.push({ ...oldChild.nodes[0], logicalNodeId: 'child', parentLogicalNodeId: 'root', issueKey: 'T-11' });
  old.values.child = oldChild.values.root;
  next.nodes.push({ ...nextChild.nodes[0], logicalNodeId: 'child', parentLogicalNodeId: 'root', issueKey: 'T-11' });
  next.values.child = nextChild.values.root;
  const result = compareBaselineSnapshots(old, next, fields);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].issueKey, 'T-11');
  assert.equal(result.fields[0].attributionStatus, 'NOT_COLLECTED');
  next.nodes.pop();
  delete next.values.child;
  const removed = compareBaselineSnapshots(old, next, fields);
  assert.match(removed.fields[0].fieldName, /Removed work item/);
});

test('a newly added work item shows its saved fields, not only its key', () => {
  const before = saved(1, { description: doc('Root') }, fields.slice(0, 1));
  const after = saved(2, { description: doc('Root') }, fields.slice(0, 1));
  const child = saved(2, { customfield_5: 'New child clause' }, fields.slice(2), 11);
  after.nodes.push({ ...child.nodes[0], logicalNodeId: 'child', parentLogicalNodeId: 'root', issueKey: 'T-11' });
  after.values.child = child.values.root;
  const result = compareBaselineSnapshots(before, after, fields);
  assert.ok(result.fields.some(field => field.scopeChange === 'NODE_ADDED'));
  const requirement = result.fields.find(field => field.rawFieldId === 'customfield_5');
  assert.equal(requirement.scopeChange, 'ADDED');
  assert.equal(requirement.after, 'New child clause');
});

test('saved ADF still compares in blocks when current metadata calls the field text', () => {
  const historical = [{ field_id: 'customfield_5', field_name: 'Criteria', field_kind: FIELD_KIND.ADF, store_values: true }];
  const current = [{ ...historical[0], field_kind: FIELD_KIND.TEXT }];
  const before = saved(1, { customfield_5: doc('Old') }, historical);
  const after = saved(2, { customfield_5: doc('New') }, historical);
  const result = compareBaselineSnapshots(before, after, current);
  assert.equal(result.fields[0].kind, 'adf');
  assert.ok(result.fields[0].blocks.some(block => block.op !== 'equal'));
});

test('comparison populates valueLabels for priority, issue type, attachments and media UUIDs', () => {
  const customFields = [
    { field_id: 'priority', field_name: 'Priority', field_kind: FIELD_KIND.SCALAR, store_values: true },
    { field_id: 'issuetype', field_name: 'Issue Type', field_kind: FIELD_KIND.SCALAR, store_values: true },
    { field_id: 'attachment', field_name: 'Attachments', field_kind: FIELD_KIND.ATTACHMENTS, store_values: true }
  ];
  const old = saved(1, {
    priority: { id: '3', name: 'Medium' },
    issuetype: { id: '10001', name: 'Task' },
    attachment: [{ id: '500', filename: 'Salesforce CDC POC.png', mediaId: 'uuid-1234' }]
  }, customFields);
  const next = saved(2, {
    priority: { id: '1', name: 'Critical' },
    issuetype: { id: '10002', name: 'Bug' },
    attachment: [{ id: '501', filename: 'architecture.pdf', mediaId: 'uuid-5678' }]
  }, customFields);
  const result = compareBaselineSnapshots(old, next, customFields);
  const priorityDiff = result.fields.find(f => f.rawFieldId === 'priority');
  const issueTypeDiff = result.fields.find(f => f.rawFieldId === 'issuetype');
  const attachmentDiff = result.fields.find(f => f.rawFieldId === 'attachment');

  assert.equal(priorityDiff.valueLabels['3'], 'Medium');
  assert.equal(priorityDiff.valueLabels['1'], 'Critical');
  assert.equal(issueTypeDiff.valueLabels['10001'], 'Task');
  assert.equal(issueTypeDiff.valueLabels['10002'], 'Bug');
  assert.equal(attachmentDiff.valueLabels['500'], 'Salesforce CDC POC.png');
  assert.equal(attachmentDiff.valueLabels['uuid-1234'], 'Salesforce CDC POC.png');
  assert.equal(attachmentDiff.valueLabels['501'], 'architecture.pdf');
  assert.equal(attachmentDiff.valueLabels['uuid-5678'], 'architecture.pdf');
});

