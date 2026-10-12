import test from 'node:test';
import assert from 'node:assert/strict';
import { EDIT_STATUS, editStatusFor, observationColumns, observationOf } from '../src/lib/observation.js';
import { recordDrift, driftForIssueVersions, markDecided } from '../src/db/driftStore.js';
import { observationFor, actorFor } from '../src/lib/collect.js';

const unknownColumn = () => Object.assign(new Error("Unknown column 'observed_at' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });

test('only a matching Jira history item makes an edit confirmed', () => {
  assert.equal(editStatusFor({ changelogId: '10101', historyComplete: false }), EDIT_STATUS.CONFIRMED);
  assert.equal(editStatusFor({ changelogId: null, historyComplete: true }), EDIT_STATUS.UNATTRIBUTED);
  assert.equal(editStatusFor({ changelogId: null, historyComplete: false }), EDIT_STATUS.HISTORY_UNAVAILABLE);
});

test('the event user is recorded as what triggered the check, and an edit time only when confirmed', () => {
  assert.deepEqual(observationColumns({ changelogId: null, attributionAt: 5, historyComplete: true,
    detectedVia: 'EVENT', actorAccountId: 'event-user', now: 900 }), {
    observed_at: 900, trigger_kind: 'EVENT', trigger_account_id: 'event-user',
    edit_status: 'UNATTRIBUTED', edited_at: null, changelog_id: null
  });
  assert.equal(observationColumns({ changelogId: '7', attributionAt: 5, historyComplete: true,
    detectedVia: 'EVENT', actorAccountId: 'event-user', now: 900 }).edited_at, 5);
});

test('a row with provenance columns is decoded from them; the editor comes only with a confirmed edit', () => {
  const base = { occurred_at: 50, detected_via: 'EVENT', actor_account_id: 'x', actor_name: 'X', changelog_id: null };
  assert.deepEqual(observationOf({ ...base, edit_status: 'UNATTRIBUTED', observed_at: 60, trigger_kind: 'EVENT',
    trigger_account_id: 'y', edited_at: null }), {
    observedAt: 60, trigger: { kind: 'EVENT', accountId: 'y' },
    edit: { status: 'UNATTRIBUTED', editorAccountId: null, editorName: null, editedAt: null, changelogId: null }
  });
  assert.deepEqual(observationOf({ ...base, changelog_id: '9', edit_status: 'CONFIRMED', observed_at: 60,
    trigger_kind: 'RECONCILE', trigger_account_id: null, edited_at: 40 }).edit,
  { status: 'CONFIRMED', editorAccountId: 'x', editorName: 'X', editedAt: 40, changelogId: '9' });
});

test('a row written before the provenance columns is decoded for what it is', () => {
  const confirmed = observationOf({ occurred_at: 40, detected_via: 'RECONCILE', actor_account_id: 'x',
    actor_name: 'X', changelog_id: '9' });
  assert.equal(confirmed.edit.status, 'CONFIRMED');
  assert.equal(confirmed.edit.editedAt, 40);
  assert.equal(confirmed.observedAt, null, 'when it was observed was never recorded');
  const seen = observationOf({ occurred_at: 70, detected_via: 'EVENT', actor_account_id: 'event-user',
    actor_name: null, changelog_id: null });
  assert.deepEqual(seen, { observedAt: 70, trigger: { kind: 'EVENT', accountId: 'event-user' },
    edit: { status: 'UNATTRIBUTED', editorAccountId: null, editorName: null, editedAt: null, changelogId: null } });
});

const drift = () => ({ issue_id: 1, project_id: 2, baseline_id: Buffer.alloc(16, 3), baseline_version: 4,
  field_id: 'summary', field_name: 'Summary', from_digest: null, to_digest: null, from_repr: 'a', to_repr: 'b',
  actor_account_id: 'x', actor_name: 'X', occurred_at: 50, changelog_id: null, detected_via: 'EVENT',
  source: 'HUMAN', materiality: 'MAJOR', observed_at: 60, trigger_kind: 'EVENT', trigger_account_id: 'x',
  edit_status: 'UNATTRIBUTED', edited_at: null });

test('a drift row carries its provenance columns, and never the draft editor column', async () => {
  const queries = [];
  const result = await recordDrift(drift(), async (sql, params) => { queries.push({ sql, params }); return []; });
  assert.equal(result.inserted, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /observed_at, trigger_kind, trigger_account_id, edit_status, edited_at\)/);
  assert.doesNotMatch(queries[0].sql, /editor_account_id/);
  assert.equal((queries[0].sql.match(/\?/g) ?? []).length, queries[0].params.length);
});

test('before the provenance columns exist, a drift row is still recorded with the legacy columns', async () => {
  const queries = [];
  const result = await recordDrift(drift(), async (sql, params) => {
    queries.push({ sql, params });
    if (/observed_at/.test(sql)) throw unknownColumn();
    return [];
  });
  assert.equal(result.inserted, true);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].sql, /observed_at/);
  assert.equal((queries[1].sql.match(/\?/g) ?? []).length, queries[1].params.length);
});

test('before the provenance columns exist, drift is still read, and decoded as legacy', async () => {
  const queries = [];
  const { rows } = await driftForIssueVersions([{ issueId: 1, version: 4 }], async (sql, params) => {
    queries.push(sql);
    if (/observed_at/.test(sql)) throw unknownColumn();
    return [{ drift_id: 'AAAA', baseline_id: null, approval_id: null, occurred_at: 70, detected_via: 'EVENT',
      actor_account_id: 'event-user', changelog_id: null }];
  });
  assert.equal(queries.length, 2);
  assert.equal(rows[0].observation.edit.status, 'UNATTRIBUTED');
  assert.equal(rows[0].actor_account_id, 'event-user', 'legacy properties stay for today\'s readers');
});

test('collector: unmatched change after truncated read is marked HISTORY_UNAVAILABLE', () => {
  const result = observationFor({ changelogId: null, attribution: null, failed: false, truncated: true,
    detectedVia: 'EVENT', actorAccountId: 'actor-id', now: 900 });
  assert.equal(result.edit_status, 'HISTORY_UNAVAILABLE');
  assert.equal(result.edited_at, null);
  assert.equal(result.observed_at, 900);
  assert.equal(result.trigger_kind, 'EVENT');
  assert.equal(result.trigger_account_id, 'actor-id');
});

test('collector: unmatched change after failed read is marked HISTORY_UNAVAILABLE', () => {
  const result = observationFor({ changelogId: null, attribution: null, failed: true, truncated: true,
    detectedVia: 'RECONCILE', actorAccountId: null, now: 800 });
  assert.equal(result.edit_status, 'HISTORY_UNAVAILABLE');
  assert.equal(result.edited_at, null);
});

test('collector: unmatched change after complete read is marked UNATTRIBUTED', () => {
  const result = observationFor({ changelogId: null, attribution: null, failed: false, truncated: false,
    detectedVia: 'EVENT', actorAccountId: 'trigger-user', now: 700 });
  assert.equal(result.edit_status, 'UNATTRIBUTED');
  assert.equal(result.edited_at, null);
  assert.equal(result.observed_at, 700);
});

test('collector: matched change is marked CONFIRMED with edit details', () => {
  const result = observationFor({ changelogId: '10101', attribution: { at: 40 }, failed: false, truncated: false,
    detectedVia: 'EVENT', actorAccountId: 'trigger-user', now: 900 });
  assert.equal(result.edit_status, 'CONFIRMED');
  assert.equal(result.edited_at, 40);
  assert.equal(result.observed_at, 900);
  assert.equal(result.trigger_kind, 'EVENT');
  assert.equal(result.trigger_account_id, 'trigger-user');
});

test('a decision settles every undecided observation of the version it decided', async () => {
  const calls = [];
  const approvalId = Buffer.alloc(16, 5);
  // The shape every caller passes (usecases/drift.js, usecases/restoreActions.js, jobs/restoreWorker.js).
  const settled = await markDecided({ issueId: 1, baselineVersion: 4, approvalId }, async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { result: true, data: { affectedRows: 2 } };
  });
  assert.equal(settled, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql,
    'UPDATE va_drift SET approval_id = FROM_BASE64(?) WHERE issue_id = ? AND baseline_version = ? AND approval_id IS NULL');
  assert.deepEqual(calls[0].params, [approvalId.toString('base64'), 1, 4]);
});

test('collector: a confirmed edit names its Jira author, never the event user', () => {
  assert.deepEqual(actorFor({ changelogId: '10101', attribution: { authorId: 'editor', authorName: 'Editor' },
    actorAccountId: 'event-user' }), { actor_account_id: 'editor', actor_name: 'Editor' });
  assert.deepEqual(actorFor({ changelogId: '10101', attribution: { at: 40 }, actorAccountId: 'event-user' }),
    { actor_account_id: null, actor_name: null }, 'a history item with no author names nobody');
});

test('collector: an unmatched change keeps the event user as its actor, as before', () => {
  assert.deepEqual(actorFor({ changelogId: null, attribution: null, actorAccountId: 'event-user' }),
    { actor_account_id: 'event-user', actor_name: null });
  assert.deepEqual(actorFor({ changelogId: null, attribution: null, actorAccountId: undefined }),
    { actor_account_id: null, actor_name: null });
});
