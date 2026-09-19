import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { fixture, request } from './admin-fixture.js';

function jira(deps, respond) {
  deps.route = (parts, ...values) => parts.reduce((s, p, i) => s + p + (values[i] ?? ''), '');
  deps.asApp = () => ({ requestJira: async path => ({ ok: true, json: async () => respond(String(path)) }) });
  return deps;
}

test('project selector reads every page and refuses an incomplete listing', async () => {
  const paths = [];
  const deps = jira(fixture(), path => {
    paths.push(path);
    return paths.length === 1 ? { values: [{ id: '1', name: 'First' }], isLast: false }
      : { values: [{ id: '2', name: 'Second' }], isLast: true };
  });
  const result = await admin.listProjects(request(), deps);
  assert.deepEqual(result.projects.map(p => p.id), ['1', '2']);
  assert.match(paths[1], /startAt=1/);
});

test('content changes carry their actual issue link and timestamp', async () => {
  const deps = fixture({ query: () => ({ result: true, data: [{ drift_id: 'd', issue_id: 123,
    issue_key: 'ONE-3', summary: 'Approved record', field_name: 'Summary', occurred_at: 1750000000000 }] }) });
  const result = await admin.listContentChanges(request(), deps);
  assert.equal(result.changes[0].issueKey, 'ONE-3');
  assert.equal(result.changes[0].changedAt, 1750000000000);
  assert.match(deps.calls.at(-1).sql, /JOIN va_item_state/);
});

test('control health fails closed if legacy rule coverage cannot be read', async () => {
  const deps = fixture({ query: sql => ({ result: !sql.includes('transition_id IS NULL'), data: [] }) });
  const result = await admin.listGateFindings(request(), deps);
  assert.equal(result.success, false);
});

test('alert destination is validated and persisted together in one statement', async () => {
  const deps = jira(fixture(), () => [{ id: '2', subtask: false }]);
  deps.ALERT_PROJECT_CFG = 'alert.projectId'; deps.ALERT_ISSUE_TYPE_CFG = 'alert.issueTypeId';
  const result = await admin.setAlertDestination(request({ projectId: '1', issueTypeId: '2' }), deps);
  assert.equal(result.success, true, result.error);
  const writes = deps.calls.filter(c => c.sql.includes('INSERT INTO va_config'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params.filter(v => typeof v === 'string' && v.startsWith('alert.')), ['alert.projectId', 'alert.issueTypeId']);
});

test('alert destination rejects issue types from another project and subtasks', async () => {
  for (const types of [[{ id: '3' }], [{ id: '2', subtask: true }]]) {
    const deps = jira(fixture(), () => types);
    const result = await admin.setAlertDestination(request({ projectId: '1', issueTypeId: '2' }), deps);
    assert.equal(result.success, false);
    assert.equal(deps.calls.some(c => /INSERT/.test(c.sql)), false);
  }
});

test('audit failure prevents retention, alert and role mutations', async () => {
  for (const [fn, payload] of [
    ['setRetentionPolicy', { days: 3650 }],
    ['setRetentionPolicy', { days: null }],
    ['setAlertDestination', { projectId: '1', issueTypeId: '2' }],
    ['grantEligibility', { targetAccountId: 'reviewer', projectId: '1', issueTypeId: '*', role: 'QA' }],
    ['revokeEligibility', { elId: 'a'.repeat(32) }]
  ]) {
    const deps = jira(fixture({ auditError: true }), () => [{ id: '2' }]);
    const result = await admin[fn](request(payload), deps);
    assert.equal(result.success, false, fn);
    assert.equal(deps.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql.trim())), false, fn);
  }
});

test('retention days and acknowledgement change atomically', async () => {
  for (const days of [3650, null]) {
    const deps = fixture();
    const result = await admin.setRetentionPolicy(request({ days }), deps);
    assert.equal(result.success, true);
    assert.equal(deps.calls.filter(c => /^(INSERT|DELETE)/.test(c.sql.trim())).length, 1);
  }
});

test('unsupported STRICT policy cannot be enabled even with no drift', async () => {
  const deps = fixture(); deps.hasUnresolvedDrift = async () => false;
  const result = await admin.saveConfig(request({ projectId: '1', config: { policy: { mode: 'STRICT' } } }), deps);
  assert.equal(result.success, false);
  assert.equal(deps.writes.length, 0);
});

test('classification cannot bypass retention requirements of an active capture policy', async () => {
  const deps = fixture();
  deps.listGatedTransitions = async () => [{ state: 'ACTIVE', issue_type_id: '2', capture_baseline: true }];
  const result = await admin.saveControlledFieldsBaseline(request({ projectId: '1',
    trackedFields: [{ fieldId: 'customfield_1', storeValues: false }] }), deps);
  assert.equal(result.success, false);
  assert.equal(deps.writes.length, 0);
});

test('field setup identifies mandatory fields and undeclared retention settings', async () => {
  const result = await admin.fieldSetup(request({ projectId: '1' }), fixture());
  const summary = result.controlled.find(f => f.field_id === 'summary');
  assert.equal(summary.pinned, true);
  assert.equal(summary.declared, false);
});

test('capture policy ignores retention on explicitly excluded fields', async () => {
  const deps = fixture({ rows: [{ field_id: 'customfield_1', state: 'EXCLUDED', store_values: false }] });
  const result = await admin.createControlledTransition(request({ projectId: '1', issueTypeId: '2',
    fromStatusId: '*', toStatusId: '2', transitionId: '100', requiredRole: 'QA', meaning: 'Approved',
    requiredAssurance: 'ESIGNATURE', captureBaseline: true }), deps);
  assert.equal(result.success, true, result.error);
});

test('saving one project setting preserves other overrides and rejects stale revisions', async () => {
  const deps = fixture();
  deps.readConfigRecord = async () => ({ config: { ai: { enabled: true, maxCompletionTokens: 2048 }, queueThreshold: 'MAJOR' }, revision: 'current' });
  const result = await admin.saveConfig(request({ projectId: '1', expectedRevision: 'current', config: { ai: { enabled: false } } }), deps);
  assert.equal(result.success, true, result.error);
  assert.deepEqual(deps.writes[0][1], { ai: { enabled: false, maxCompletionTokens: 2048 }, queueThreshold: 'MAJOR' });
  const stale = await admin.saveConfig(request({ projectId: '1', expectedRevision: 'old', config: { ai: { enabled: true } } }), deps);
  assert.equal(stale.success, false);
  assert.equal(deps.writes.length, 1);
});

test('a concurrent configuration write is surfaced instead of claiming success', async () => {
  const deps = fixture(); deps.setConfigIfCurrent = async () => false;
  assert.equal((await admin.saveConfig(request({ projectId: '1', config: { ai: { enabled: false } } }), deps)).success, false);
});

test('getConfig and saveConfig handle site-wide defaults with null or empty projectId', async () => {
  for (const emptyPid of [null, '', 'site', undefined]) {
    const deps = fixture();
    deps.readConfigRecord = async (key) => {
      assert.equal(key, 'site');
      return { config: { enabled: true, visibility: 'reviewer-only' }, revision: 'rev-site' };
    };
    deps.projectConfig = async (pid) => {
      assert.equal(pid, null);
      return { enabled: true, visibility: 'reviewer-only' };
    };
    const getRes = await admin.getConfig(request({ projectId: emptyPid }), deps);
    assert.equal(getRes.success, true);
    assert.equal(getRes.revision, 'rev-site');

    const saveRes = await admin.saveConfig(request({
      projectId: emptyPid,
      expectedRevision: 'rev-site',
      config: { enabled: false, visibility: 'all', queueThreshold: 'CRITICAL', restore: { commentOnRestore: false, notifyUsers: true } }
    }), deps);
    assert.equal(saveRes.success, true);
    assert.equal(deps.writes[0][0], 'site');
    assert.equal(deps.writes[0][1].enabled, false);
    assert.equal(deps.writes[0][1].visibility, 'all');
    assert.equal(deps.writes[0][1].queueThreshold, 'CRITICAL');
    assert.equal(deps.writes[0][1].restore.commentOnRestore, false);
    assert.equal(deps.writes[0][1].restore.notifyUsers, true);
  }
});

test('saveConfig rejects invalid restore and notification settings', async () => {
  const deps = fixture();
  // invalid restore setting
  const invalidRestore = await admin.saveConfig(request({
    projectId: '1',
    config: { restore: { commentOnRestore: 'not-a-bool' } }
  }), deps);
  assert.equal(invalidRestore.success, false);

  // invalid actAs
  const invalidActAs = await admin.saveConfig(request({
    projectId: '1',
    config: { restore: { actAs: 'malicious' } }
  }), deps);
  assert.equal(invalidActAs.success, false);

  // invalid perFieldRetries
  const invalidRetries = await admin.saveConfig(request({
    projectId: '1',
    config: { restore: { perFieldRetries: 50 } }
  }), deps);
  assert.equal(invalidRetries.success, false);

  // invalid notification digest
  const invalidDigest = await admin.saveConfig(request({
    projectId: '1',
    config: { notifications: { digest: 'not-bool' } }
  }), deps);
  assert.equal(invalidDigest.success, false);
});

test('grantEligibility supports site-wide scope with empty or null projectId', async () => {
  const deps = fixture();
  deps.lookupUsers = async () => new Map([['reviewer', { displayName: 'Reviewer', active: true }]]);
  const res = await admin.grantEligibility(request({
    targetAccountId: 'reviewer',
    issueTypeId: '*',
    role: 'QA Lead',
    projectId: ''
  }), deps);
  assert.equal(res.success, true, res.error);
  const insert = deps.calls.find(c => c.sql.includes('INSERT INTO va_eligibility'));
  assert.ok(insert);
  // project_id is null for site-wide
  assert.equal(insert.params[insert.params.length - 1], null);
});

test('listContentChanges supports filtering by projectId', async () => {
  const deps = fixture({
    query: (sql, params) => {
      assert.match(sql, /AND d\.project_id = \?/);
      assert.deepEqual(params, ['123']);
      return { result: true, data: [] };
    }
  });
  const res = await admin.listContentChanges(request({ projectId: '123' }), deps);
  assert.equal(res.success, true);
});

