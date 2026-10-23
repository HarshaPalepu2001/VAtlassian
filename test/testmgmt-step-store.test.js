import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../lib/db.js' && context.parentURL.endsWith('/testmgmt/store.js')) return { url: 'tm-step-store:db', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'tm-step-store:db') return { format: 'module', shortCircuit: true,
    source: 'export const executeQuery=(...args)=>globalThis.tmStepQuery(...args);' };
  return next(url, context);
} });
const store = await import('../src/testmgmt/store.js'); hooks.deregister();

const runId = 'a'.repeat(32), eventId = 'b'.repeat(32);
const runRow = (over = {}) => ({ run_id: runId, execution_issue_id: 12, project_id: 100, test_issue_id: 11, test_version_id: 'c'.repeat(32),
  test_digest: 'd'.repeat(64), chain: '{"steps":[]}', state: 'IN_PROGRESS', result: 'PASSED', steps: '[{"id":"s1","status":"PASSED"}]',
  revision: 5, created_at: 1, updated_at: 1_000, step_event_id: eventId, step_prior: '{"steps":[{"id":"s1","status":"FAILED"}],"result":"FAILED"}', ...over });

function db(handler) {
  const calls = [];
  globalThis.tmStepQuery = async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); };
  return calls;
}

test('a step change is written as pending, and never over another pending change', async () => {
  const calls = db(() => ({ result: true, data: { affectedRows: 1 } }));
  assert.equal(await store.updateRunSteps({ runId, expectedRevision: 4, steps: [], result: 'NOT_RUN', now: 9, eventId, prior: { steps: [], result: null } }), true);
  assert.match(calls[0].sql, /step_event_id = \?, step_prior = \?/);
  assert.match(calls[0].sql, /AND step_event_id IS NULL/);
  assert.deepEqual(calls[0].params.slice(3, 5), [eventId, '{"steps":[],"result":null}']);
});

test('no run is frozen or closed while a step change is pending', async () => {
  const calls = db(() => ({ result: true, data: { affectedRows: 0 } }));
  assert.equal(await store.setRunState({ runId, from: 'IN_PROGRESS', to: 'SIGNING', expectedRevision: 5, frozenDigest: 'e'.repeat(64), now: 9 }), false);
  assert.match(calls[0].sql, /AND step_event_id IS NULL/);
});

test('settling confirms a pending change only from its exact audit event', async () => {
  const calls = db(sql => {
    if (sql.startsWith('SELECT * FROM tm_run')) return { result: true, data: [runRow()] };
    if (sql.includes('FROM va_audit')) return { result: true, data: [{ payload: JSON.stringify({ runId, revision: 5 }), issue_id: 12 }] };
    return { result: true, data: { affectedRows: 1 } };
  });
  assert.equal(await store.settleRunSteps(runId, { now: 2_000 }), true);
  assert.match(calls.at(-1).sql, /SET step_event_id = NULL, step_prior = NULL WHERE run_id = \? AND step_event_id = \?/);
  assert.ok(!calls.some(c => /SET steps = \?/.test(c.sql)), 'a confirmed change keeps its results');
});

test('an audit event for a different revision is refused, not taken as proof', async () => {
  db(sql => {
    if (sql.startsWith('SELECT * FROM tm_run')) return { result: true, data: [runRow()] };
    return { result: true, data: [{ payload: JSON.stringify({ runId, revision: 4 }), issue_id: 12 }] };
  });
  await assert.rejects(store.settleRunSteps(runId, { now: 2_000 }), { reason: 'CONTENT_CHANGED' });
});

test('with no audit event, a recent change waits and an abandoned one restores the prior results', async () => {
  let calls = db(sql => sql.startsWith('SELECT * FROM tm_run') ? { result: true, data: [runRow()] }
    : sql.includes('FROM va_audit') ? { result: true, data: [] } : { result: true, data: { affectedRows: 1 } });
  assert.equal(await store.settleRunSteps(runId, { now: 2_000 }), false);
  assert.ok(!calls.some(c => c.sql.startsWith('UPDATE')));
  calls = db(sql => sql.startsWith('SELECT * FROM tm_run') ? { result: true, data: [runRow()] }
    : sql.includes('FROM va_audit') ? { result: true, data: [] } : { result: true, data: { affectedRows: 1 } });
  assert.equal(await store.settleRunSteps(runId, { now: 1_000 + 5 * 60_000 + 1 }), true);
  const restore = calls.at(-1);
  assert.match(restore.sql, /SET steps = \?, result = \?, revision = revision \+ 1/);
  assert.deepEqual(restore.params.slice(0, 2), ['[{"id":"s1","status":"FAILED"}]', 'FAILED']);
  assert.equal(restore.params.at(-1), eventId);
});
