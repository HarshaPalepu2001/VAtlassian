import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { fixture, request } from './admin-fixture.js';
const edge = { projectId: '1', issueTypeId: '*', fromStatusId: '*', toStatusId: '2', requiredRole: 'QA', meaning: 'APPROVED', transitionId: '100' };

test('edge creation stores assurance and both capture/drift policy flags', async () => {
  const deps = fixture();
  const result = await admin.createControlledTransition(request({ ...edge, requiredAssurance: 'NATIVE_TRANSITION', captureBaseline: false, blockOnDrift: true }), deps);
  assert.equal(result.success, true);
  const insert = deps.calls.find(c => c.sql.includes('INSERT INTO va_controlled_transition'));
  assert.match(insert.sql, /required_assurance, capture_baseline, block_on_drift/);
  assert.deepEqual(insert.params.slice(9, 13), ['NATIVE_TRANSITION', 0, 1, 0]);
  assert.equal(deps.events[0].payload.requiredAssurance, 'NATIVE_TRANSITION');
});

test('invalid assurance and nonboolean flags never reach persistence', async () => {
  for (const extra of [{ requiredAssurance: 'MAGIC' }, { captureBaseline: 'false' }, { requiredRole: 'QA ' }]) {
    const deps = fixture();
    assert.equal((await admin.createControlledTransition(request({ ...edge, ...extra }), deps)).success, false);
    assert.equal(deps.calls.length, 1);
  }
});

test('controlled transition configuration requires an exact Jira transition id', async () => {
  const deps = fixture();
  const result = await admin.createControlledTransition(request({ ...edge, transitionId: null }), deps);
  assert.equal(result.success, false);
  assert.equal(deps.calls.length, 1);
});

test('edge edits persist changed assurance without creating approvals', async () => {
  const deps = fixture({ query: sql => ({ result: true, data: sql.startsWith('SELECT state') ? [{ state: 'ACTIVE' }] : [] }) });
  const result = await admin.updateControlledTransition(request({ ...edge, ctId: 'a'.repeat(32), requiredAssurance: 'ESIGNATURE' }), deps);
  assert.equal(result.success, true);
  assert.equal(deps.calls.some(c => c.sql.startsWith('UPDATE va_controlled_transition')), true);
  assert.equal(deps.calls.some(c => /(?:INSERT|UPDATE).*va_approval/.test(c.sql)), false);
});

test('role lookup honors project-wide and issue-type wildcard grants', async () => {
  const deps = fixture();
  await admin.listAvailableRoles(request({ projectId: '1', issueTypeId: '2' }), deps);
  const read = deps.calls.at(-1);
  assert.match(read.sql, /issue_type_id = \? OR issue_type_id = '\*'/);
  assert.match(read.sql, /project_id = \? OR project_id IS NULL/);
  assert.deepEqual(read.params, ['ACTIVE', '2', '1']);
});

test('wildcard grant persists el_id and never broadens a specified project', async () => {
  const deps = fixture();
  const result = await admin.grantEligibility(request({ targetAccountId: 'reviewer', issueTypeId: '*', projectId: '4', role: 'QA' }), deps);
  assert.equal(result.success, true);
  const insert = deps.calls.find(c => c.sql.startsWith('INSERT INTO va_eligibility'));
  assert.match(insert.sql, /\(el_id,/);
  assert.equal(insert.params.at(-1), '4');
  assert.equal(deps.events[0].payload.scope, 'PROJECT');
});

test('malformed binary ids are refused rather than silently truncated', async () => {
  for (const fn of ['revokeEligibility', 'revokeControlledTransition']) {
    const deps = fixture();
    assert.equal((await admin[fn](request({ ctId: 'zz', elId: 'zz' }), deps)).success, false);
    assert.equal(deps.calls.length, 1);
  }
});

test('field metadata comes from catalogue and new retention requires opt-in', async () => {
  const deps = fixture();
  const result = await admin.saveField(request({ projectId: '1', fieldId: 'summary', fieldName: 'spoofed', fieldKind: 'LINKS' }), deps);
  assert.equal(result.success, true);
  assert.equal(typeof result.cfId, 'string');
  assert.equal(deps.writes[0].field_kind, 'TEXT');
  assert.equal(deps.writes[0].field_name, 'Summary');
  assert.equal(deps.writes[0].store_values, false);
});

test('pinned exclusions and unknown fields cannot be persisted', async () => {
  for (const fieldId of ['summary', 'status', 'not-in-jira']) {
    const deps = fixture();
    assert.equal((await admin.deleteField(request({ projectId: '1', fieldId }), deps)).success, false);
    assert.equal(deps.writes.length, 0);
  }
});

test('deleteField persists an exclusion so sync cannot silently retrack it', async () => {
  const deps = fixture();
  assert.equal((await admin.deleteField(request({ projectId: '1', fieldId: 'customfield_1' }), deps)).success, true);
  assert.equal(deps.writes[0].state, 'EXCLUDED');
});

test('classification is advisory and always pins the reviewed record', async () => {
  const deps = fixture();
  const result = await admin.classifyFieldsForBaseline(request({ projectId: '1' }), deps);
  assert.equal(result.success, true);
  assert.equal(result.degradedReason, 'AI_DISABLED');
  assert.equal(result.fields.find(f => f.fieldId === 'summary').pinned, true);
  assert.equal(deps.writes.length, 0);
});

test('bulk reviewed baseline pins omitted fields and uses explicit retention choices', async () => {
  const deps = fixture();
  const result = await admin.saveControlledFieldsBaseline(request({ projectId: '1',
    trackedFields: [{ fieldId: 'customfield_1', storeValues: true }], excludedFields: [{ fieldId: 'summary' }] }), deps);
  assert.equal(result.success, true);
  assert.equal(deps.writes.find(f => f.field_id === 'summary').state, 'ACTIVE');
  assert.equal(deps.writes.find(f => f.field_id === 'customfield_1').store_values, true);
  assert.equal(deps.writes.find(f => f.field_id === 'description').store_values, false);
  assert.equal(deps.events.length, 1);
});

test('unknown bulk field or audit failure produces no partial configuration write', async () => {
  for (const [fieldId, options] of [['unknown', {}], ['customfield_1', { auditError: true }]]) {
    const deps = fixture(options);
    assert.equal((await admin.saveControlledFieldsBaseline(request({ projectId: '1', trackedFields: [{ fieldId }] }), deps)).success, false);
    assert.equal(deps.writes.length, 0);
  }
});

test('saveConfig validates AI options and persists disabled setting', async () => {
  const deps = fixture();
  assert.equal((await admin.saveConfig(request({ projectId: '1', config: { ai: { enabled: false } } }), deps)).success, true);
  assert.deepEqual(deps.writes[0].slice(0, 2), ['project:1', { ai: { enabled: false } }]);
  const bad = fixture();
  assert.equal((await admin.saveConfig(request({ config: { ai: { enabled: 'false' } } }), bad)).success, false);
  assert.equal(bad.writes.length, 0);
});

test('field retention refuses string false and requires a declared scope', async () => {
  const deps = fixture();
  assert.equal((await admin.setRetention(request({ projectId: '1', fieldId: 'summary', storeValues: 'false' }), deps)).success, false);
  assert.equal((await admin.setRetention(request({ projectId: '1', fieldId: 'summary', storeValues: true }), deps)).success, false);
  assert.equal(deps.writes.length, 0);
});
