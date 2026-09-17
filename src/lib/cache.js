import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-invocation memo cache for Forge SQL reads.
 *
 * WHAT IT IS. A Map, scoped to one Forge function invocation via
 * AsyncLocalStorage, entered by withRequestCache() at every Forge entry point
 * (resolvers, triggers, scheduled jobs, the gate validator, the restore
 * worker). The first call for a given key executes `fn` and stores the
 * resulting Promise; every subsequent call for the same key within the same
 * invocation returns that same Promise without touching the database again.
 *
 * WHY THIS NEEDS A BOUNDARY, NOT JUST MODULE SCOPE. A Forge function (e.g.
 * `panel-resolver`) is deployed once and shared by every installation of the
 * app across every Jira site, the same way one AWS Lambda function serves all
 * its callers. The platform reuses warm execution environments across
 * invocations for performance — module-level state such as a plain
 * `new Map()` therefore is NOT guaranteed to be empty at the start of a
 * request, and a stale entry can leak a previous installation's config or
 * gate data into the current one's response. `context.installContext` /
 * `context.accountId` are re-injected fresh by `@forge/resolver` on every
 * call, which is the platform's own tell that nothing else is.
 * AsyncLocalStorage gives each invocation an isolated Map regardless of
 * container reuse, without needing a tenant id threaded through every call
 * site.
 *
 * WHY IT MATTERS OTHERWISE. A single `panel:getState` call reads `va_config`
 * (twice for projectConfig), `va_controlled_field`, and `va_controlled_transition`
 * multiple times during snapshot() + getState(). When ten panels load
 * concurrently those same rows are fetched ten times each — identical reads
 * that hit Forge SQL's per-installation rate limit. Memoising them within a
 * single invocation collapses those repeated reads to one.
 *
 * USAGE:
 *   import { memo, withRequestCache } from '../lib/cache.js';
 *   export const handler = (...args) => withRequestCache(() => realHandler(...args));
 *   const result = await memo(`config:site`, () => getConfig('site'));
 */

const _storage = new AsyncLocalStorage();
// Only reachable from code that runs outside any withRequestCache() boundary
// (e.g. a test that calls a store function directly). Never populated in
// production, where every entry point opens its own scope first.
const _fallback = new Map();

function currentCache() {
  return _storage.getStore() ?? _fallback;
}

/**
 * Run `fn` with a fresh, isolated memo cache for its entire async call tree.
 * Call this once at each Forge entry point, wrapping the real handler.
 */
export function withRequestCache(fn) {
  return _storage.run(new Map(), fn);
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
  const cache = currentCache();
  if (cache.has(key)) return cache.get(key);
  const promise = fn();
  cache.set(key, promise);
  promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  return promise;
}

/**
 * Evict a single entry. Use only in tests that need to reset state between
 * calls — production code should never call this.
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
