import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../lib/db.js' && context.parentURL.endsWith('/testmgmt/retestStore.js')) return { url: 'tm-retest:db', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'tm-retest:db') return { format: 'module', shortCircuit: true, source: 'export const executeQuery=(...args)=>globalThis.tmRetestQuery(...args);' };
  return next(url, context);
} });
const store = await import('../src/testmgmt/retestStore.js').catch(() => ({})); hooks.deregister();
const requestId = 'a'.repeat(32), sourceRunId = 'b'.repeat(32), targetRunId = 'c'.repeat(32);
test('only one caller claims a prepared retest create', async () => {
  assert.equal(typeof store.transitionRetestIntent, 'function');
  let state = 'PREPARED';
  globalThis.tmRetestQuery = async (_sql, params) => { const success = state === params.at(-1); if (success) state = params[0];
    return { result: true, data: { affectedRows: success ? 1 : 0 } }; };
  const results = await Promise.all([1, 2].map(() => store.transitionRetestIntent(requestId, { from: 'PREPARED', to: 'CREATING', now: 1 })));
  assert.deepEqual(results.sort(), [false, true]);
});
test('retained child progress cannot be reassigned to a different run', async () => {
  assert.equal(typeof store.insertRetestRunLink, 'function');
  globalThis.tmRetestQuery = async sql => sql.startsWith('INSERT')
    ? { result: false, error: { code: 'ER_DUP_ENTRY' } } : { result: true, data: [{ target_run_id: 'd'.repeat(32) }] };
  await assert.rejects(store.insertRetestRunLink({ requestId, sourceRunId, targetRunId, now: 1 }));
});
test('a saved audit receipt is parsed with its attribution and content intact', async () => {
  assert.equal(typeof store.readRetestAuditEvent, 'function');
  globalThis.tmRetestQuery = async () => ({ result: true, data: [{ seq: 7, entry_hash: 'f'.repeat(64), event_type: 'TM_RETEST_REQUESTED',
    actor_account_id: 'tester', issue_id: 12, payload: JSON.stringify({ requestId }) }] });
  const receipt = await store.readRetestAuditEvent(requestId);
  assert.equal(receipt.eventType, 'TM_RETEST_REQUESTED'); assert.equal(receipt.actorAccountId, 'tester');
  assert.deepEqual(receipt.payload, { requestId }); assert.equal(receipt.seq, 7);
});
