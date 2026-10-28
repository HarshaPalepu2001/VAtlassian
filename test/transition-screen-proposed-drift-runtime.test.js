import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the real validator, SQL stores, projections and runtime. Only the
// Forge network transports are replaced; no production module is rewritten.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'screen-drift:api', shortCircuit: true };
    if (specifier === '@forge/sql') return { url: 'screen-drift:sql', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'screen-drift:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i) => a+b+(v[i]??''), '');
      export const asUser = () => ({ requestJira: (...a) => globalThis.screenDriftWorld.jira(...a) });
      export const asApp = asUser;
      export const getAppContext = () => ({});
      export default { asUser, asApp };` };
    if (url === 'screen-drift:sql') return { format: 'module', shortCircuit: true, source: `
      export const sql = { prepare(statement) { return { bindParams(...params) {
        return { execute: () => globalThis.screenDriftWorld.sql(statement, params) };
      } }; } };` };
    return next(url, context);
  }
});
const { createGate } = await import('../src/gate.js');
const { gateRuntime } = await import('../src/lib/approval/runtime.js');
const { project, withAlwaysControlled } = await import('../src/lib/content.js');
const { withRequestCache } = await import('../src/lib/cache.js');
after(() => hooks.deregister());

const doc = text => ({ type: 'doc', version: 1, content: [
  { type: 'paragraph', content: [{ type: 'text', text }] }
] });
const declared = withAlwaysControlled([
  { field_id: 'priority', field_kind: 'SCALAR' },
  { field_id: 'customfield_100', field_kind: 'TEXT' },
  { field_id: 'issuetype', field_kind: 'SCALAR' },
  { field_id: 'parent', field_kind: 'SCALAR' }
]);

function fixture({ disabled = false, tracked = declared } = {}) {
  const issue = { id: '10', key: 'T-10', fields: { project: { id: '1' }, issuetype: { id: '1' },
    status: { id: '1' }, summary: 'Approved summary', description: doc('Approved description'),
    priority: { id: '3', name: 'Medium' }, customfield_100: 'Approved text',
    issuelinks: [], subtasks: [], parent: null } };
  const baseline = item => ({ baseline_id: Buffer.alloc(16, Number(item.id)).toString('base64'),
    issue_id: Number(item.id), project_id: 1, issue_type_id: '1', version: 1,
    state: 'ACTIVE', tree_hash: null, field_digests: JSON.stringify(project(item.fields, tracked).digests) });
  const w = { issue, issues: new Map([['T-10', issue]]), baselines: new Map([[10, baseline(issue)]]),
    statements: [], reads: [], unexpected: [], disabled, tracked, controlled: false, execution: false };
  w.addParent = () => {
    const parent = { ...structuredClone(issue), id: '20', key: 'T-20' };
    w.issues.set(parent.key, parent);
    w.baselines.set(20, baseline(parent));
    parent.fields.description = doc('Parent changed after approval');
    return { id: parent.id, key: parent.key };
  };
  w.jira = async path => {
    w.reads.push(String(path));
    const key = String(path).match(/\/issue\/([^/?]+)/)?.[1];
    if (String(path).includes('/status/2')) return { ok: true, json: async () => ({ statusCategory: { key: 'done' } }) };
    if (String(path).includes('/transitions?')) return { ok: true, json: async () => ({ transitions: [{ id: '60', to: { id: '2' } }] }) };
    if (w.issues.has(key)) return { ok: true, json: async () => structuredClone(w.issues.get(key)) };
    throw new Error('Unexpected Jira read: ' + path);
  };
  w.sql = async (statement, params) => {
    w.statements.push(statement);
    let rows;
    if (/FROM va_config\b/.test(statement)) rows = disabled
      ? [{ cfg_key: 'project:1', cfg_value: '{"enabled":false}' }] : [];
    else if (/FROM va_controlled_field\b/.test(statement)) rows = tracked.map((f, i) => ({ ...f,
      cf_id: Buffer.alloc(16, i + 1).toString('base64'), state: 'ACTIVE', store_values: 0, writable: 1 }));
    else if (/FROM va_item_state\b/.test(statement)) rows = [{ state: 'BASELINED', baseline_version: 1 }];
    else if (/FROM va_baseline\s/.test(statement)) rows = w.baselines.has(Number(params[0])) ? [w.baselines.get(Number(params[0]))] : [];
    else if (/FROM va_controlled_transition\b/.test(statement)) rows = w.controlled ? [{
      ct_id: Buffer.alloc(16, 4).toString('base64'), state: 'ACTIVE', project_id: 1, issue_type_id: '1',
      from_status_id: '1', to_status_id: '2', transition_id: '60', required_role: 'reviewer',
      required_assurance: 'ESIGNATURE', meaning: 'Approve', require_decision: 1, capture_baseline: 0
    }] : [];
    else if (/FROM tm_project\b/.test(statement)) rows = w.execution ? [{ project_id: 1, enabled: 1,
      test_type_id: '3', execution_type_id: '1', defect_type_id: '4' }] : [];
    else if (/FROM tm_run\b/.test(statement)) rows = [{ run_id: 'a'.repeat(32), state: 'RUNNING' }];
    else if (/FROM (va_baseline_node|va_approval|va_audit)\b/.test(statement)) rows = [];
    else if (/INSERT INTO va_audit\b/.test(statement)) rows = { affectedRows: 1 };
    else { w.unexpected.push(statement); throw new Error('Unexpected SQL: ' + statement); }
    return { rows, metadata: {} };
  };
  globalThis.screenDriftWorld = w;
  w.load = async modifiedFields => withRequestCache(async () => {
    const runtime = await gateRuntime();
    return runtime.load({ issueKey: issue.key, fromStatusId: '1', toStatusId: '2', transitionId: '60', modifiedFields });
  });
  w.validate = async modifiedFields => withRequestCache(async () => {
    const runtime = await gateRuntime();
    const result = await createGate(runtime)({ issue: { key: issue.key }, transition: {
      from: { id: '1' }, to: { id: '2' }, id: '60', modifiedFields } });
    assert.deepEqual(w.unexpected, [], 'every SQL boundary is modeled');
    return result;
  });
  return w;
}

for (const [name, modifiedFields, field] of [
  ['ADF description edit', { description: doc('Unapproved description') }, 'description'],
  ['description null clear', { description: null }, 'description'],
  ['priority edit', { priority: { id: '1' } }, 'priority'],
  ['custom field edit', { customfield_100: 'Unapproved text' }, 'customfield_100'],
  ['custom field null clear', { customfield_100: null }, 'customfield_100'],
  ['issue type edit', { issuetype: { id: '2' } }, 'issuetype'],
  ['parent edit', { parent: { id: '20', key: 'T-20' } }, 'parent']
]) {
  test(`production drift hold refuses proposed ${name} before spending a signature`, async () => {
    const w = fixture();
    const loaded = await w.load(modifiedFields);
    assert.ok(loaded.driftedFields.includes(field), `${field} is proposed drift`);
    const result = await w.validate(modifiedFields);
    assert.equal(result.result, false);
    assert.match(result.errorMessage, /changed since it was approved/i);
    assert.equal(w.statements.some(s => /FROM va_approval\b|UPDATE va_approval\b/.test(s)), false);
    assert.deepEqual(w.issue.fields.description, doc('Approved description'), 'Jira read is not mutated');
  });
}

test('same-value edits and untracked edits remain allowed', async () => {
  const w = fixture();
  assert.equal((await w.validate({ description: doc('Approved description'), priority: { id: '3' },
    customfield_100: 'Approved text', parent: null, issuetype: { id: '1' }, customfield_999: 'New untracked value' })).result, true);
  assert.equal((await w.validate(undefined)).result, true);
});

test('existing persisted drift is still refused when a different screen field is untracked', async () => {
  const w = fixture();
  w.issue.fields.description = doc('Existing unapproved edit');
  assert.match((await w.validate({ customfield_999: null })).errorMessage, /changed since it was approved/i);
});

test('a disabled project allows an uncontrolled screen edit despite proposed drift', async () => {
  const w = fixture({ disabled: true });
  assert.equal((await w.validate({ description: null })).result, true);
});

test('a disabled project still refuses its controlled transition with proposed drift', async () => {
  const w = fixture({ disabled: true });
  w.controlled = true;
  const result = await w.validate({ description: null });
  assert.equal(result.result, false);
  assert.doesNotMatch(result.errorMessage, /changed since it was approved/i);
  assert.equal(w.statements.some(s => /UPDATE va_approval\b/.test(s)), false);
});

test('a proposed type change cannot bypass an existing execution completion guard', async () => {
  const w = fixture({ tracked: declared.filter(f => f.field_id !== 'issuetype') });
  w.execution = true;
  const result = await w.validate({ issuetype: { id: '2' } });
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /test run.*not finished/i);
});

test('proposed parent is used for ancestor holds even when parent is untracked', async () => {
  const w = fixture({ tracked: declared.filter(f => f.field_id !== 'parent') });
  const parent = w.addParent();
  const result = await w.validate({ parent });
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /T-20/);
});

test('a proposed parent null clear does not retain the former ancestor hold', async () => {
  const w = fixture({ tracked: declared.filter(f => f.field_id !== 'parent') });
  w.issue.fields.parent = w.addParent();
  assert.equal((await w.validate({ parent: null })).result, true);
});

test('signature hash and drift projection both use proposed values once', async () => {
  const w = fixture();
  const modifiedFields = { description: null, priority: { id: '1' }, customfield_100: 'New text' };
  const loaded = await w.load(modifiedFields);
  assert.equal(await loaded.contentHash(null), project({ ...w.issue.fields, ...modifiedFields }, declared).contentHash);
});
