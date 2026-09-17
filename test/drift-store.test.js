import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnresolvedDrift } from '../src/db/driftStore.js';

test('hasUnresolvedDrift reports a pending drift row', async () => {
  const unresolved = await hasUnresolvedDrift(7, async () => ({ result: true, data: [{ one: 1 }] }));

  assert.equal(unresolved, true);
});

test('hasUnresolvedDrift checks every project for a site-wide policy', async () => {
  let captured;
  await hasUnresolvedDrift(null, async (sql, params) => {
    captured = { sql, params };
    return { result: true, data: [{ one: 1 }] };
  });
  assert.doesNotMatch(captured.sql, /project_id\s*=/);
  assert.deepEqual(captured.params, []);
});

test('hasUnresolvedDrift fails closed when its database read is unavailable', async () => {
  await assert.rejects(
    () => hasUnresolvedDrift(7, async () => ({ result: false, error: new Error('storage unavailable') })),
    /storage unavailable/
  );
});

test('hasUnresolvedDrift fails closed when storage returns no row collection', async () => {
  await assert.rejects(
    () => hasUnresolvedDrift(7, async () => ({ result: true, data: null })),
    /unreadable/
  );
});
