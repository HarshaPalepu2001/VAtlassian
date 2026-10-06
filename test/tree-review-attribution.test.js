import test from 'node:test';
import assert from 'node:assert/strict';
import { withStoredAttribution } from '../src/lib/tree/reviewAttribution.js';
import { driftForIssueVersions } from '../src/db/driftStore.js';

test('a descendant field receives recorded actor, time, and detection provenance', () => {
  const original = { fields: [{ fieldId: 'child:summary', rawFieldId: 'summary',
    group: { kind: 'ISSUE', issueId: 100, baselineVersion: 6, isRoot: false, issueKey: 'T-100' },
    attribution: [], attributionStatus: 'NOT_COLLECTED' }], groups: [] };
  const result = withStoredAttribution(original, [{ issue_id: 100, baseline_version: 6, field_id: 'summary',
    actor_name: 'Sam', actor_account_id: 'sam', occurred_at: 2000, source: 'USER', detected_via: 'EVENT', key: 'drift-1' }]);
  assert.equal(result.fields[0].lastChangedBy, 'Sam');
  assert.equal(result.fields[0].lastChangedAt, 2000);
  assert.equal(result.fields[0].attributionStatus, 'AVAILABLE');
  assert.equal(result.fields[0].attribution[0].detected, false);
  assert.deepEqual(result.fields[0].driftIds, ['drift-1']);
  assert.deepEqual(result.groups[0].fields, result.fields);
});

test('a sweep timestamp is explicitly a detection, not a claimed edit time', () => {
  const original = { fields: [{ fieldId: 'child:attachment', rawFieldId: 'attachment',
    group: { kind: 'ISSUE', issueId: 100, baselineVersion: 6, isRoot: false, issueKey: 'T-100' },
    attribution: [], attributionStatus: 'NOT_COLLECTED' }] };
  const result = withStoredAttribution(original, [{ issue_id: 100, baseline_version: 6, field_id: 'attachment',
    actor_name: null, occurred_at: 3000, source: 'UNKNOWN', detected_via: 'SWEEP', key: 'drift-2' }]);
  assert.equal(result.fields[0].attribution[0].detected, true);
  assert.equal(result.fields[0].lastChangedBy, null);
  assert.equal(result.fields[0].lastChangedAt, null);
});

test('reconciliation with a Jira changelog records the actual editor and edit time', () => {
  const original = { fields: [{ fieldId: 'child:summary', rawFieldId: 'summary',
    group: { kind: 'ISSUE', issueId: 100, baselineVersion: 6, isRoot: false, issueKey: 'T-100' },
    attribution: [], attributionStatus: 'NOT_COLLECTED' }] };
  const result = withStoredAttribution(original, [{ issue_id: 100, baseline_version: 6, field_id: 'summary',
    actor_name: 'Sam', actor_account_id: 'sam', occurred_at: 2000, source: 'USER',
    detected_via: 'RECONCILE', changelog_id: 'history-1' }]);
  assert.equal(result.fields[0].attribution[0].detected, false);
  assert.equal(result.fields[0].lastChangedBy, 'Sam');
  assert.equal(result.fields[0].lastChangedAt, 2000);
});

test('batch drift read is restricted to requested issue and version pairs', async () => {
  let sql, params;
  await driftForIssueVersions([{ issueId: 100, version: 6 }, { issueId: 101, version: 2 }], async (statement, values) => {
    sql = statement; params = values; return [];
  });
  assert.match(sql, /issue_id = \? AND baseline_version = \?/);
  assert.match(sql, /approval_id IS NULL/);
  assert.deepEqual(params, [100, 6, 101, 2]);
});
