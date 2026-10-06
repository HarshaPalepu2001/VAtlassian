import test from 'node:test';
import assert from 'node:assert/strict';
import { writeVersionEvidence, readVersionEvidence, pinChildVersions, recordNodeSecurity, copyNodePins,
  isMissingSchema, clearVersionEvidence } from '../src/db/evidenceStore.js';

const d = c => c.repeat(64);
const fieldRow = { field_id: 'summary', label: 'Summary', label_source: 'CAPTURE', kind: 'TEXT', schema_type: 'string',
  materiality: 'MAJOR', store_values: true, restorable: null, digest: d('a'), required_by: '["k1"]' };
const ruleRow = { rule_key: 'k'.repeat(32), source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
  approvers: '[{"role":"REVIEWER","assurance":"ESIGNATURE"}]', controlled_fields_hash: d('h'),
  imposed_by_baseline_id: null, imposed_by_version: null };
const sigRow = { approval_id: Buffer.alloc(16, 1), signer_account_id: 'a', signer_name: 'A', role: 'REVIEWER',
  assurance: 'ESIGNATURE', cause: 'OWN_TRANSITION', cause_baseline_id: null, decision_id: null, transition_id: '31',
  from_status_id: '3', to_status_id: '4', transition_at: 1, status_at_capture: '3', fields_covered: '["summary"]', signed_at: 2 };
const entry = (n, cause, recorded = true) => ({ baselineId: Buffer.alloc(16, n), cause, links: [],
  evidence: { fields: recorded ? [fieldRow] : [], rules: recorded ? [ruleRow] : [], signatures: [sigRow] } });

function recorder({ marked } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: text, params });
    if (text.startsWith('SELECT COUNT(*) AS n FROM va_baseline')) return [{ n: marked ?? params.length - 2 }];
    return [];
  };
  return { queries, query };
}

test('evidence for several versions is written in a few batched statements, then each version is marked', async () => {
  const { queries, query } = recorder();
  await writeVersionEvidence({ query, entries: [entry(1, 'DRIFT_DECISION'), entry(2, 'PARENT_CAPTURE'),
    entry(3, 'PARENT_CAPTURE'), entry(4, 'LINK_RECORD', false)] });
  const fieldInserts = queries.filter(q => q.sql.startsWith('INSERT INTO va_baseline_field'));
  assert.equal(fieldInserts.length, 1, 'one statement for every version\'s fields');
  assert.equal(queries.filter(q => q.sql.startsWith('INSERT INTO va_baseline_signature')).length, 1);
  for (const q of queries.filter(q => q.sql.startsWith('INSERT'))) {
    assert.equal((q.sql.match(/\?/g) ?? []).length, q.params.length, q.sql.slice(0, 40));
    assert.match(q.sql, /ON DUPLICATE KEY UPDATE baseline_id = baseline_id$/, 'a replay writes the same rows again');
  }
  assert.equal(fieldInserts[0].params[fieldInserts[0].params.length - 4], 1, 'store_values is written as 1/0');
  const marks = queries.filter(q => q.sql.startsWith('UPDATE va_baseline SET cause'));
  assert.deepEqual(marks.map(q => q.params.slice(0, 2)),
    [['DRIFT_DECISION', 1], ['PARENT_CAPTURE', 1], ['LINK_RECORD', 0]]);
  assert.match(marks[0].sql, /WHERE state = 'CAPTURING' AND baseline_id IN \(FROM_BASE64\(\?\)\)/);
});

test('a version that is not CAPTURING, or not marked as asked, refuses the capture', async () => {
  const { query } = recorder({ marked: 0 });
  await assert.rejects(() => writeVersionEvidence({ query, entries: [entry(1, 'OWN_TRANSITION')] }),
    error => error.reason === 'CAPTURE_INCOMPLETE');
});

test('a missing evidence table or column means the migration has not run yet', async () => {
  const noTable = Object.assign(new Error("Table 'va_baseline_field' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
  const noColumn = Object.assign(new Error("Unknown column 'policy_recorded' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
  assert.equal(isMissingSchema(noTable), true);
  assert.equal(isMissingSchema(noColumn), true);
  assert.equal(isMissingSchema(new Error('Duplicate entry')), false);
  assert.equal(isMissingSchema({ code: 'SOMETHING_ELSE', context: { debug: { code: 'ER_NO_SUCH_TABLE' } }, message: 'boom' }), true,
    'the driver code nested in the wrapper counts even when the top-level code is something else');
  for (const error of [noTable, noColumn]) {
    await assert.rejects(() => writeVersionEvidence({ query: async () => { throw error; }, entries: [entry(1, 'OWN_TRANSITION')] }),
      e => e.reason === 'SCHEMA_PENDING');
  }
});

test('only the database\'s own missing-table text counts as a missing schema without a driver code', () => {
  assert.equal(isMissingSchema(new Error("Table 'forge_db.va_baseline_link' doesn't exist")), true);
  for (const message of ['Issue does not exist', "The approval doesn't exist", 'Baseline does not exist or you do not have permission']) {
    assert.equal(isMissingSchema(new Error(message)), false, message);
  }
});

test('evidence reads back decoded', async () => {
  const query = async sql => {
    if (/FROM va_baseline_field/.test(sql)) return [{ ...fieldRow, store_values: 1, restorable: null }];
    if (/FROM va_baseline_rule/.test(sql)) return [{ ...ruleRow, imposed_by_baseline_id: Buffer.alloc(16, 9).toString('base64') }];
    if (/FROM va_baseline_signature/.test(sql)) return [{ ...sigRow, approval_id: Buffer.alloc(16, 1).toString('base64') }];
    if (/FROM va_baseline_link/.test(sql)) return [];
    return [];
  };
  const read = await readVersionEvidence(Buffer.alloc(16, 2), query);
  assert.deepEqual(read.fields[0].required_by, ['k1']);
  assert.equal(read.fields[0].store_values, true);
  assert.equal(read.fields[0].restorable, null);
  assert.deepEqual(read.rules[0].approvers, [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }]);
  assert.ok(read.rules[0].imposed_by_baseline_id.equals(Buffer.alloc(16, 9)));
  assert.ok(read.signatures[0].approval_id.equals(Buffer.alloc(16, 1)));
  assert.deepEqual(read.signatures[0].fields_covered, ['summary']);
  assert.deepEqual(read.links, []);
});

test('child pins and node security levels are written in batched CASE statements, and nothing for none', async () => {
  const { queries, query } = recorder();
  await pinChildVersions({ query, parentBaselineId: Buffer.alloc(16, 7),
    pins: [{ issueId: 2, baselineId: Buffer.alloc(16, 4), version: 5 }, { issueId: 3, baselineId: Buffer.alloc(16, 6), version: 1 }] });
  await recordNodeSecurity({ query, baselineId: Buffer.alloc(16, 7), levels: [{ issueId: 3, securityLevelId: '10000' }] });
  await recordNodeSecurity({ query, baselineId: Buffer.alloc(16, 7), levels: [] });
  await recordNodeSecurity({ query, baselineId: Buffer.alloc(16, 7),
    levels: [{ issueId: 4, securityLevelId: null }, { issueId: 5, securityLevelId: undefined }] });
  assert.equal(queries.length, 2, 'no statement for no levels, or for levels with no security level');
  assert.match(queries[0].sql, /SET child_baseline_id = CASE current_issue_id WHEN \? THEN FROM_BASE64\(\?\) WHEN \? THEN FROM_BASE64\(\?\) END/);
  assert.match(queries[0].sql, /current_issue_id IN \(\?, \?\)$/);
  assert.equal((queries[0].sql.match(/\?/g) ?? []).length, queries[0].params.length);
  assert.match(queries[1].sql, /SET security_level_id = CASE current_issue_id WHEN \? THEN \? END/);
});

test('a node with no security level is skipped, never stored as the text "null"', async () => {
  const { queries, query } = recorder();
  await recordNodeSecurity({ query, baselineId: Buffer.alloc(16, 7),
    levels: [{ issueId: 3, securityLevelId: '10000' }, { issueId: 4, securityLevelId: null }, { issueId: 5 }] });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [3, '10000', Buffer.alloc(16, 7).toString('base64'), 3]);
});

test('a link record copies its source version\'s pins node by node', async () => {
  const { queries, query } = recorder();
  await copyNodePins({ query, fromBaselineId: Buffer.alloc(16, 1), toBaselineId: Buffer.alloc(16, 2) });
  assert.match(queries[0].sql, /UPDATE va_baseline_node d JOIN va_baseline_node s ON s.baseline_id = FROM_BASE64\(\?\) AND s.logical_node_id = d.logical_node_id/);
  assert.deepEqual(queries[0].params, [Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(16, 2).toString('base64')]);
});

test('a resumed version\'s evidence is cleared from every evidence table, only while it is still CAPTURING', async () => {
  const id = Buffer.alloc(16, 3);
  const run = state => {
    const queries = [];
    return { queries, query: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: text, params });
      return text.startsWith('SELECT state') ? (state ? [{ state }] : []) : [];
    } };
  };
  const capturing = run('CAPTURING');
  await clearVersionEvidence({ baselineId: id, query: capturing.query });
  assert.equal(capturing.queries[0].sql, 'SELECT state FROM va_baseline WHERE baseline_id = FROM_BASE64(?)');
  assert.deepEqual(capturing.queries.slice(1).map(q => q.sql),
    ['va_baseline_field', 'va_baseline_rule', 'va_baseline_signature', 'va_baseline_link']
      .map(table => `DELETE FROM ${table} WHERE baseline_id = FROM_BASE64(?)`));
  assert.ok(capturing.queries.every(q => q.params.length === 1 && q.params[0] === id.toString('base64')));
  for (const state of ['ACTIVE', 'SUPERSEDED', null]) {
    const refused = run(state);
    await assert.rejects(() => clearVersionEvidence({ baselineId: id, query: refused.query }),
      error => error.reason === 'CAPTURE_INCOMPLETE', String(state));
    assert.equal(refused.queries.filter(q => q.sql.startsWith('DELETE')).length, 0, `nothing cleared for ${state}`);
  }
});

test('clearing a version\'s evidence before its tables exist waits for the migration', async () => {
  const noTable = Object.assign(new Error("Table 'va_baseline_field' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
  await assert.rejects(() => clearVersionEvidence({ baselineId: Buffer.alloc(16, 3),
    query: async sql => { if (/^\s*SELECT/.test(sql)) return [{ state: 'CAPTURING' }]; throw noTable; } }),
  error => error.reason === 'SCHEMA_PENDING');
});
