import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceLinkStore } from '../src/testmgmt/sourceLinkStore.js';

const VID = 'a'.repeat(32), TOKEN = 'b'.repeat(32), HASH = 'c'.repeat(64);
const receipt = { seq: 14, entryHash: HASH };
const intent = { versionId: VID, testIssueId: '11', projectId: '100', versionNo: 3, digest: HASH, typeId: '10',
  desired: ['42'], previous: ['41'], previousVersionId: 'd'.repeat(32), previousDigest: 'e'.repeat(64), createdAt: 1000 };
const record = { version_id: VID, test_issue_id: 11, project_id: 100, version_no: 3, content_hash: HASH, type_id: '10',
  desired_sources: '["42"]', prior_sources: '["41"]', prior_version_id: 'd'.repeat(32), prior_digest: 'e'.repeat(64),
  state: 'COMMITTED', problem: null, audit_seq: 14, audit_hash: HASH, created_at: 1000 };
function world() {
  const calls = []; const responses = [];
  const store = createSourceLinkStore(async (sql, params) => { calls.push({ sql, params }); return responses.shift() ?? { result: true, data: { affectedRows: 1 } }; });
  return { store, calls, answer: (...values) => responses.push(...values) };
}
const ok = data => ({ result: true, data });
const dup = { result: false, error: { context: { debug: { code: 'ER_DUP_ENTRY' } } } };

test('outbox insert is idempotent without replacing existing signed intent or receipt', async () => {
  const w = world();
  assert.equal(await w.store.insertSourceLinkIntent(intent), true);
  w.answer(dup);
  assert.equal(await w.store.insertSourceLinkIntent({ ...intent, desired: ['99'] }), false);
  assert.ok(w.calls.every(call => /^INSERT INTO tm_source_link_outbox/.test(call.sql)));
  assert.equal(w.calls[0].params[6], '["42"]');
  assert.equal(w.calls[0].params[8], intent.previousVersionId);
  w.answer({ result: false, error: { code: 'UNAVAILABLE' } });
  await assert.rejects(w.store.insertSourceLinkIntent(intent), { reason: 'SERVICE_UNAVAILABLE' });
});

test('committed outbox read preserves the exact audit receipt and immutable signed ancestry', async () => {
  const w = world(); w.answer(ok([record]), ok([record]));
  const stored = await w.store.readSourceLinkIntent(VID);
  assert.deepEqual(stored.proof, receipt); assert.deepEqual(stored.desired, ['42']); assert.deepEqual(stored.previous, ['41']);
  assert.equal(stored.testIssueId, '11'); assert.equal(stored.previousVersionId, intent.previousVersionId);
  assert.deepEqual(await w.store.latestCommittedSourceLinks('11'), stored);
  assert.match(w.calls[1].sql, /state = 'COMMITTED'[\s\S]*ORDER BY version_no DESC LIMIT 1/);
});

test('only audit-confirmed commits can carry receipts and terminal receipts cannot be overwritten or demoted', async () => {
  const w = world();
  await assert.rejects(w.store.setSourceLinkIntentState(VID, 'COMMITTED', null, { seq: 0, entryHash: HASH }), { reason: 'LEDGER_UNAVAILABLE' });
  await assert.rejects(w.store.setSourceLinkIntentState(VID, 'COMMITTED', null, { seq: 1, entryHash: 'bad' }), { reason: 'LEDGER_UNAVAILABLE' });
  assert.equal(w.calls.length, 0);
  assert.equal(await w.store.setSourceLinkIntentState(VID, 'COMMITTED', null, receipt), true);
  assert.deepEqual(w.calls[0].params.slice(0, 4), ['COMMITTED', null, receipt.seq, receipt.entryHash]);
  w.answer(ok({ affectedRows: 0 }), ok({ affectedRows: 0 }));
  assert.equal(await w.store.setSourceLinkIntentState(VID, 'BLOCKED', 'SOURCE_LINK_DRIFT'), false);
  assert.equal(await w.store.setSourceLinkIntentState(VID, 'COMMITTED', null, { seq: 99, entryHash: 'f'.repeat(64) }), false);
  for (const call of w.calls) assert.match(call.sql, /WHERE version_id = \? AND state IN \('PENDING', 'BLOCKED'\)/);
  await assert.rejects(w.store.setSourceLinkIntentState(VID, 'PENDING', null, receipt), { reason: 'INVALID_INPUT' });
});

test('lease claims use an expiry compare-and-swap and token-scoped ownership and release', async () => {
  const w = world();
  assert.equal(await w.store.claimSourceLinkLease('11', TOKEN, 1000), true);
  assert.deepEqual(w.calls[0].params, [11, TOKEN, 181000]);
  w.answer(dup, ok({ affectedRows: 0 }));
  assert.equal(await w.store.claimSourceLinkLease('11', TOKEN, 181000), false);
  assert.match(w.calls[2].sql, /expires_at <= \?/);
  assert.deepEqual(w.calls[2].params, [TOKEN, 361000, 11, 181000]);
  w.answer(ok([{ token: TOKEN }]), ok({ affectedRows: 0 }));
  assert.equal(await w.store.ownsSourceLinkLease('11', TOKEN, 181000), true);
  assert.match(w.calls[3].sql, /token = \? AND expires_at > \?/);
  await w.store.releaseSourceLinkLease('11', TOKEN);
  assert.match(w.calls[4].sql, /WHERE test_issue_id = \? AND token = \?/); assert.deepEqual(w.calls[4].params, [11, TOKEN]);
  await assert.rejects(w.store.claimSourceLinkLease('11', TOKEN, Infinity), { reason: 'INVALID_INPUT' });
});

test('latest prior intent includes partial states and is bounded strictly before the requested version', async () => {
  const w = world();
  assert.equal(typeof w.store.latestSourceLinkIntent, 'function');
  w.answer(ok([{ ...record, version_no: 2, state: 'BLOCKED', audit_seq: null, audit_hash: null }]));
  const prior = await w.store.latestSourceLinkIntent('11', { beforeVersionNo: 3 });
  assert.equal(prior.state, 'BLOCKED'); assert.equal(prior.proof, null);
  assert.match(w.calls[0].sql, /test_issue_id = \? AND version_no < \?[\s\S]*ORDER BY version_no DESC LIMIT 1/);
  assert.doesNotMatch(w.calls[0].sql, /state\s*=/); assert.deepEqual(w.calls[0].params, [11, 3]);
  await assert.rejects(w.store.latestSourceLinkIntent('11', { beforeVersionNo: 0 }), { reason: 'INVALID_INPUT' });
});

test('pending reconciliation lists are explicitly bounded, ordered and never include terminal receipts', async () => {
  const w = world(); w.answer(ok([{ version_id: VID }]));
  assert.deepEqual(await w.store.pendingSourceLinkIntents(2), [VID]);
  assert.match(w.calls[0].sql, /state IN \('PENDING', 'BLOCKED'\)[\s\S]*ORDER BY updated_at, version_id LIMIT 2$/);
  assert.doesNotMatch(w.calls[0].sql, /LIMIT \?/);
  assert.deepEqual(w.calls[0].params, []);
  await assert.rejects(w.store.pendingSourceLinkIntents(21), { reason: 'INVALID_INPUT' });
  await assert.rejects(w.store.pendingSourceLinkIntents(0), { reason: 'INVALID_INPUT' });
  w.answer({ result: false, error: { message: 'DB down' } });
  await assert.rejects(w.store.pendingSourceLinkIntents(2), { reason: 'SERVICE_UNAVAILABLE' });
});
