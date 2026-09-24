import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { EVENT } from '../src/lib/ledger.js';
import { DEFAULT_PROJECT_CONFIG } from '../src/db/configStore.js';
import { validateConfig } from '../src/usecases/fieldsValidation.js';
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
      return { config: { enabled: true, queueThreshold: 'MINOR' }, revision: 'rev-site' };
    };
    deps.projectConfig = async (pid) => {
      assert.equal(pid, null);
      return { enabled: true, queueThreshold: 'MINOR' };
    };
    const getRes = await admin.getConfig(request({ projectId: emptyPid }), deps);
    assert.equal(getRes.success, true);
    assert.equal(getRes.revision, 'rev-site');

    const saveRes = await admin.saveConfig(request({
      projectId: emptyPid,
      expectedRevision: 'rev-site',
      config: { enabled: false, queueThreshold: 'CRITICAL', restore: { actAs: 'user', notifyUsers: true } }
    }), deps);
    assert.equal(saveRes.success, true);
    assert.equal(deps.writes[0][0], 'site');
    assert.equal(deps.writes[0][1].enabled, false);
    assert.equal(deps.writes[0][1].queueThreshold, 'CRITICAL');
    assert.equal(deps.writes[0][1].restore.actAs, 'user');
    assert.equal(deps.writes[0][1].restore.notifyUsers, true);
  }
});

test('saveConfig rejects malformed restore settings', async () => {
  const deps = fixture();
  // invalid notifyUsers type
  const invalidNotify = await admin.saveConfig(request({
    projectId: '1',
    config: { restore: { notifyUsers: 'not-a-bool' } }
  }), deps);
  assert.equal(invalidNotify.success, false);

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

  // an unknown restore key is refused rather than stored
  const unknownKey = await admin.saveConfig(request({
    projectId: '1',
    config: { restore: { unknownSetting: true } }
  }), deps);
  assert.equal(unknownKey.success, false);
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

test('transition update rejects a changed rule revision and a concurrent revoke', async () => {
  const payload = { ctId: 'a'.repeat(32), projectId: '1', issueTypeId: '2', fromStatusId: '*',
    toStatusId: '2', transitionId: '100', requiredRole: 'QA', meaning: 'Approved', requiredAssurance: 'ESIGNATURE' };
  for (const extra of [{ expectedRevision: 'stale' }, {}]) {
    const deps = fixture({ query: sql => ({ result: true, data: sql.startsWith('SELECT state') ? [{ state: 'ACTIVE' }]
      : sql.includes('FROM va_eligibility') ? [{ role: 'QA' }]
      : sql.startsWith('UPDATE va_controlled_transition') ? { affectedRows: 0 } : [] }) });
    const result = await admin.updateControlledTransition(request({ ...payload, ...extra }), deps);
    assert.equal(result.success, false);
    assert.match(result.error, /changed|revoked|Reload/i);
  }
});

test('classification preserves implicit mandatory field retention under capture policy', async () => {
  const deps = fixture();
  deps.listGatedTransitions = async () => [{ state: 'ACTIVE', issue_type_id: '2', capture_baseline: true }];
  const result = await admin.saveControlledFieldsBaseline(request({ projectId: '1', trackedFields: [{ fieldId: 'summary', storeValues: true }] }), deps);
  assert.equal(result.success, true, result.error);
  assert.equal(deps.writes.find(f => f.field_id === 'description').store_values, true);
});

// ── Settings that must reach a runtime consumer ──────────────────────────────
// Each key below is asserted to persist because a specific module reads it.
// If a consumer is ever deleted, retire the setting rather than leaving the
// page offering a control that no longer changes anything.

test('settings with verified runtime consumers are persisted exactly as chosen', async () => {
  const cases = [
    // src/lib/collect.js:119, capture.js:77, panelAccess.js:69
    [{ enabled: false }, c => assert.equal(c.enabled, false)],
    // src/lib/collect.js:293 shouldQueue(), diff/index.js, panelAccess.js:91
    [{ queueThreshold: 'MAJOR' }, c => assert.equal(c.queueThreshold, 'MAJOR')],
    // src/lib/collect.js:97, transitionPlan.js, interception.js
    [{ reviewStatusIds: ['3', '4'] }, c => assert.deepEqual(c.reviewStatusIds, ['3', '4'])],
    // src/lib/restore/executor.js:100
    [{ restore: { notifyUsers: true } }, c => assert.equal(c.restore.notifyUsers, true)],
    // src/lib/restore/executor.js:99
    [{ restore: { actAs: 'user' } }, c => assert.equal(c.restore.actAs, 'user')],
    // src/lib/restore/executor.js:159
    [{ restore: { perFieldRetries: 5 } }, c => assert.equal(c.restore.perFieldRetries, 5)],
    // src/lib/aiClassification.js:331, report.js:238
    [{ ai: { maxCompletionTokens: 8192 } }, c => assert.equal(c.ai.maxCompletionTokens, 8192)]
  ];
  for (const [config, check] of cases) {
    const deps = fixture();
    const result = await admin.saveConfig(request({ projectId: '1', config }), deps);
    assert.equal(result.success, true, `${JSON.stringify(config)}: ${result.error}`);
    check(deps.writes.at(-1)[1]);
  }
});

test('settings with no runtime consumer are refused rather than silently stored', async () => {
  for (const config of [
    { visibility: 'all' },
    { notifications: { digest: false } },
    { restore: { commentOnRestore: false } }
  ]) {
    const deps = fixture();
    const result = await admin.saveConfig(request({ projectId: '1', config }), deps);
    assert.equal(result.success, false, `${JSON.stringify(config)} was accepted`);
    assert.equal(deps.writes.length, 0);
  }
});

test('a legacy stored setting does not block saving the settings that still work', async () => {
  // saveConfig re-validates the MERGE of stored and incoming config. A value
  // written before the key was retired must not make every later save fail.
  const deps = fixture();
  deps.readConfigRecord = async () => ({
    config: { visibility: 'all', notifications: { digest: true }, restore: { commentOnRestore: true, notifyUsers: false } },
    revision: 'legacy'
  });
  const result = await admin.saveConfig(request({ projectId: '1', expectedRevision: 'legacy', config: { queueThreshold: 'CRITICAL' } }), deps);
  assert.equal(result.success, true, result.error);
  const saved = deps.writes.at(-1)[1];
  assert.equal(saved.queueThreshold, 'CRITICAL');
  assert.equal(saved.visibility, undefined, 'retired key was carried forward');
  assert.equal(saved.notifications, undefined, 'retired key was carried forward');
  assert.equal(saved.restore.commentOnRestore, undefined, 'retired key was carried forward');
  assert.equal(saved.restore.notifyUsers, false, 'a working sibling setting was dropped');
});

test('audit failure prevents a settings change from being written', async () => {
  // 21 CFR 11.10(e): a configuration change that cannot be recorded in the
  // audit trail must not take effect, or the record and the running
  // configuration disagree with no way to tell when they diverged.
  const deps = fixture({ auditError: true });
  const result = await admin.saveConfig(request({ projectId: '1', config: { queueThreshold: 'MAJOR' } }), deps);
  assert.equal(result.success, false);
  assert.equal(deps.writes.length, 0);
});

test('the audit record of a settings change names the scope and the resulting values', async () => {
  const deps = fixture();
  await admin.saveConfig(request({ projectId: '1', config: { queueThreshold: 'MAJOR' } }), deps);
  const event = deps.events.at(-1);
  assert.equal(event.eventType, EVENT.CONFIG_CHANGED);
  assert.equal(event.payload.scope, 'project:1');
  assert.equal(event.payload.config.queueThreshold, 'MAJOR');
});

test('every default configuration key is one the validator still accepts', async () => {
  // Guards the invariant this page depends on: a key present in the defaults
  // but rejected by the validator can be read and rendered yet never saved,
  // and a key the validator accepts but no default declares has no documented
  // meaning. Either drift puts a control on screen that misleads.
  const walk = (value, prefix = '') => Object.entries(value).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? walk(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  const defaults = walk(DEFAULT_PROJECT_CONFIG);
  // Every default round-trips through validateConfig unchanged.
  assert.deepEqual(validateConfig(structuredClone(DEFAULT_PROJECT_CONFIG)), DEFAULT_PROJECT_CONFIG);
  // And no retired key crept back into the defaults.
  for (const dead of ['visibility', 'notifications.digest', 'restore.commentOnRestore']) {
    assert.equal(defaults.includes(dead), false, `${dead} was retired but is back in the defaults`);
  }
});

// ── The audit ledger is append-only and admin-only ───────────────────────────

test('no code path updates or deletes an audit ledger row', async () => {
  // 21 CFR 11.10(e): the audit trail must not be modifiable. The hash chain
  // makes tampering detectable; this makes it unwritable in the first place.
  // A reviewer adding an UPDATE or DELETE against va_audit fails here.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = dir => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : [];
  });
  const offenders = walk('src').filter(path => !path.endsWith('migrations.js')).filter(path =>
    /(UPDATE\s+va_audit|DELETE\s+FROM\s+va_audit|TRUNCATE\s+(TABLE\s+)?va_audit|DROP\s+TABLE\s+(IF\s+EXISTS\s+)?va_audit|ALTER\s+TABLE\s+va_audit)/i
      .test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, [], `these files mutate the audit ledger: ${offenders.join(', ')}`);
});

test('reading the audit ledger requires an active VAtlassian administrator', async () => {
  for (const options of [{ unauthorized: true }, { authError: true }]) {
    const deps = fixture(options);
    const result = await admin.listLedger(request({ issueKey: '' }), deps);
    assert.equal(result.success, false);
    assert.match(result.error, /administrator|Unauthorized|Database/i);
  }
});

test('ledger counts come from the whole issue, not the page being displayed', async () => {
  // The strip says "N events recorded in total" while the table below is
  // paginated. If the totals were derived from the fetched page they would
  // shrink as a reader pages back through history.
  const deps = fixture({ query: sql => {
    if (sql.includes('COUNT(*)')) return { result: true, data: [
      { event_type: 'SIGNATURE_CONSUMED', c: 2 }, { event_type: 'BASELINE_CAPTURED', c: 5 }] };
    if (sql.includes('FROM va_audit')) return { result: true, data: [] };
    return { result: true, data: [] };
  } });
  deps.route = (parts, ...v) => parts.reduce((s, p, i) => s + p + (v[i] ?? ''), '');
  deps.asApp = () => ({ requestJira: async () => ({ ok: true, json: async () => ({ id: '10006', key: 'VJIRA-6', fields: {} }) }) });
  const result = await admin.listLedger(request({ issueKey: 'VJIRA-6', limit: 1 }), deps);
  assert.equal(result.success, true, result.error);
  assert.equal(result.counts.SIGNATURE_CONSUMED, 2);
  // 2 + 5 = the "7 events recorded in total" the strip renders.
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), 7);
  assert.equal(result.entries.length, 0, 'page contents must not change the totals');
});

test('the ledger head reports new activity without re-reading the whole page', async () => {
  const seen = [];
  const deps = fixture({ query: (sql, params) => {
    seen.push({ sql, params });
    return { result: true, data: [{ max_seq: 42 }] };
  } });
  const site = await admin.ledgerHead(request(), deps);
  assert.equal(site.success, true, site.error);
  assert.equal(site.maxSeq, 42);
  const scoped = await admin.ledgerHead(request({ issueId: '10006' }), deps);
  assert.equal(scoped.maxSeq, 42);
  assert.match(seen.at(-1).sql, /issue_id = \?/);
  assert.deepEqual(seen.at(-1).params, ['10006']);
  // An empty ledger is a head of 0, not a failure.
  const empty = fixture({ query: () => ({ result: true, data: [{ max_seq: null }] }) });
  assert.equal((await admin.ledgerHead(request(), empty)).maxSeq, 0);
});

test('a failed ledger head read is reported rather than implying no new activity', async () => {
  const deps = fixture({ query: () => ({ result: false }) });
  const result = await admin.ledgerHead(request(), deps);
  assert.equal(result.success, false);
});

// ── Jira administrators own the roster; VAtlassian administrators own the controls ──

test('a Jira administrator who is not a VAtlassian administrator can read and grant the roster', async () => {
  for (const [fn, payload] of [['listAdmins', {}], ['grantAdmin', { targetAccountId: 'reviewer' }]]) {
    const deps = fixture({ unauthorized: true });
    deps.isJiraAdmin = async () => true;
    deps.lookupUsers = async ids => new Map(ids.map(id => [id, { displayName: `User ${id}`, active: true }]));
    const result = await admin[fn](request(payload), deps);
    assert.equal(result.success, true, `${fn}: ${result.error}`);
  }
});

test('a Jira administrator cannot configure controls without being a VAtlassian administrator', async () => {
  // Appointing administrators is the Jira administrator's power. Everything
  // that decides what is approved, signed, captured or retained is not.
  const attempts = [
    ['saveConfig', { projectId: '1', config: { queueThreshold: 'MAJOR' } }],
    ['createControlledTransition', { projectId: '1', issueTypeId: '2', fromStatusId: '*', toStatusId: '2',
      transitionId: '100', requiredRole: 'QA', meaning: 'Approved', requiredAssurance: 'ESIGNATURE' }],
    ['grantEligibility', { targetAccountId: 'reviewer', projectId: '1', issueTypeId: '*', role: 'QA' }],
    ['listLedger', { issueKey: '' }],
    ['setRetentionPolicy', { days: 3650 }]
  ];
  for (const [fn, payload] of attempts) {
    const deps = fixture({ unauthorized: true });
    deps.isJiraAdmin = async () => true;
    const result = await admin[fn](request(payload), deps);
    assert.equal(result.success, false, `${fn} was allowed for a non-VAtlassian administrator`);
    assert.match(result.error, /VAtlassian administrator/i, fn);
  }
});

test('somebody who is neither kind of administrator can do nothing', async () => {
  for (const fn of ['listAdmins', 'grantAdmin', 'revokeAdmin']) {
    const deps = fixture({ unauthorized: true });
    deps.isJiraAdmin = async () => false;
    const result = await admin[fn](request({ targetAccountId: 'reviewer' }), deps);
    assert.equal(result.success, false, fn);
  }
});

test('the audit record says which authority appointed an administrator', async () => {
  // A grant made on Jira-administrator authority and one made by an existing
  // VAtlassian administrator are different acts and must not read alike.
  const asJira = fixture({ unauthorized: true });
  asJira.isJiraAdmin = async () => true;
  asJira.lookupUsers = async ids => new Map(ids.map(id => [id, { displayName: 'R', active: true }]));
  await admin.grantAdmin(request({ targetAccountId: 'reviewer' }), asJira);
  assert.equal(asJira.events.at(-1).payload.via, 'JIRA_ADMIN');

  const asAdmin = fixture();
  asAdmin.lookupUsers = async ids => new Map(ids.map(id => [id, { displayName: 'R', active: true }]));
  await admin.grantAdmin(request({ targetAccountId: 'reviewer' }), asAdmin);
  assert.equal(asAdmin.events.at(-1).payload.via, 'ADMIN');
});

test('access check reports Jira administrator standing so the console can route correctly', async () => {
  const deps = fixture({ unauthorized: true });
  deps.isJiraAdmin = async () => true;
  const result = await admin.check(request(), deps);
  assert.equal(result.isAdmin, false);
  assert.equal(result.isJiraAdmin, true);
  // A failed permission read must not be reported as standing.
  const broken = fixture({ unauthorized: true });
  broken.isJiraAdmin = async () => { throw new Error('Jira unreachable'); };
  assert.equal((await admin.check(request(), broken)).isJiraAdmin, false);
});
