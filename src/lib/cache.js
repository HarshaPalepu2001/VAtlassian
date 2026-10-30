import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Cache repeated Forge SQL reads within one invocation.
 *
 * withRequestCache() enters an AsyncLocalStorage context at each Forge entry
 * point, including resolvers, triggers, scheduled jobs, the gate validator and
 * restore worker. Each context owns a Map. The first memo() call for a key
 * stores fn's Promise; later calls in that invocation reuse the same Promise.
 *
 * A module-level Map can survive warm-container reuse and return stale
 * configuration or gate data from an earlier invocation or installation.
 * AsyncLocalStorage isolates each invocation without requiring every caller
 * to include a tenant ID. @forge/resolver supplies fresh installContext and
 * accountId values on each call.
 *
 * panel:getState reads va_config, va_controlled_field and
 * va_controlled_transition repeatedly during snapshot() and getState().
 * Memoisation reduces each repeated read to one per invocation. Concurrent
 * invocations still have separate caches and still perform their own reads.
 *
 * Usage:
 *   import { memo, withRequestCache, getCacheStats } from '../lib/cache.js';
 *   export const handler = (...args) => withRequestCache(() => realHandler(...args));
 *   const result = await memo(`config:site`, () => getConfig('site'));
 *   const { hits, misses, evictions } = getCacheStats();
 */

const _storage = new AsyncLocalStorage();
// Only reachable from code that runs outside any withRequestCache() boundary
// (e.g. a test that calls a store function directly). Never populated in
// production, where every entry point opens its own scope first.
const _fallback = newScope();

// A miss is POST_EVICTION when the key was cached earlier in this scope and
// its promise rejected; every other miss is a COLD first read.
function newScope() {
  return { map: new Map(), evicted: new Set(), stats: { hits: 0, misses: 0, evictions: 0, coldMisses: 0, postEvictionMisses: 0 } };
}

function currentScope() {
  return _storage.getStore() ?? _fallback;
}

function currentCache() {
  return currentScope().map;
}

/**
 * Run `fn` with a fresh, isolated memo cache for its entire async call tree.
 * Call this once at each Forge entry point, wrapping the real handler. A call
 * nested inside an existing scope (a resolver's own wrapper under
 * wrapWithHarness) joins that scope, so one invocation has one cache.
 *
 * When the outermost scope settles, one `[CACHE_TELEMETRY]` line is logged
 * with its counters and rates (denominator: hits + misses), tagged with
 * `label` when given. A scope that never touched the cache logs nothing.
 */
export function withRequestCache(fn, { label } = {}) {
  if (_storage.getStore()) return fn();
  const scope = newScope();
  const result = _storage.run(scope, fn);
  return Promise.resolve(result).finally(() => logCacheTelemetry(scope.stats, label));
}

function logCacheTelemetry(stats, label) {
  const { hits, misses, evictions } = stats;
  const totalOps = hits + misses;
  if (totalOps === 0) return;
  const rate = n => Number((n / totalOps).toFixed(4));
  console.log('[CACHE_TELEMETRY]', JSON.stringify({
    label, ...stats, totalOps, hitRate: rate(hits), missRate: rate(misses), evictionRate: rate(evictions)
  }));
}

/**
 * Return the cached result for `key`, or call `fn()`, cache its Promise, and
 * return that. `fn` must return a Promise (or be async). A rejected promise
 * is evicted so a transient failure doesn't stay cached for the rest of the
 * invocation.
 *
 * @template T
 * @param {string} key    - Stable, unique string key for this result.
 * @param {() => Promise<T>} fn - Factory called at most once per invocation.
 * @returns {Promise<T>}
 */
export function memo(key, fn) {
  const scope = currentScope();
  const cache = scope.map;
  if (cache.has(key)) {
    scope.stats.hits++;
    return cache.get(key);
  }
  scope.stats.misses++;
  if (scope.evicted.has(key)) scope.stats.postEvictionMisses++;
  else scope.stats.coldMisses++;
  const promise = fn();
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) {
      cache.delete(key);
      scope.evicted.add(key);
      scope.stats.evictions++;
    }
  });
  return promise;
}

/**
 * Return this scope's running hit, miss and eviction counters. Hits reuse a
 * cached Promise; misses invoke fn. A rejected cached Promise increments the
 * eviction counter when removed. Each withRequestCache() starts new counters.
 */
export function getCacheStats() {
  const { hits, misses, evictions } = currentScope().stats;
  return { hits, misses, evictions };
}

/**
 * Evict one entry for tests that reset state between calls. Production code
 * must not call this function.
 */
export function _evict(key) {
  currentCache().delete(key);
}

/**
 * Wipe the entire cache. Exposed for tests only.
 */
export function _clear() {
  currentCache().clear();
}
