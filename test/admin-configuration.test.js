import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { fixture, request, fixtureGateValidator } from './admin-fixture.js';
// issueTypeId is concrete, never '*': a controlled transition is now
// verified against the one live Jira workflow for this exact project + work
// item type pair (workflowSource.js#readWorkflowForPair takes no wildcard),
// so there is no longer a single workflow to re-check a wildcard scope
// against. The wildcard remains supported everywhere ELSE this app uses
// issue_type_id — see db/configStore.js's "ISSUE TYPE TAKES THE WILDCARD TOO".
const edge = { projectId: '1', issueTypeId: '2', fromStatusId: '*', toStatusId: '2', requiredRole: 'QA', meaning: 'APPROVED', transitionId: '100', requiredAssurance: 'ESIGNATURE' };

test('edge creation stores assurance and the capture policy flag, and no drift switch', async () => {
  const deps = fixture();
  const result = await admin.createControlledTransition(request({ ...edge, requiredAssurance: 'ESIGNATURE', captureBaseline: false }), deps);
  assert.equal(result.success, true);
  const insert = deps.calls.find(c => c.sql.includes('INSERT INTO va_controlled_transition'));
  assert.match(insert.sql, /required_assurance, capture_baseline, require_decision/);
  assert.deepEqual(insert.params.slice(9, 12), ['ESIGNATURE', 0, 0]);
  assert.doesNotMatch(insert.sql, /block_on_drift/);
  assert.equal(deps.events[0].payload.requiredAssurance, 'ESIGNATURE');
});

test('controlled transitions refuse implicit or weaker authentication modes', async () => {
  for (const requiredAssurance of [undefined, 'NATIVE_TRANSITION', 'JSM_APPROVAL']) {
    const deps = fixture();
    const result = await admin.createControlledTransition(request({ ...edge, requiredAssurance }), deps);
    assert.equal(result.success, false, `requiredAssurance=${requiredAssurance} should be rejected`);
  }
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
  const deps = fixture({
    query: sql => ({
      result: true,
      data: sql.startsWith('SELECT state') ? [{ state: 'ACTIVE' }]
        : sql.includes('FROM va_eligibility') ? [{ role: 'QA' }]
        : []
    })
  });
  const result = await admin.updateControlledTransition(request({ ...edge, ctId: 'a'.repeat(32), requiredAssurance: 'ESIGNATURE' }), deps);
  assert.equal(result.success, true);
  assert.equal(deps.calls.some(c => c.sql.startsWith('UPDATE va_controlled_transition')), true);
  assert.equal(deps.calls.some(c => /(?:INSERT|UPDATE).*va_approval/.test(c.sql)), false);
});

// --- Step 5: revalidated against Jira's live workflow, never the browser ---

test('creation refuses a live workflow with no VAtlassian validator attached', async () => {
  const deps = fixture({
    readWorkflowForPair: async () => ({
      id: 'wf-1', name: 'wf',
      transitions: [{ id: '100', name: 'Approve', type: 'GLOBAL', toStatusReference: '2', links: [], validators: [] }]
    })
  });
  const result = await admin.createControlledTransition(request(edge), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /va-gate/);
});

test('creation refuses a live workflow whose gate is attached but disabled', async () => {
  const deps = fixture({
    readWorkflowForPair: async () => ({
      id: 'wf-1', name: 'wf',
      transitions: [{
        id: '100', name: 'Approve', type: 'GLOBAL', toStatusReference: '2', links: [],
        validators: [fixtureGateValidator({ disabled: 'true' })]
      }]
    })
  });
  const result = await admin.createControlledTransition(request(edge), deps);
  assert.equal(result.success, false);
});

test('creation refuses a transition no longer present in the live workflow snapshot', async () => {
  const deps = fixture({
    readWorkflowForPair: async () => ({ id: 'wf-1', name: 'wf', transitions: [] })
  });
  const result = await admin.createControlledTransition(request(edge), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /no longer runs/);
});

test('creation refuses an edge whose live from/to no longer matches the picked edge', async () => {
  const deps = fixture({
    readWorkflowForPair: async () => ({
      id: 'wf-1', name: 'wf',
      transitions: [{
        id: '100', name: 'Approve', type: 'DIRECTED', toStatusReference: '2',
        links: [{ fromStatusReference: '999' }], validators: [fixtureGateValidator()]
      }]
    })
  });
  // edge.fromStatusId is '*' (a GLOBAL pick); the live transition is now DIRECTED
  // from a different status entirely, so the earlier read is stale.
  const result = await admin.createControlledTransition(request(edge), deps);
  assert.equal(result.success, false);
});

test('creation refuses a role nobody currently holds', async () => {
  const deps = fixture({ ineligible: true });
  const result = await admin.createControlledTransition(request(edge), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /No one currently holds/);
});

test('creation refuses a second ACTIVE row over the identical exact edge', async () => {
  const deps = fixture({
    query: sql => ({
      result: true,
      data: sql.includes('FROM va_eligibility') ? [{ role: 'QA' }]
        : sql.includes('FROM va_controlled_transition') && sql.includes('transition_id = ?') ? [{ '1': 1 }]
        : []
    })
  });
  const result = await admin.createControlledTransition(request(edge), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /already governs/);
});

test('an update excludes its own row from the no-conflicting-scope check', async () => {
  const deps = fixture({
    query: sql => ({
      result: true,
      data: sql.startsWith('SELECT state') ? [{ state: 'ACTIVE' }]
        : sql.includes('FROM va_eligibility') ? [{ role: 'QA' }]
        : []
    })
  });
  const result = await admin.updateControlledTransition(request({ ...edge, ctId: 'a'.repeat(32) }), deps);
  assert.equal(result.success, true);
  const conflictCall = deps.calls.find(c => c.sql.includes('FROM va_controlled_transition') && c.sql.includes('transition_id = ?'));
  assert.ok(conflictCall.sql.includes('ct_id !='), 'the row being edited must exclude itself from the conflict check');
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
  assert.equal(deps.writes.find(f => f.field_id === 'description').store_values, true, 'mandatory fields preserve their effective retained default');
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

test('site-wide STRICT mode is refused as unsupported', async () => {
  const deps = fixture();
  const result = await admin.saveConfig(request({ config: { policy: { mode: 'STRICT' } } }), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /not supported/);
  assert.equal(deps.writes.length, 0);
});

test('creating a capture-baseline transition provisions the vault for its project', async () => {
  const deps = fixture();
  const calls = [];
  deps.provisionVault = async (projectId) => { calls.push(projectId); return { errors: [] }; };
  const result = await admin.createControlledTransition(request({ ...edge, captureBaseline: true }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [1]);
});

test('creating a transition without capture-baseline never touches vault provisioning', async () => {
  const deps = fixture();
  let called = false;
  deps.provisionVault = async () => { called = true; return { errors: [] }; };
  const result = await admin.createControlledTransition(request({ ...edge, captureBaseline: false }), deps);
  assert.equal(result.success, true);
  assert.equal(called, false);
});

test('a vault provisioning problem is surfaced as a note but never fails the save', async () => {
  const deps = fixture();
  deps.provisionVault = async () => ({ errors: [{ step: 'ensureVaultProjectRow', error: 'db down' }] });
  const result = await admin.createControlledTransition(request({ ...edge, captureBaseline: true }), deps);
  assert.equal(result.success, true);
  assert.match(result.note, /retry automatically/);
});

test('updating a transition to capture-baseline provisions the vault for its project', async () => {
  const deps = fixture({
    query: sql => ({
      result: true,
      data: sql.startsWith('SELECT state') ? [{ state: 'ACTIVE' }]
        : sql.includes('FROM va_eligibility') ? [{ role: 'QA' }]
        : []
    })
  });
  const calls = [];
  deps.provisionVault = async (projectId) => { calls.push(projectId); return { errors: [] }; };
  const result = await admin.updateControlledTransition(request({ ...edge, ctId: 'a'.repeat(32), captureBaseline: true }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [1]);
});

test('field retention refuses string false and requires a declared scope', async () => {
  const deps = fixture();
  assert.equal((await admin.setRetention(request({ projectId: '1', fieldId: 'summary', storeValues: 'false' }), deps)).success, false);
  assert.equal((await admin.setRetention(request({ projectId: '1', fieldId: 'summary', storeValues: true }), deps)).success, false);
  assert.equal(deps.writes.length, 0);
});

test('wildcard retention cannot disable evidence for a specifically gated issue type', async () => {
  const deps = fixture({ rows: [{ field_id: 'summary', issue_type_id: '*' }] });
  deps.listGatedTransitions = async () => [{ issue_type_id: '2', state: 'ACTIVE', capture_baseline: true }];

  const result = await admin.setRetention(request({ projectId: '1', fieldId: 'summary', storeValues: false }), deps);

  assert.equal(result.success, false);
  assert.match(result.error, /Retention cannot be disabled/);
  assert.equal(deps.writes.length, 0, 'the unsafe wildcard retention change must not persist');
});

test('attachment protection is refused for the whole site: it edits one project\'s permission scheme', async () => {
  const deps = fixture();
  const result = await admin.saveConfig(request({ config: { vault: { lockAttachmentDeletion: true } } }), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /per project/);
  assert.equal(deps.writes.length, 0);
});

test('attachment protection accepts only its one boolean', async () => {
  for (const vault of [{ lockAttachmentDeletion: 'yes' }, { other: true }, []]) {
    const deps = fixture();
    const result = await admin.saveConfig(request({ projectId: '1', config: { vault } }), deps);
    assert.equal(result.success, false, JSON.stringify(vault));
  }
});

test('turning the lockdown on saves it, then applies it to the scheme at once and says what it removed', async () => {
  const deps = fixture();
  const calls = [];
  deps.provisionVault = async (projectId, options) => {
    calls.push([projectId, options.lockdownEnabled, options.forceLock]);
    return { errors: [], lockdown: { grantsRemoved: 2, otherProjectKeys: ['SEC'] } };
  };
  const result = await admin.saveConfig(request({ projectId: '1', config: { vault: { lockAttachmentDeletion: true } } }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(deps.writes[0].slice(0, 2), ['project:1', { vault: { lockAttachmentDeletion: true } }]);
  assert.deepEqual(calls, [[1, true, true]]);
  assert.match(result.note, /2 grants removed/);
  assert.match(result.note, /SEC lost these grants too/);
});

test('turning the lockdown off clears the lock and says the removed grants are not put back', async () => {
  const deps = fixture();
  deps.readConfigRecord = async () => ({ config: { vault: { lockAttachmentDeletion: true } }, revision: 'r1' });
  const unlocked = [];
  deps.markPermissionUnlocked = async args => unlocked.push(args);
  deps.provisionVault = async () => { throw new Error('turning off must not provision'); };
  const result = await admin.saveConfig(request({ projectId: '1', config: { vault: { lockAttachmentDeletion: false } } }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(unlocked, [{ projectId: 1 }]);
  const off = deps.events.find(e => e.eventType === 'ATTACHMENT_DELETE_LOCK_DISABLED');
  assert.deepEqual(off.payload, { projectId: 1, grantsRestored: false });
  assert.match(result.note, /not put back/);
});

test('a save that leaves the lockdown as it was touches no permission scheme', async () => {
  const deps = fixture();
  deps.provisionVault = async () => { throw new Error('unchanged setting must not provision'); };
  const result = await admin.saveConfig(request({ projectId: '1', config: { ai: { enabled: false } } }), deps);
  assert.equal(result.success, true);
  assert.equal(result.note, undefined);
});

test('vault status reports the lockdown setting, what was applied, the app grant and the scheme', async () => {
  const deps = fixture();
  let walked = false;
  Object.assign(deps, {
    projectConfig: async () => ({ vault: { lockAttachmentDeletion: false } }),
    getVaultSpace: async () => ({ permission_locked_at: 1700, permission_scheme_id: '10000', app_delete_granted_at: 1600, app_delete_checked_at: null }),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default Permission Scheme', permissions: [] }),
    getProjectsUsingPermissionScheme: async () => { walked = true; return ['SEC']; }
  });
  const result = await admin.getVaultStatus(request({ projectId: '1' }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(result.vault, { storage: 'OBJECT_STORE' });
  assert.deepEqual(result.lockdown, { enabled: false, lockedAt: 1700, lockedSchemeId: '10000' },
    'a lock applied before the setting existed is still reported');
  assert.deepEqual(result.appDelete, { grantedAt: 1600, refusedAt: null });
  assert.deepEqual(result.scheme, { id: 10000, name: 'Default Permission Scheme' });
  assert.equal(result.sharedWith, null);
  assert.equal(walked, false, 'the site-wide project walk only runs when asked');

  const shared = await admin.getVaultStatus(request({ projectId: '1', checkSharing: true }), deps);
  assert.deepEqual(shared.sharedWith, ['SEC']);
});

test('vault status still answers when the scheme cannot be read', async () => {
  const deps = fixture();
  Object.assign(deps, {
    projectConfig: async () => ({}),
    getVaultSpace: async () => null,
    getProjectPermissionScheme: async () => { throw new Error('403'); },
    getProjectsUsingPermissionScheme: async () => []
  });
  const result = await admin.getVaultStatus(request({ projectId: '1', checkSharing: true }), deps);
  assert.equal(result.success, true);
  assert.equal(result.scheme, null);
  assert.match(result.schemeError, /403/);
  assert.deepEqual(result.vault, { storage: 'OBJECT_STORE' });
  assert.equal(result.lockdown.enabled, false);
});
