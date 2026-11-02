import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeStore, INTAKE_MIGRATIONS } from '../src/testmgmt/intakeStore.js';
const rid = 'a'.repeat(32), tid = 'b'.repeat(32), gid = 'c'.repeat(32), runId = 'd'.repeat(32);
const result = (data = []) => ({ result: true, data });
function harness(handler) { const calls = []; return { calls, store: createIntakeStore({ query: async (sql, args) => { calls.push({ sql, args }); return handler(sql, args); } }) }; }

test('SQL migrations add nullable historical metadata and a global CAS attempt clock', () => {
  assert.ok(INTAKE_MIGRATIONS.some(m => /tm_attempt_clock/.test(m.sql)));
  assert.ok(!INTAKE_MIGRATIONS.some(m => /AUTO_INCREMENT/.test(m.sql)), 'cached per-node allocation cannot define chronological latest');
  assert.ok(INTAKE_MIGRATIONS.some(m => /ADD COLUMN.*attempt_sequence BIGINT NULL/.test(m.sql)));
  assert.ok(!INTAKE_MIGRATIONS.some(m => /UPDATE tm_run/.test(m.sql)), 'no historical metadata backfill');
});

test('reads fail closed on malformed receipt JSON or incomplete bounded receipt reads', async () => {
  let h = harness(() => result([{ receipt_id: rid, mappings: 'bad' }]));
  await assert.rejects(h.store.readIntakeReceipt(rid), { reason: 'RECORDS_INCOMPLETE' });
  h = harness(() => result(Array.from({ length: 101 }, () => ({}))));
  await assert.rejects(h.store.listIntakeReceipts('12'), { reason: 'RECORDS_INCOMPLETE' });
});

test('reservation and application SQL recheck token and grant revocation/expiry at the write', async () => {
  const h = harness(sql => result(sql.startsWith('SELECT') ? [{ intake_receipt_id: rid, intake_applied: 1 }] : { affectedRows: 1 }));
  await h.store.reserveIntakeRun({ runId, receiptId: rid, expectedRevision: 1, now: 900 });
  await h.store.applyIntakeRun({ runId, receiptId: rid, expectedRevision: 1, steps: [], result: 'PASSED', reportedBuild: {}, provenance: {}, now: 900 });
  for (const call of h.calls.filter(c => c.sql.startsWith('UPDATE tm_run'))) {
    assert.match(call.sql, /revoked_at IS NULL/); assert.match(call.sql, /expires_at > \?/); assert.ok(call.args.includes(900));
    assert.match(call.sql, /intake_receipt_id/); assert.match(call.sql, /state = 'IN_PROGRESS'/);
  }
});

test('a receipt is APPLIED only after every member progress write and valid audit proof', async () => {
  const h = harness(() => result({ affectedRows: 1 }));
  await assert.rejects(h.store.completeIntakeReceipt(rid, {}), { reason: 'LEDGER_UNAVAILABLE' });
  await h.store.completeIntakeReceipt(rid, { seq: 12, entryHash: 'f'.repeat(64) }, 900);
  assert.match(h.calls.at(-1).sql, /JSON_LENGTH/); assert.match(h.calls.at(-1).sql, /NOT EXISTS/);
  assert.match(h.calls.at(-1).sql, /audit_seq/);
});

test('receipt readiness lookup includes the original immutable mappings during partial member registration', async () => {
  const h = harness(() => result([])); await h.store.readIntakeForRun(runId);
  assert.match(h.calls[0].sql, /JSON_CONTAINS/); assert.ok(h.calls[0].args.includes(runId));
});

test('only one pending receipt may claim an execution and APPLIED releases its admission lock', async () => {
  const migration = INTAKE_MIGRATIONS.find(m => m.id === 'v180_tm_intake_receipt');
  assert.match(migration.sql, /open_execution_id BIGINT NULL/);
  assert.match(migration.sql, /UNIQUE KEY uq_tm_intake_open_execution \(open_execution_id\)/);
  const h = harness(() => result({ affectedRows: 1 }));
  await h.store.completeIntakeReceipt(rid, { seq: 12, entryHash: 'f'.repeat(64) }, 900);
  assert.match(h.calls.at(-1).sql, /open_execution_id = NULL/);
});
