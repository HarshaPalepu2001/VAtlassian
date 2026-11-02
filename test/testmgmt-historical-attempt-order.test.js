import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportStore } from '../src/testmgmt/reportStore.js';
const runId = 'a'.repeat(32), testDigest = 'b'.repeat(64), chainDigest = 'c'.repeat(64);
const row = { run_id: runId, execution_issue_id: 12, project_id: 100, test_issue_id: 11, test_version_id: 'd'.repeat(32), test_digest: testDigest, chain_digest: chainDigest,
  steps: '[]', state: 'SIGNED', result: 'PASSED', created_by: 'human', revision: 1 };
function store({ eventSequence = 10, actor = 'human', missing = false } = {}) {
  const queries = [];
  const api = createReportStore({ query: async (sql, params) => {
    queries.push(sql);
    if (sql.includes('FROM tm_run')) return { result: true, data: [row] };
    if (sql.includes('FROM tm_attempt_clock')) return { result: true, data: [{ last_sequence: 21, legacy_cutoff: 20 }] };
    if (sql.includes('FROM va_audit') && sql.startsWith('SELECT')) return { result: true, data: missing ? [] : [{ seq: eventSequence, entry_hash: 'e'.repeat(64), event_id_hex: 'f'.repeat(32), actor_account_id: actor, issue_id: 12, payload: JSON.stringify({ runId, testIssueId: '11', versionId: row.test_version_id, testDigest, chainDigest }) }] };
    return { result: true, data: { affectedRows: 1 } };
  } });
  return { api, queries };
}
test('historical ordering derives only from matching durable creation audit without rewriting signed rows', async () => {
  const { api, queries } = store();
  const result = await api.readRunsForExecutionComplete('12');
  assert.equal(result.records[0].attemptSequence, 10);
  assert.equal(result.records[0].attemptOrderProof.kind, 'HISTORICAL_CREATION_AUDIT');
  assert.equal(result.records[0].evidenceSchema, null);
  assert.ok(queries.every(sql => !/UPDATE\s+tm_run/i.test(sql)));
});
test('missing mismatched or post-cutover creation audit leaves historical ordering unproved', async () => {
  for (const options of [{ missing: true }, { actor: 'other' }, { eventSequence: 30 }]) {
    const { api } = store(options);
    const result = await api.readRunsForExecutionComplete('12');
    assert.equal(result.records[0].attemptSequence, null);
  }
});
