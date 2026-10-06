// What the live drift check says about ITSELF. The gate, the signing form and the
// panel header all hold an item on baselineDrift(); when they disagree with the
// panel's own diff, the only way to tell why is for the check to report which
// fields it flagged, and whether it could read the baseline at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineDrift, logLiveDrift } from '../src/lib/liveDrift.js';
import { project, FIELD_KIND } from '../src/lib/content.js';
import { scopeFromIssue } from '../src/lib/trackedFields.js';

const declared = [
  { field_id: 'summary', field_kind: FIELD_KIND.SCALAR, store_values: true },
  { field_id: 'priority', field_kind: FIELD_KIND.SCALAR, store_values: true }
];
const fields = { summary: 'Child task', priority: { id: '2', name: 'High' } };
const digestsOf = issueFields => project(issueFields, scopeFromIssue({ declared, issueFields }).fields).digests;
const treeBaseline = { tree_hash: 'h', baseline_id: 'b', version: 5, issue_type_id: '10004', field_digests: '{}' };

function captureWarn(fn) {
  const originalWarn = console.warn;
  const lines = [];
  console.warn = line => lines.push(String(line));
  return Promise.resolve(fn(lines)).finally(() => { console.warn = originalWarn; });
}

test('a clean tree baseline reports where its digests came from', async () => {
  const result = await baselineDrift({ baseline: treeBaseline, issueId: 10, issueFields: fields, declared,
    readRootDigests: async () => JSON.stringify(digestsOf(fields)) });
  assert.deepEqual(result.changed, []);
  assert.equal(result.diagnostics.digestSource, 'root-node');
  assert.equal(result.diagnostics.baselineReadable, true);
  assert.equal(result.diagnostics.cause, null);
  assert.equal(result.diagnostics.baselineVersion, 5);
  assert.equal(result.diagnostics.baselineIssueTypeId, '10004');
});

test('root digests that are missing are named as the cause, not hidden behind a field list', async () => {
  const result = await baselineDrift({ baseline: treeBaseline, issueId: 10, issueFields: fields, declared,
    readRootDigests: async () => null });
  assert.deepEqual(result.changed, ['summary', 'priority']);
  assert.equal(result.diagnostics.digestSource, 'root-node-missing>baseline-row');
  assert.equal(result.diagnostics.baselineReadable, false);
  assert.equal(result.diagnostics.cause, 'BASELINE_UNREADABLE');
  assert.equal(result.diagnostics.baselineKeyCount, 0);
  assert.equal(result.diagnostics.scopeFieldCount, 2);
});

test('a root digest read that throws keeps its message', async () => {
  const result = await baselineDrift({ baseline: treeBaseline, issueId: 10, issueFields: fields, declared,
    readRootDigests: async () => { throw new Error('db down'); } });
  assert.ok(result.changed.length > 0);
  assert.equal(result.diagnostics.digestSource, 'root-node-error>baseline-row');
  assert.equal(result.diagnostics.rootDigestError, 'db down');
  assert.equal(result.diagnostics.cause, 'BASELINE_UNREADABLE');
});

test('an edited field is listed with short baseline and current digests, never values', async () => {
  const baseline = { field_digests: digestsOf(fields), version: 2, issue_type_id: '10004' };
  const edited = { ...fields, summary: 'Edited after approval' };
  const result = await baselineDrift({ baseline, issueFields: edited, declared });
  assert.deepEqual(result.changed, ['summary']);
  assert.equal(result.diagnostics.cause, 'DIGEST_MISMATCH');
  assert.equal(result.diagnostics.digestSource, 'baseline-row');
  const [entry] = result.diagnostics.fields;
  assert.equal(entry.field, 'summary');
  assert.equal(entry.baseline.length, 10);
  assert.equal(entry.current.length, 10);
  assert.notEqual(entry.baseline, entry.current);
  assert.ok(!JSON.stringify(result.diagnostics).includes('Edited after approval'), 'no field value leaves the check');
});

test('no baseline is not an unreadable baseline', async () => {
  const result = await baselineDrift({ baseline: null, issueFields: fields, declared });
  assert.deepEqual(result.changed, []);
  assert.equal(result.diagnostics.cause, null);
});

test('logLiveDrift names the surface, the issue type and the flagged fields when something is flagged', async () => {
  const comparison = await baselineDrift({ baseline: treeBaseline, issueId: 10, issueFields: fields, declared,
    readRootDigests: async () => null });
  await captureWarn(lines => {
    logLiveDrift('gate', { issueKey: 'VAT-41', issueTypeId: '10007', comparison });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[HARNESS:DRIFT\] drift:live/);
    const json = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
    assert.equal(json.surface, 'gate');
    assert.equal(json.issueKey, 'VAT-41');
    assert.equal(json.issueTypeId, '10007');
    assert.equal(json.baselineIssueTypeId, '10004');
    assert.equal(json.typeChangedSinceBaseline, true);
    assert.equal(json.cause, 'BASELINE_UNREADABLE');
    assert.deepEqual(json.changed, ['summary', 'priority']);
  });
});

test('logLiveDrift is silent when nothing is flagged', async () => {
  const comparison = await baselineDrift({ baseline: { field_digests: digestsOf(fields) }, issueFields: fields, declared });
  await captureWarn(lines => {
    logLiveDrift('gate', { issueKey: 'VAT-41', issueTypeId: '10004', comparison });
    assert.equal(lines.length, 0);
  });
});

// ─── A child that is the root of its own tree ───────────────────────────────
//
// lib/tree/jira.js reads a tree's root with its Jira parent set to null: that
// parent lies outside the tree. So a child re-baselined on its own (a drift
// decision on it) records parent = null, while the issue still has its parent.
// Comparing the live parent against that null made one field drift forever, and
// no new baseline could clear it — each one recorded null again.
const withParent = [...declared, { field_id: 'parent', field_kind: FIELD_KIND.SCALAR, store_values: true }];
const childFields = { ...fields, parent: { id: '44007', key: 'VAT-40' } };
const digestsWith = issueFields => project(issueFields, scopeFromIssue({ declared: withParent, issueFields }).fields).digests;
const rootedAlone = { tree_hash: 'h', baseline_id: 'b', issue_id: 44008, captured_by_baseline_id: null, version: 6, issue_type_id: '10007', field_digests: '{}' };

test('a child that is the root of its own tree is not drifted by the parent its baseline never recorded', async () => {
  const result = await baselineDrift({ baseline: rootedAlone, issueId: 44008, issueFields: childFields, declared: withParent,
    readRootDigests: async () => digestsWith({ ...fields, parent: null }) });
  assert.deepEqual(result.changed, []);
  assert.equal(result.diagnostics.parentTreatedAsOutsideTree, true);
});

test('the same child still drifts on every other field', async () => {
  const result = await baselineDrift({ baseline: rootedAlone, issueId: 44008,
    issueFields: { ...childFields, summary: 'Edited' }, declared: withParent,
    readRootDigests: async () => digestsWith({ ...fields, parent: null }) });
  assert.deepEqual(result.changed, ['summary']);
});

test('a child inside its parent\'s tree keeps its parent as a tracked field', async () => {
  const inTree = { ...rootedAlone, captured_by_baseline_id: 'parent-baseline' };
  const same = await baselineDrift({ baseline: inTree, issueId: 44008, issueFields: childFields, declared: withParent,
    readRootDigests: async () => digestsWith(childFields) });
  assert.deepEqual(same.changed, []);
  assert.equal(same.diagnostics.parentTreatedAsOutsideTree, false);
  const moved = await baselineDrift({ baseline: inTree, issueId: 44008,
    issueFields: { ...childFields, parent: { id: '99999', key: 'VAT-99' } }, declared: withParent,
    readRootDigests: async () => digestsWith(childFields) });
  assert.deepEqual(moved.changed, ['parent']);
});

test('a flat baseline is untouched by the root rule', async () => {
  const flat = { field_digests: digestsWith(childFields), issue_id: 44008, captured_by_baseline_id: null };
  const result = await baselineDrift({ baseline: flat, issueId: 44008, issueFields: childFields, declared: withParent });
  assert.deepEqual(result.changed, []);
  const moved = await baselineDrift({ baseline: flat, issueId: 44008,
    issueFields: { ...childFields, parent: { id: '99999' } }, declared: withParent });
  assert.deepEqual(moved.changed, ['parent']);
});
