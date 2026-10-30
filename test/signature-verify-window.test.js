/**
 * Windowed verification for jobs/verify.js.
 *
 * The daily job verifies WINDOW entries per invocation and resumes on its
 * next run. A bounded verification must report whether it stopped early
 * and where to resume. It must never report a partial window as proof of
 * the whole chain's integrity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { append, verifyChain, EVENT } from '../src/lib/ledger.js';
import { FakeStore } from './signature-fake-store.js';

const ev = (i) => ({
  eventId: `evt-${i}`,
  actorAccountId: `acct-${i % 5}`,
  eventType: EVENT.SIGNATURE_CREATED,
  issueId: 20000 + i,
  payload: { n: i }
});

async function ledgerOf(n) {
  const store = new FakeStore();
  for (let i = 0; i < n; i++) await append(store, ev(i));
  return store;
}

test('a bounded walk stops short and reports where to resume', async () => {
  const store = await ledgerOf(50);

  const res = await verifyChain(store, { maxEntries: 20 });

  assert.equal(res.ok, true);
  assert.equal(res.partial, true, 'a window that did not reach the tail must say so');
  assert.equal(res.checked, 20);
  assert.equal(res.nextSeq, 21);
  assert.equal(res.terminalSeq, undefined, 'a partial result must not claim a terminal seq');
});

test('resuming from nextSeq completes the chain across windows', async () => {
  const store = await ledgerOf(50);

  let from = 1;
  let total = 0;
  let last;
  for (let pass = 0; pass < 10; pass++) {
    last = await verifyChain(store, { from, maxEntries: 20 });
    assert.equal(last.ok, true);
    total += last.checked;
    if (!last.partial) break;
    from = last.nextSeq;
  }

  assert.equal(last.partial, undefined, 'the final window must reach the tail');
  assert.equal(last.terminalSeq, 50);
  assert.equal(total, 50, 'every entry checked exactly once across the pass');
});

test('a window smaller than the batch size is still respected', async () => {
  const store = await ledgerOf(50);

  // batchSize deliberately larger than maxEntries: the bound is on entries
  // checked, not on how many rows a read happens to return.
  const res = await verifyChain(store, { maxEntries: 7, batchSize: 500 });

  assert.equal(res.checked, 7);
  assert.equal(res.nextSeq, 8);
});

test('tampering inside the window is still caught', async () => {
  const store = await ledgerOf(50);

  const row = store.entries.get(12);
  store.entries.set(12, { ...row, payload: JSON.stringify({ n: 'edited' }) });

  const res = await verifyChain(store, { maxEntries: 20 });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ENTRY_ALTERED');
  assert.equal(res.brokenAt, 12);
});

test('tampering beyond the window is missed now and caught on the next pass', async () => {
  const store = await ledgerOf(50);

  const row = store.entries.get(40);
  store.entries.set(40, { ...row, payload: JSON.stringify({ n: 'edited' }) });

  // The first window cannot see it. This checks the detection-latency bound the
  // job header describes.
  const first = await verifyChain(store, { from: 1, maxEntries: 20 });
  assert.equal(first.ok, true);
  assert.equal(first.partial, true);

  const second = await verifyChain(store, { from: first.nextSeq, maxEntries: 20 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ENTRY_ALTERED');
  assert.equal(second.brokenAt, 40);
});

test('an unbounded walk is unchanged by the new option', async () => {
  const store = await ledgerOf(30);

  const res = await verifyChain(store);

  assert.equal(res.ok, true);
  assert.equal(res.partial, undefined);
  assert.equal(res.checked, 30);
  assert.equal(res.terminalSeq, 30);
});
