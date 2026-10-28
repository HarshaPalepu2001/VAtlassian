import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { withRequestCache } from '../src/lib/cache.js';
import { project } from '../src/lib/content.js';

// Keep configStore, throwing(), executeQuery(), and field decoding real. Only
// replace the remote SQL transport with table rows evaluated against the query.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/sql') return { url: 'controlled-fields:sql', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'controlled-fields:sql') return {
      format: 'module', shortCircuit: true,
      source: `export const sql = { prepare(statement) { return {
        bindParams(...params) { return {
          async execute() { return globalThis.vaControlledFieldQuery(statement, params); }
        }; }
      }; } };`
    };
    return next(url, context);
  }
});
const { controlledFields } = await import('../src/db/configStore.js');
hooks.deregister();

const CUSTOM_FIELD = 'customfield_10101';
const row = (overrides = {}) => ({
  cf_id: Buffer.alloc(16, 3).toString('base64'),
  project_id: 1, issue_type_id: '*', field_id: CUSTOM_FIELD,
  field_name: 'Approval evidence', field_kind: 'TEXT', schema_type: 'string',
  store_values: 1, writable: 1, materiality: 'MAJOR', state: 'ACTIVE',
  ...overrides
});

function table(rows) {
  globalThis.vaControlledFieldQuery = async (statement, params) => {
    assert.match(statement, /FROM va_controlled_field\b/);
    assert.match(statement, /WHERE project_id = \?/);
    assert.match(statement, /issue_type_id = \? OR issue_type_id = '\*'/);
    const [projectId, issueTypeId, state] = params;
    let selected = rows.filter(r => String(r.project_id) === String(projectId)
      && (r.issue_type_id === String(issueTypeId) || r.issue_type_id === '*'));
    // The original bug filters EXCLUDED out here, before scope precedence.
    if (/\bAND state = \?/.test(statement)) selected = selected.filter(r => r.state === state);
    if (/ORDER BY issue_type_id DESC/.test(statement)) {
      selected.sort((a, b) => String(a.issue_type_id) < String(b.issue_type_id) ? 1
        : String(a.issue_type_id) > String(b.issue_type_id) ? -1 : 0);
    }
    const columns = statement.match(/SELECT\s+([\s\S]+?)\s+FROM/)[1]
      .split(',').map(column => column.trim().split(/\s+AS\s+/i).at(-1));
    return { rows: selected.map(r => Object.fromEntries(columns.map(column => [column, r[column]]))), metadata: {} };
  };
}

const read = (issueTypeId = '10001') => withRequestCache(() => controlledFields({ projectId: 1, issueTypeId }));
const captured = fields => project({ [CUSTOM_FIELD]: 'Customer evidence' }, fields);

test('an exact EXCLUDED custom field suppresses wildcard ACTIVE tracking and retention', async () => {
  table([row(), row({ issue_type_id: '10001', state: 'EXCLUDED', store_values: 0 })]);
  const fields = await read();
  assert.equal(fields.some(f => f.field_id === CUSTOM_FIELD), false);
  const snapshot = captured(fields);
  assert.equal(Object.hasOwn(snapshot.digests, CUSTOM_FIELD), false);
  assert.equal(Object.hasOwn(snapshot.values, CUSTOM_FIELD), false);
  assert.equal(Object.hasOwn(snapshot.raw, CUSTOM_FIELD), false);
});

test('a wildcard ACTIVE declaration alone retains its field values and materiality', async () => {
  table([row()]);
  const fields = await read();
  assert.deepEqual(fields.find(f => f.field_id === CUSTOM_FIELD), {
    cf_id: '03'.repeat(16), field_id: CUSTOM_FIELD, field_name: 'Approval evidence',
    field_kind: 'TEXT', schema_type: 'string', store_values: true, writable: true, materiality: 'MAJOR'
  });
  assert.equal(captured(fields).values[CUSTOM_FIELD], 'Customer evidence');
});

test('exact ACTIVE settings override wildcard retention and materiality without duplicates', async () => {
  table([row(), row({ issue_type_id: '10001', store_values: '0', writable: '0', materiality: 'MINOR' })]);
  const fields = await read();
  const custom = fields.filter(f => f.field_id === CUSTOM_FIELD);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].store_values, false);
  assert.equal(custom[0].writable, false);
  assert.equal(custom[0].materiality, 'MINOR');
  const snapshot = captured(fields);
  assert.equal(Object.hasOwn(snapshot.digests, CUSTOM_FIELD), true);
  assert.equal(Object.hasOwn(snapshot.values, CUSTOM_FIELD), false);
});

test('an exact exclusion affects only its own issue type and project', async () => {
  table([
    row(), row({ issue_type_id: '10001', state: 'EXCLUDED', store_values: 0 }),
    row({ project_id: 2, issue_type_id: '10002', state: 'EXCLUDED' })
  ]);
  const fields = await read('10002');
  assert.equal(fields.find(f => f.field_id === CUSTOM_FIELD).store_values, true);
  assert.equal(captured(fields).values[CUSTOM_FIELD], 'Customer evidence');
});

test('exact ACTIVE re-enables a custom field over a wildcard exclusion', async () => {
  table([row({ state: 'EXCLUDED', store_values: 0 }), row({ issue_type_id: '10001' })]);
  const fields = await read();
  assert.equal(fields.find(f => f.field_id === CUSTOM_FIELD).store_values, true);
  assert.equal(captured(fields).values[CUSTOM_FIELD], 'Customer evidence');
});

test('exclusions cannot disable the four always-controlled fields', async () => {
  table(['summary', 'description', 'issuelinks', 'subtasks'].flatMap(field_id => [
    row({ field_id }), row({ field_id, issue_type_id: '10001', state: 'EXCLUDED' })
  ]));
  const fields = await read();
  assert.deepEqual(fields.map(f => [f.field_id, f.field_kind]), [
    ['summary', 'TEXT'], ['description', 'ADF'], ['issuelinks', 'LINKS'], ['subtasks', 'SUBTASKS']
  ]);
});
