import { test } from 'node:test';
import assert from 'node:assert/strict';
import { append, verifyChain, EVENT } from '../src/lib/ledger.js';
import { consume, evaluate, SIG_STATE } from '../src/lib/signatures.js';
import { FakeStore } from './signature-fake-store.js';

const ev = (i) => ({
  eventId: `evt-${i}`,
  actorAccountId: `acct-${i % 7}`,
  eventType: EVENT.SIGNATURE_CREATED,
  issueId: 10000 + i,
  payload: { n: i, note: 'concurrent append' }
});

test('sequential appends form a verifiable chain', async () => {
  const store = new FakeStore();
  for (let i = 0; i < 50; i++) await append(store, ev(i));
  const res = await verifyChain(store);
  assert.equal(res.ok, true);
  assert.equal(res.checked, 50);
  assert.equal(res.terminalSeq, 50);
});

test('CONCURRENT appends do not fork the chain', async () => {
  // Fire 40 appends simultaneously against a store that
  // yields between read and write so the appends interleave.
  const store = new FakeStore({ latency: 1 });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => append(store, ev(i)))
  );

  assert.ok(store.duplicateCollisions > 0,
    'the race test must produce duplicate-key collisions');

  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1),
    'every append got a unique, gapless seq');

  const res = await verifyChain(store);
  assert.equal(res.ok, true, `chain broke: ${JSON.stringify(res)}`);
  assert.equal(res.checked, 40);
  // The guarantee is bounded progress, not zero contention: with N simultaneous
  // writers the last one must walk past the N-1 slots the others took. So
  // attempts <= N is correct behaviour. Starvation would be a FailClosed throw,
  // which Promise.all above would have surfaced.
  const maxAttempts = Math.max(...results.map((r) => r.attempts));
  const totalAttempts = results.reduce((a, r) => a + r.attempts, 0);
  assert.ok(maxAttempts <= 40, `unbounded contention: ${maxAttempts} attempts`);
  console.log(`      -> ${store.duplicateCollisions} collisions, worst writer ${maxAttempts} attempts, mean ${(totalAttempts / 40).toFixed(1)}, chain intact`);
});

test('tampering with a payload is detected', async () => {
  const store = new FakeStore();
  for (let i = 0; i < 10; i++) await append(store, ev(i));
  const victim = store.entries.get(5);
  victim.payload = JSON.stringify({ n: 5, note: 'quietly rewritten' });
  const res = await verifyChain(store);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ENTRY_ALTERED');
  assert.equal(res.brokenAt, 5);
});

test('deleting an entry is detected as a gap', async () => {
  const store = new FakeStore();
  for (let i = 0; i < 10; i++) await append(store, ev(i));
  store.entries.delete(7);
  const res = await verifyChain(store);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'SEQUENCE_GAP');
});

test('a signature can be consumed exactly once under concurrency', async () => {
  const store = new FakeStore({ latency: 1 });
  const now = Date.now();
  store.putSignature({
    approval_id: 'sig-1', state: SIG_STATE.PENDING,
    expires_at: now + 60_000, content_hash: 'a'.repeat(64)
  });

  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => consume(store, { approvalId: 'sig-1', now }))
  );
  const winners = attempts.filter((a) => a.consumed).length;
  assert.equal(winners, 1, `expected exactly one winner, got ${winners}`);
  assert.equal(store.signatures.get('sig-1').state, SIG_STATE.CONSUMED);
});

test('evaluate() denies on every non-allow path', () => {
  const now = Date.now();
  const hash = 'a'.repeat(64);
  const base = { approval_id: 's', state: SIG_STATE.PENDING, expires_at: now + 1000, content_hash: hash };

  assert.equal(evaluate({ candidate: null, now, currentContentHash: hash }).reason, 'NO_PENDING_SIGNATURE');
  assert.equal(evaluate({ candidate: { ...base, state: SIG_STATE.CONSUMED }, now, currentContentHash: hash }).reason, 'NO_PENDING_SIGNATURE');
  assert.equal(evaluate({ candidate: { ...base, expires_at: now - 1 }, now, currentContentHash: hash }).reason, 'SIGNATURE_EXPIRED');
  assert.equal(evaluate({ candidate: base, now, currentContentHash: 'b'.repeat(64) }).reason, 'CONTENT_CHANGED');
  assert.equal(evaluate({ candidate: base, now, currentContentHash: hash }).allow, true);
});

test('ledger failure that is not a duplicate key fails closed', async () => {
  const store = new FakeStore();
  store.insertEntry = async () => { throw new Error('connection reset'); };
  await assert.rejects(() => append(store, ev(0)), (e) => e.reason === 'LEDGER_UNAVAILABLE');
});

test('no writer is refused at 100-way concurrency', async () => {
  // Well beyond any realistic signing burst. Proves the bound is progress, not luck.
  const store = new FakeStore({ latency: 0 });
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => append(store, ev(i)))
  );
  assert.equal(results.length, 100);
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1));
  const res = await verifyChain(store);
  assert.equal(res.ok, true, JSON.stringify(res));
  const worst = Math.max(...results.map((r) => r.attempts));
  console.log(`      -> 100 concurrent appends, worst writer ${worst} attempts, chain verified`);
});

test('append respects its wall-clock deadline and fails closed', async () => {
  // A validator holding a Jira transition open must not block indefinitely.
  const store = new FakeStore();
  store.insertEntry = async () => { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; };
  store.entryAt = async (seq) => ({ seq, entry_hash: 'f'.repeat(64) });
  const started = Date.now();
  await assert.rejects(
    () => append(store, ev(0), { deadlineMs: 100 }),
    (e) => e.reason === 'LEDGER_UNAVAILABLE'
  );
  assert.ok(Date.now() - started < 1500, 'deadline not enforced');
});
