import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { planRestore } from '../src/lib/restore/planner.js';
import { shapeFor } from '../src/lib/restore/adapters.js';
import { project } from '../src/lib/content.js';
import { tally } from '../src/lib/restore/outcome.js';

// Only Forge's external request and SQL boundaries are replaced; planner,
// executor, handlers and verification run their real production code.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'test:forge-api', shortCircuit: true };
    if (specifier.endsWith('/db/restoreStore.js')) return { url: 'test:restore-store', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:forge-api') return { format: 'module', shortCircuit: true,
      source: 'export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??""),"");' };
    if (url === 'test:restore-store') return { format: 'module', shortCircuit: true,
      source: 'export async function declareWrite() {}' };
    return next(url, context);
  }
});
const { executeRestore } = await import('../src/lib/restore/executor.js');
const { verifyRestore } = await import('../src/lib/restore/verifier.js');
const { createRestoreAdapters, JiraRestoreError } = await import('../src/lib/tree/restoreAdapters.js');
hooks.deregister();

const field = (id, kind = 'SCALAR') => ({ field_id: id, field_name: id, field_kind: kind, store_values: true });
const diff = (id) => ({ fields: [{ fieldId: id, fieldName: id, changed: true, restorable: 'YES' }] });
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function apiFixture(handler = () => response(204)) {
  const calls = [];
  const client = identity => ({ requestJira: async (url, options = {}) => {
    const call = { identity, url: String(url), method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) };
    calls.push(call);
    return handler(call);
  } });
  return { calls, api: { asApp: () => client('app'), asUser: () => client('user') } };
}

for (const value of [undefined, 'ABSENT']) {
  test(`missing approved raw value (${value}) never clears a field`, () => {
    const plan = planRestore({ diff: diff('summary'), controlledFields: [field('summary', 'TEXT')],
      baselineValues: value === 'ABSENT' ? {} : { summary: value }, editmeta: { summary: { schema: { type: 'string' } } } });
    assert.deepEqual(plan.fieldWrites, {});
    assert.equal(plan.steps[0].strategy, 'none');
    assert.match(plan.steps[0].reason, /stored|retained|missing/i);
  });
}

test('current edit metadata excludes a field even if historical writability allowed it', () => {
  const plan = planRestore({ diff: diff('summary'), controlledFields: [field('summary', 'TEXT')], baselineValues: { summary: 'approved' }, editmeta: {} });
  assert.deepEqual(plan.fieldWrites, {});
  assert.match(plan.steps[0].reason, /edit|screen|permission/i);
});

test('an array of object labels refuses lossy object stringification', () => {
  const shaped = shapeFor({ field: field('labels', 'MULTI'), value: [{ value: 'x' }], editmeta: { labels: { schema: { type: 'array', items: 'string' } } } });
  assert.equal(shaped.ok, false);
});

test('a user display name is not invented into an account id', () => {
  const shaped = shapeFor({ field: field('assignee'), value: { value: 'Ada' }, editmeta: { assignee: { schema: { type: 'user' } } } });
  assert.equal(shaped.ok, false);
});

for (const [value, expected] of [[null, null], [{ id: '100' }, { id: '100' }], [{ id: '100', key: 'T-1' }, { id: '100' }]]) {
  test(`parent restore preserves empty or numeric identity: ${JSON.stringify(value)}`, async () => {
    const f = apiFixture();
    const result = await executeRestore({ api: f.api, issueKey: 'T-2', plan: { fieldWrites: {}, steps: [{ fieldId: 'parent', strategy: 'parent', targetValue: value }] } });
    assert.deepEqual(f.calls[0]?.body, { fields: { parent: expected } });
    assert.equal(result.detail[0].outcome, 'succeeded');
  });
}

test('bulk and retry writes respect Jira screens and editability and requested notifications', async () => {
  let attempt = 0;
  const f = apiFixture(() => ++attempt === 1 ? response(400, { errors: { summary: 'retry' } }) : response(204));
  await executeRestore({ api: f.api, issueKey: 'T-2', notifyUsers: true, actAs: 'user', plan: { fieldWrites: { summary: 'approved' }, steps: [{ fieldId: 'summary', strategy: 'field' }] } });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => !c.url.includes('override') && !c.url.includes('notifyUsers=false') && c.identity === 'user'));
});

for (const current of [{}, { labels: undefined }]) {
  test(`a missing live field never verifies against approved empty values: ${Object.keys(current)}`, async () => {
    const fields = [field('labels', 'MULTI')];
    const f = apiFixture(() => response(200, { fields: current }));
    const result = await verifyRestore({ api: f.api, issueKey: 'T-2', controlledFields: fields,
      baselineDigests: project({ labels: [] }, fields).digests, detail: [{ fieldId: 'labels', outcome: 'succeeded' }] });
    assert.equal(result.detail[0].verified, false);
    assert.equal(result.unmatched.length, 1);
    assert.notEqual(tally(result.detail, result.unmatched).state, 'COMPLETE');
  });
}

test('missing approved digest prevents claiming the whole tracked record is restored', async () => {
  const f = apiFixture(() => response(200, { fields: { summary: 'approved', labels: [] } }));
  const fields = [field('summary', 'TEXT'), field('labels', 'MULTI')];
  const result = await verifyRestore({ api: f.api, issueKey: 'T-2', controlledFields: fields,
    baselineDigests: project({ summary: 'approved' }, [fields[0]]).digests, detail: [] });
  assert.deepEqual(result.unmatched.map(d => d.fieldId), ['labels']);
});

test('scalar restoration cannot complete when the fresh Jira read is outside the baseline review status', async () => {
  const fields = [field('summary', 'TEXT')];
  const approved = project({ summary: 'approved' }, fields).digests;
  const f = apiFixture(() => response(200, { fields: { summary: 'approved', status: { id: '2' } } }));
  const result = await verifyRestore({ api: f.api, issueKey: 'T-2', controlledFields: fields,
    baselineDigests: approved, expectedStatusId: '1',
    detail: [{ fieldId: 'summary', outcome: 'succeeded' }] });
  assert.deepEqual(result.unmatched.map(item => item.fieldId), ['status']);
  assert.notEqual(tally(result.detail, result.unmatched).state, 'COMPLETE');
});

const link = (id, direction, other) => ({ id, type: { id: '100', name: 'Blocks' }, [direction]: { id: other } });
test('links reconcile added and removed relationships with their original direction', async () => {
  const keep = link('1', 'outwardIssue', '11');
  const remove = link('2', 'inwardIssue', '12');
  const add = link('3', 'inwardIssue', '13');
  const f = apiFixture(c => c.method === 'GET' ? response(200, { fields: { issuelinks: [keep, remove] } }) : response(c.method === 'POST' ? 201 : 204));
  const result = await executeRestore({ api: f.api, issueKey: 'T-2', plan: { fieldWrites: {}, steps: [{ fieldId: 'issuelinks', strategy: 'links', targetValue: [keep, add] }] } });
  assert.equal(result.detail[0].outcome, 'succeeded');
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.url), ['/rest/api/3/issueLink/2']);
  assert.deepEqual(f.calls.find(c => c.method === 'POST')?.body, { type: { id: '100' }, inwardIssue: { id: '13' }, outwardIssue: { key: 'T-2' } });
});

test('links refuse to delete when the current link list is absent', async () => {
  const f = apiFixture(() => response(200, { fields: {} }));
  const result = await executeRestore({ api: f.api, issueKey: 'T-2', plan: { fieldWrites: {}, steps: [{ fieldId: 'issuelinks', strategy: 'links', targetValue: [] }] } });
  assert.equal(result.detail[0].outcome, 'failed');
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

// A tracked field the administrator declared is not necessarily on the issue's
// edit screen. Restoring it is the whole promise of Reject, so app-attributed
// writes carry Jira's screen-security override; user-attributed ones cannot,
// because those parameters require Jira administrator permission.
test('app-attributed restore overrides screen security so off-screen tracked fields revert', async () => {
  const f = apiFixture();
  await executeRestore({ api: f.api, issueKey: 'T-3', actAs: 'app',
    plan: { fieldWrites: { summary: 'approved' }, steps: [{ fieldId: 'summary', strategy: 'field' }] },
    controlledFields: [field('summary', 'TEXT')] });
  const put = f.calls.find(c => c.method === 'PUT');
  assert.equal(put.identity, 'app');
  assert.match(put.url, /overrideScreenSecurity=true/);
  assert.match(put.url, /overrideEditableFlag=true/);
  assert.match(put.url, /notifyUsers=false/);
});

test('user-attributed restore never claims administrator overrides', async () => {
  const f = apiFixture();
  await executeRestore({ api: f.api, issueKey: 'T-3', actAs: 'user',
    plan: { fieldWrites: { summary: 'approved' }, steps: [{ fieldId: 'summary', strategy: 'field' }] },
    controlledFields: [field('summary', 'TEXT')] });
  const put = f.calls.find(c => c.method === 'PUT');
  assert.equal(put.identity, 'user');
  assert.doesNotMatch(put.url, /overrideScreenSecurity/);
  assert.doesNotMatch(put.url, /overrideEditableFlag/);
});

test('notifying users is still honoured alongside the override', async () => {
  const f = apiFixture();
  await executeRestore({ api: f.api, issueKey: 'T-3', actAs: 'app', notifyUsers: true,
    plan: { fieldWrites: { summary: 'approved' }, steps: [{ fieldId: 'summary', strategy: 'field' }] },
    controlledFields: [field('summary', 'TEXT')] });
  const put = f.calls.find(c => c.method === 'PUT');
  assert.doesNotMatch(put.url, /notifyUsers=false/);
  assert.match(put.url, /overrideScreenSecurity=true/);
});

test('tree restore Jira adapters preflight every permission before mutating', async () => {
  const f = apiFixture(call => call.url.includes('/mypermissions')
    ? response(200, { permissions: {
      CREATE_ISSUES: { havePermission: true }, EDIT_ISSUES: { havePermission: true },
      DELETE_ISSUES: { havePermission: false }
    } })
    : response(204));
  const adapters = createRestoreAdapters({ api: f.api, route: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '') });
  const allowed = await adapters.checkPermissions({ steps: [
    { kind: 'CREATE_REPLACEMENT' }, { kind: 'MOVE_NODE' }, { kind: 'RESTORE_FIELDS' }, { kind: 'DELETE_ADDED_NODE' }
  ], rootIssueKey: 'ROOT-1' });
  assert.equal(allowed, false);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /CREATE_ISSUES/);
  assert.match(f.calls[0].url, /EDIT_ISSUES/);
  assert.match(f.calls[0].url, /DELETE_ISSUES/);
});

test('a tree spanning two projects is preflighted per project, not only against the root', async () => {
  const f = apiFixture(call => {
    if (!call.url.includes('/mypermissions')) return response(204);
    if (call.url.includes('projectId=10')) return response(200, { permissions: { CREATE_ISSUES: { havePermission: true } } });
    if (call.url.includes('projectId=20')) return response(200, { permissions: { EDIT_ISSUES: { havePermission: false } } });
    return response(200, { permissions: {} });
  });
  const adapters = createRestoreAdapters({ api: f.api, route: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '') });
  const allowed = await adapters.checkPermissions({
    steps: [
      { kind: 'CREATE_REPLACEMENT', logicalNodeId: 'n1', node: { projectId: '10' } },
      { kind: 'RESTORE_FIELDS', logicalNodeId: 'n2' }
    ],
    rootIssueKey: 'ROOT-1',
    currentTree: { nodes: [{ logicalNodeId: 'n2', projectId: '20' }] },
    baselineTree: null
  });
  // Root's own project (unstated here) never had EDIT_ISSUES denied — only
  // project 20, reached through the child node, did. A root-only preflight
  // would have missed this and let the restore fail midway instead.
  assert.equal(allowed, false);
  const permissionCalls = f.calls.filter(c => c.url.includes('/mypermissions'));
  assert.equal(permissionCalls.length, 2, 'one request per distinct project, not per node and not only the root');
  assert.ok(permissionCalls.some(c => c.url.includes('projectId=10') && c.url.includes('CREATE_ISSUES')));
  assert.ok(permissionCalls.some(c => c.url.includes('projectId=20') && c.url.includes('EDIT_ISSUES')));
  assert.ok(!permissionCalls.some(c => c.url.includes('issueKey=ROOT-1')), 'both steps resolved a real project, so root fallback is never used');
});

test('tree restore Jira adapters send real move and field mutations', async () => {
  const f = apiFixture();
  const adapters = createRestoreAdapters({ api: f.api, route: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '') });
  await adapters.moveIssue('ROOT-2', 'ROOT-1');
  await adapters.editIssue('ROOT-2', { summary: 'Approved' });
  assert.deepEqual(f.calls.filter(call => call.method === 'PUT').map(call => call.body), [
    { fields: { parent: { key: 'ROOT-1' } } },
    { fields: { summary: 'Approved' } }
  ]);
});

test('tree restore adapter reconciles links by removing extras and recreating approved links', async () => {
  const keep = link('1', 'outwardIssue', '11');
  const remove = link('2', 'inwardIssue', '12');
  const add = link('3', 'inwardIssue', '13');
  const f = apiFixture(c => c.method === 'GET'
    ? response(200, { fields: { issuelinks: [keep, remove] } })
    : response(c.method === 'POST' ? 201 : 204));
  const adapters = createRestoreAdapters({ api: f.api, route: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '') });
  const result = await adapters.restoreLinks('ROOT-1', [keep, add]);

  assert.deepEqual(result, { issueIdOrKey: 'ROOT-1', added: 1, removed: 1 });
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.url), ['/rest/api/3/issueLink/2']);
  assert.deepEqual(f.calls.find(c => c.method === 'POST')?.body, { type: { id: '100' }, inwardIssue: { id: '13' }, outwardIssue: { key: 'ROOT-1' } });
});

test('tree restore Jira adapters throw typed failures with Jira details', async () => {
  const f = apiFixture(() => response(400, { errorMessages: ['blocked by workflow'], errors: { summary: 'not editable' } }));
  const adapters = createRestoreAdapters({ api: f.api, route: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '') });
  await assert.rejects(() => adapters.editIssue('ROOT-2', { summary: 'Approved' }), error => {
    assert.equal(error instanceof JiraRestoreError, true);
    assert.equal(error.status, 400);
    assert.match(error.detail, /blocked by workflow/);
    assert.match(error.detail, /not editable/);
    return true;
  });
});


test('real diff and restore plan use current writability for a field absent from the original edit screen', async () => {
  const { diffIssue } = await import('../src/lib/diff/index.js');
  const fields = [{ ...field('summary', 'TEXT'), writable: false }];
  const values = { summary: 'approved' };
  const baseline = { issue_id: 1, version: 1, field_digests: project(values, fields).digests };
  const changes = diffIssue({ baseline, baselineValues: values, currentFields: { summary: 'drift' }, controlledFields: fields });
  const plan = planRestore({ diff: changes, baselineValues: values, controlledFields: fields,
    editmeta: { summary: { schema: { type: 'string' }, operations: ['set'] } } });
  assert.deepEqual(plan.fieldWrites, values);
  assert.equal(plan.preflight.cannotRestore.length, 0);
});
