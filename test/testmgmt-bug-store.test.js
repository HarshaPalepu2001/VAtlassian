import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../lib/db.js' && context.parentURL.endsWith('/testmgmt/bugStore.js')) return { url: 'tm-bug-store:db', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'tm-bug-store:db') return { format: 'module', shortCircuit: true,
    source: 'export const executeQuery=(...args)=>globalThis.tmBugQuery(...args);' };
  return next(url, context);
} });
const store = await import('../src/testmgmt/bugStore.js'); hooks.deregister();
const runId = '1'.repeat(32);
test('legacy duplicate defect assignments cannot appear exclusive by reading only their first row', async () => {
  globalThis.tmBugQuery = async () => ({ result: true, data: [{ run_id: runId, issue_id: 50, state: 'CREATED' },
    { run_id: '2'.repeat(32), issue_id: 50, state: 'CREATED' }] });
  const associated = await store.readBugByIssue('50');
  assert.equal(associated.conflict, true);
  assert.notEqual(associated.runId, runId);
});
test('an exclusive claim is idempotent only for the same issue and run', async () => {
  const claims = new Map();
  globalThis.tmBugQuery = async (sql, [issueId, claimedRun, now]) => {
    if (sql.startsWith('INSERT')) {
      if (claims.has(issueId) || [...claims.values()].includes(claimedRun)) return { result: false, error: { code: 'ER_DUP_ENTRY' } };
      claims.set(issueId, claimedRun); return { result: true, data: { affectedRows: 1 } };
    }
    return { result: true, data: [...claims.entries()].filter(([id, run]) => id === issueId || run === claimedRun)
      .map(([id, run]) => ({ issue_id: id, run_id: run })) };
  };
  assert.equal(await store.claimBugIssue({ runId, issueId: '50', now: 1 }), true);
  assert.equal(await store.claimBugIssue({ runId, issueId: '50', now: 2 }), true);
  assert.equal(await store.claimBugIssue({ runId: '2'.repeat(32), issueId: '50', now: 3 }), false);
  assert.equal(await store.claimBugIssue({ runId, issueId: '51', now: 4 }), false);
});
test('the repair queue explicitly reports truncation', async () => {
  globalThis.tmBugQuery = async () => ({ result: true, data: Array.from({ length: 101 }, (_, i) => ({ run_id: String(i), issue_key: null, last_error: 'CREATE_ABSENCE_UNPROVEN' })) });
  const result = await store.listProjectBugRepairs('100'); assert.equal(result.items.length, 100); assert.equal(result.complete, false);
});
