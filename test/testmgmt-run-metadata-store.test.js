import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../lib/db.js' && context.parentURL.endsWith('/testmgmt/store.js')) return { url: 'tm-run-metadata:db', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'tm-run-metadata:db') return { format: 'module', shortCircuit: true, source: 'export const executeQuery=(...args)=>globalThis.tmRunMetadataQuery(...args);' };
  return next(url, context);
} });
const store = await import('../src/testmgmt/store.js'); hooks.deregister();
const id = 'a'.repeat(32);
test('every inserted attempt receives a server sequence before any build metadata exists', async () => {
  const calls = []; globalThis.tmRunMetadataQuery = async (sql, params) => { calls.push({ sql, params }); return { result: true, data: sql.includes('FROM tm_attempt_clock') ? [{ last_sequence: '53' }] : sql.startsWith('SELECT') ? [{ attempt_sequence: '54' }] : { affectedRows: 1 } }; };
  const run = { runId: id, executionIssueId: '12', projectId: '100', testIssueId: '11', testVersionId: 'b'.repeat(32), steps: [], chain: {}, createdAt: 1000, createdBy: 'human', creationEventId: 'c'.repeat(32) };
  assert.equal(await store.insertRun(run), true);
  assert.equal(run.attemptSequence, 54); assert.equal(run.evidenceSchema, 2);
  assert.ok(calls.some(c => /UPDATE tm_attempt_clock SET last_sequence = \? WHERE clock_id = 1 AND last_sequence = \?/.test(c.sql)), 'globally ordered CAS avoids per-node sequence caches');
  const insertion = calls.find(c => /INSERT INTO tm_run \(/.test(c.sql));
  assert.match(insertion.sql, /attempt_sequence/); assert.ok(insertion.params.includes(54));
});
test('old run reads retain missing metadata as null and are never converted to schema 2', async () => {
  globalThis.tmRunMetadataQuery = async () => ({ result: true, data: [{ run_id: id, project_id: 100, execution_issue_id: 12, test_issue_id: 11, created_at: 1, updated_at: 1 }] });
  const run = await store.readRun(id);
  assert.equal(run.evidenceSchema, null); assert.equal(run.attemptSequence, null); assert.equal(run.provenance, null);
});
