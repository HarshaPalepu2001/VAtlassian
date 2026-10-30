import test from 'node:test';
import assert from 'node:assert/strict';
import { memo, withRequestCache, getCacheStats } from '../src/lib/cache.js';
import { wrapWithHarness } from '../src/lib/harnessLogger.js';

async function telemetryLines(run) {
  const lines = [];
  const original = console.log;
  console.log = (tag, body) => { if (tag === '[CACHE_TELEMETRY]') lines.push(JSON.parse(body)); };
  try { await run(); } finally { console.log = original; }
  return lines;
}

test('one telemetry line per scope, with rates over hits + misses and miss causes', async () => {
  const lines = await telemetryLines(() => withRequestCache(async () => {
    await memo('config:site', async () => 1);
    await memo('config:site', async () => 1);
    await memo('flaky', () => Promise.reject(new Error('transient'))).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    await memo('flaky', async () => 2);
  }, { label: 'panel:getState' }));

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    label: 'panel:getState', hits: 1, misses: 3, evictions: 1, coldMisses: 2, postEvictionMisses: 1,
    totalOps: 4, hitRate: 0.25, missRate: 0.75, evictionRate: 0.25
  });
});

test('a scope that never touches the cache logs nothing', async () => {
  const lines = await telemetryLines(() => withRequestCache(async () => 'done'));
  assert.deepEqual(lines, []);
});

test('a nested withRequestCache joins the outer scope and logs once', async () => {
  const lines = await telemetryLines(() => withRequestCache(async () => {
    await memo('k', async () => 1);
    await withRequestCache(async () => {
      await memo('k', async () => 1);
      assert.deepEqual(getCacheStats(), { hits: 1, misses: 1, evictions: 0 });
    });
  }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].hits, 1);
});

test('the resolver harness labels the telemetry line with resolver and function key', async () => {
  const handler = wrapWithHarness(async () => memo('k', async () => ({ ok: true })), { resolverName: 'panel' });
  const original = console.info;
  console.info = () => {};
  try {
    const lines = await telemetryLines(() => handler({ call: { functionKey: 'panel:getState' }, payload: {}, context: {} }));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].label, 'panel:panel:getState');
  } finally { console.info = original; }
});
