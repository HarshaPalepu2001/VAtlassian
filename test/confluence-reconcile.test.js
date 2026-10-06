import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * CONFLUENCE DRIFT, FROM EVENT TO RECORD.
 *
 * An edit to a protected page reaches jobs/confluenceReconcile.js through the
 * confluence-reconcile queue. The trigger pushed its job without the `body`
 * Forge queues require (so every push threw), the consumer read the job from
 * the wrong place, and reconcile read as a user that a trigger or consumer
 * does not have. These run the real trigger, consumer and adapter; only
 * Forge and storage are replaced.
 */
const modules = {
  'db/confluenceStore.js': ['getSubjectState', 'setSubjectState', 'getWorkingCopy', 'setWorkingCopy', 'deleteWorkingCopy'],
  'db/vaultStore.js': ['getVaultSiteBySpaceId'],
  'db/store.js': ['throwing', 'auditStore'],
  'db/objectStore.js': ['objectStore'],
  'lib/db.js': ['executeQuery'],
  'lib/ledger.js': ['append', 'EVENT']
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    if (specifier === '@forge/events') return { url: 'fixture:events', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s, ...v) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '');
      export const routeFromAbsolute = s => s;
      export default {
        asUser: () => globalThis.vaConfluence.asUser(),
        asApp: () => ({ requestConfluence: (...a) => globalThis.vaConfluence.request(...a) })
      };` };
    if (url === 'fixture:events') return { format: 'module', shortCircuit: true, source: `
      export class Queue {
        constructor({ key }) { this.key = key; }
        async push(event) {
          // What @forge/events' validatePushEvents requires of every event.
          if (!event || typeof event.body !== 'object' || event.body === null) throw new Error('InvalidPayloadError: body');
          globalThis.vaConfluence.pushed.push({ key: this.key, event });
          return { jobId: 'job-1' };
        }
      }` };
    const names = modules[url.slice(8)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = new Proxy(function () {}, {
        apply: (_t, _s, a) => globalThis.vaConfluence.${n}(...a),
        get: (_t, p) => globalThis.vaConfluence.${n}?.[p] });`).join('\n') };
    return next(url, context);
  }
});
const { run: onConfluenceEvent } = await import('../src/triggers/confluence-event.js');
const { handler: reconcileJob } = await import('../src/jobs/confluenceReconcile.js');
// Kept for the whole file: the trigger and the adapter import lazily, at call time.
test.after(() => hooks.deregister());

function fixture({ state = 'PROTECTED', liveBody = '<p>edited</p>' } = {}) {
  const f = {
    pushed: [], states: [], rows: [], writes: [],
    asUser: () => { throw new Error('No user in a background invocation'); },
    getSubjectState: async () => state ? { subject_id: 'p1', state } : null,
    setSubjectState: async (id, product, type, next) => { f.states.push([id, next]); },
    executeQuery: async (sql, params) => { f.rows.push([sql, params]); return { result: true, data: [] }; },
    throwing: async () => [{ content_hash: 'h1' }],
    objectStore: { get: async () => Buffer.from(JSON.stringify({ body: '<p>approved</p>', title: 'Spec', restrictions: [] })) },
    auditStore: {},
    append: async () => {},
    EVENT: { DRIFT_DETECTED: 'DRIFT_DETECTED' },
    request: async url => ({ ok: true, status: 200, json: async () => String(url).includes('/restriction/')
      ? { results: [] }
      : { id: 'p1', title: 'Spec', version: { number: 4 }, body: { storage: { value: liveBody } } } })
  };
  globalThis.vaConfluence = f;
  return f;
}

const userEdit = { atlassianId: 'user-1', eventType: 'avi:confluence:updated:page', page: { id: 'p1', type: 'page' } };

test('a user edit to a protected page is queued for reconcile under the body Forge requires', async () => {
  const f = fixture();
  await onConfluenceEvent(userEdit, {});
  assert.deepEqual(f.pushed.map(p => [p.key, p.event.body]),
    [['confluence-reconcile', { contentId: 'p1', contentType: 'page', eventType: 'avi:confluence:updated:page' }]]);
});

test('an edit to content the app does not govern queues and records nothing', async () => {
  const f = fixture({ state: null });
  await onConfluenceEvent(userEdit, {});
  assert.deepEqual(f.pushed, []);
  assert.deepEqual(f.rows, [], 'no event row for every page on the site');
});

test('the reconcile job reads its content from the queued body, as the app, and records drift', async () => {
  const f = fixture();
  await reconcileJob({ body: { contentId: 'p1', contentType: 'page', eventType: 'avi:confluence:updated:page' } }, {});
  assert.deepEqual(f.states, [['p1', 'DRIFTED']]);
});

test('a reconciled page that still matches its baseline stays protected', async () => {
  const f = fixture({ liveBody: '<p>approved</p>' });
  await reconcileJob({ body: { contentId: 'p1', contentType: 'page' } }, {});
  assert.deepEqual(f.states, [['p1', 'PROTECTED']]);
});

test('a page whose restriction could not be set is not recorded as protected', async () => {
  const { protectPage } = await import('../src/usecases/confluence.js');
  const f = fixture({ state: null });
  f.throwing = async (sql, params) => { f.writes.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return []; };
  f.objectStore = { set: async () => {} };
  // The viewer may read the page but not change who can edit it.
  f.asUser = () => ({ requestConfluence: async (url, options = {}) => options.method === 'POST' && String(url).includes('/restriction')
    ? { ok: false, status: 403, json: async () => ({}) }
    : f.request(url, options) });

  const result = await protectPage({ payload: { pageId: 'p1' }, context: { accountId: 'user-1' } });

  assert.equal(result.success, false);
  assert.deepEqual(f.states, [], 'the page is not shown as protected');
  assert.deepEqual(f.writes, [], 'no baseline or approval is recorded for it');
});
