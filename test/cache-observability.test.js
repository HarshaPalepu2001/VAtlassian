import test from 'node:test';
import assert from 'node:assert/strict';
import { memo, withRequestCache, getCacheStats } from '../src/lib/cache.js';

test('a hit increments only hits', async () => {
  await withRequestCache(async () => {
    await memo('k', async () => 'v');
    await memo('k', async () => 'v');
    assert.deepEqual(getCacheStats(), { hits: 1, misses: 1, evictions: 0 });
  });
});

test('a miss increments only misses', async () => {
  await withRequestCache(async () => {
    await memo('a', async () => 1);
    await memo('b', async () => 2);
    assert.deepEqual(getCacheStats(), { hits: 0, misses: 2, evictions: 0 });
  });
});

test('a rejected in-flight promise increments only evictions, and a retry after eviction is a fresh miss', async () => {
  await withRequestCache(async () => {
    let calls = 0;
    await assert.rejects(() => memo('fails', async () => {
      calls++;
      throw new Error('transient');
    }));
    // memo() evicts on the microtask after rejection; wait for it to settle.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(getCacheStats(), { hits: 0, misses: 1, evictions: 1 });

    await assert.rejects(() => memo('fails', async () => {
      calls++;
      throw new Error('transient again');
    }));
    assert.equal(calls, 2, 'eviction must let the next call re-invoke fn()');
    // Wait for the second rejection's own eviction microtask too.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(getCacheStats(), { hits: 0, misses: 2, evictions: 2 });
  });
});

test('counts reset to zero for a fresh withRequestCache scope', async () => {
  await withRequestCache(async () => {
    await memo('x', async () => 1);
    await memo('x', async () => 1);
  });
  await withRequestCache(async () => {
    assert.deepEqual(getCacheStats(), { hits: 0, misses: 0, evictions: 0 });
    await memo('y', async () => 1);
    assert.deepEqual(getCacheStats(), { hits: 0, misses: 1, evictions: 0 });
  });
});

test('counts are isolated between overlapping concurrent scopes', async () => {
  const barrier = { resolve: null, promise: null };
  barrier.promise = new Promise(resolve => { barrier.resolve = resolve; });

  const scopeA = withRequestCache(async () => {
    await memo('shared-key', async () => 'a');
    await memo('shared-key', async () => 'a'); // hit
    await barrier.promise; // hold the scope open while scope B runs
    return getCacheStats();
  });

  const scopeB = withRequestCache(async () => {
    await memo('shared-key', async () => 'b');
    await memo('shared-key', async () => 'b'); // hit
    await memo('shared-key', async () => 'b'); // hit
    const stats = getCacheStats();
    barrier.resolve();
    return stats;
  });

  const [statsA, statsB] = await Promise.all([scopeA, scopeB]);
  assert.deepEqual(statsA, { hits: 1, misses: 1, evictions: 0 });
  assert.deepEqual(statsB, { hits: 2, misses: 1, evictions: 0 });
});

test('getCacheStats() outside any scope returns zeros and does not throw', () => {
  // Node's test runner gives each test file its own module instance, so the
  // module-level fallback this reads has not been touched by any test above
  // (every one of them runs inside withRequestCache()).
  assert.deepEqual(getCacheStats(), { hits: 0, misses: 0, evictions: 0 });
});
