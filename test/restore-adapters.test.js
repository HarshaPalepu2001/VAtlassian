import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeFor, isAdfField, ADAPTER_VERSION } from '../src/lib/restore/adapters.js';
import { FIELD_KIND } from '../src/lib/content.js';

const ADF = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'approved' }] }] };

test('description is ADF even though v3 editmeta calls it a string', () => {
  const editmeta = { description: { schema: { type: 'string', system: 'description' } } };
  const result = shapeFor({ field: { field_id: 'description', field_kind: FIELD_KIND.ADF }, value: ADF, editmeta });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'adf');
  assert.deepEqual(result.value, ADF, 'the document must be written verbatim, not stringified');
});

test('environment is ADF', () => {
  const editmeta = { environment: { schema: { type: 'string', system: 'environment' } } };
  const result = shapeFor({ field: { field_id: 'environment', field_kind: FIELD_KIND.ADF }, value: ADF, editmeta });
  assert.deepEqual(result.value, ADF);
});

test('a textarea custom field is ADF', () => {
  const schema = { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' };
  assert.equal(isAdfField({ field: { field_id: 'customfield_1' }, schema }), true);
});

test('a plain text custom field is not ADF', () => {
  const schema = { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' };
  assert.equal(isAdfField({ field: { field_id: 'customfield_2' }, schema }), false);
});

test('cascading select preserves the child option', () => {
  const editmeta = { customfield_100: { schema: { type: 'option-with-child' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_100', field_kind: FIELD_KIND.SCALAR },
    value: { id: '10', value: 'Parent', child: { id: '20', value: 'Child' } },
    editmeta
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { id: '10', child: { id: '20' } });
});

test('cascading select with no child writes the parent alone', () => {
  const editmeta = { customfield_100: { schema: { type: 'option-with-child' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_100', field_kind: FIELD_KIND.SCALAR },
    value: { id: '10', value: 'Parent' },
    editmeta
  });
  assert.deepEqual(result.value, { id: '10' });
});

test('cascading select with an unresolvable child refuses rather than dropping it', () => {
  const editmeta = { customfield_100: { schema: { type: 'option-with-child' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_100', field_kind: FIELD_KIND.SCALAR },
    value: { id: '10', child: { value: 'Child with no id' } },
    editmeta
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /child/i);
});

test('a structured value against a genuine string field refuses instead of stringifying', () => {
  const editmeta = { customfield_3: { schema: { type: 'string', custom: 'x:textfield' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_3', field_kind: FIELD_KIND.TEXT },
    value: { unexpected: 'object' },
    editmeta
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.value, '[object Object]');
});

test('users write as accountId objects', () => {
  const editmeta = { assignee: { schema: { type: 'user' } } };
  const result = shapeFor({
    field: { field_id: 'assignee', field_kind: FIELD_KIND.SCALAR },
    value: { accountId: 'abc', displayName: 'Ada' },
    editmeta
  });
  assert.deepEqual(result.value, { accountId: 'abc' });
});

test('multi-user arrays write as accountId objects', () => {
  const editmeta = { customfield_4: { schema: { type: 'array', items: 'user' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_4', field_kind: FIELD_KIND.MULTI },
    value: [{ accountId: 'a' }, { accountId: 'b' }],
    editmeta
  });
  assert.deepEqual(result.value, [{ accountId: 'a' }, { accountId: 'b' }]);
});

test('versions and components write as id objects', () => {
  const editmeta = { fixVersions: { schema: { type: 'array', items: 'version' } } };
  const result = shapeFor({
    field: { field_id: 'fixVersions', field_kind: FIELD_KIND.MULTI },
    value: [{ id: '1', name: '1.0' }],
    editmeta
  });
  assert.deepEqual(result.value, [{ id: '1' }]);
});

test('an explicit null clears a scalar and an empty array clears a multi', () => {
  const editmeta = { duedate: { schema: { type: 'date' } }, labels: { schema: { type: 'array', items: 'string' } } };
  assert.equal(shapeFor({ field: { field_id: 'duedate' }, value: null, editmeta }).value, null);
  assert.deepEqual(shapeFor({ field: { field_id: 'labels' }, value: null, editmeta }).value, []);
});

test('an ADF field with a null baseline value clears rather than refusing', () => {
  const editmeta = { description: { schema: { type: 'string', system: 'description' } } };
  const result = shapeFor({ field: { field_id: 'description', field_kind: FIELD_KIND.ADF }, value: null, editmeta });
  assert.equal(result.ok, true);
  assert.equal(result.value, null);
});

test('the adapter version is exported so a restore can record which rules ran', () => {
  assert.equal(typeof ADAPTER_VERSION, 'number');
});
