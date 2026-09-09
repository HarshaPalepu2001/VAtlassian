/**
 * Per-invocation memo cache for Forge SQL reads.
 *
 * WHAT IT IS. A plain Map that lives in module scope for the lifetime of one
 * Forge function invocation. The first call for a given key executes `fn` and
 * stores the resulting Promise; every subsequent call for the same key returns
 * that same Promise without touching the database again.
 *
 * WHY IT'S SAFE. Forge functions are single-request. Each invocation starts in
 * a fresh V8 context (or at least a fresh module-import chain), so this Map is
 * empty at the start of every request and is garbage-collected when the
 * function exits. There is no cross-request bleed and no need for TTL,
 * invalidation, or size limits.
 *
 * WHY IT MATTERS. A single `panel:getState` call reads `va_config` (twice for
 * projectConfig), `va_controlled_field`, and `va_controlled_transition`
 * multiple times during snapshot() + getState(). When ten panels load
 * concurrently those same rows are fetched ten times each — identical reads
 * that hit Forge SQL's per-installation rate limit. Memoising them within a
 * single invocation collapses those repeated reads to one.
 *
 * USAGE:
 *   import { memo } from '../lib/cache.js';
 *   const result = await memo(`config:site`, () => getConfig('site'));
 */

const _cache = new Map();

/**
 * Return the cached result for `key`, or call `fn()`, cache its Promise, and
 * return that. `fn` must return a Promise (or be async).
 *
 * @template T
 * @param {string} key    - Stable, unique string key for this result.
 * @param {() => Promise<T>} fn - Factory called at most once per invocation.
 * @returns {Promise<T>}
 */
export function memo(key, fn) {
  if (_cache.has(key)) return _cache.get(key);
  const promise = fn();
  _cache.set(key, promise);
  return promise;
}

/**
 * Evict a single entry. Use only in tests that need to reset state between
 * calls — production code should never call this.
 */
export function _evict(key) {
  _cache.delete(key);
}

/**
 * Wipe the entire cache. Exposed for tests only.
 */
export function _clear() {
  _cache.clear();
}
