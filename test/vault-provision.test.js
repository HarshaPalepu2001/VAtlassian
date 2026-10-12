import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAppDeleteGrant, lockAttachmentDeletion, provisionVault } from '../src/lib/vaultProvision.js';

function baseDeps(overrides = {}) {
  let vaultSpace = null;
  return {
    getVaultSpace: async () => vaultSpace,
    insertVaultSpace: async (args) => { vaultSpace = { ...args }; },
    projectFor: async () => ({ key: 'ENG', name: 'Engineering' }),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [] }),
    getProjectsUsingPermissionScheme: async () => ['ENG'],
    attachmentDeleteGrantIds: () => [],
    removeAttachmentDeleteGrants: async () => {},
    markPermissionLocked: async () => {},
    appJiraAccountId: async () => 'app-jira-1',
    hasAppDeleteGrant: () => true,
    grantAppAttachmentDelete: async () => ({}),
    markAppDeleteGranted: async () => {},
    markAppDeleteChecked: async () => {},
    projectConfig: async () => ({ vault: { lockAttachmentDeletion: false } }),
    ensureVaultProjectRow: async () => true,
    tryAppend: async () => {},
    now: () => 1000,
    actorAccountId: 'system',
    ...overrides
  };
}

test('lockAttachmentDeletion removes attachment-delete grants, records the scheme and who held each grant', async () => {
  const calls = [];
  let locked = null;
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1' }),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [
      { id: 1, permission: 'DELETE_OWN_ATTACHMENTS', holder: { type: 'applicationRole', value: 'jira-software' } },
      { id: 2, permission: 'BROWSE_PROJECTS', holder: { type: 'applicationRole' } }] }),
    attachmentDeleteGrantIds: (scheme) => scheme.permissions.filter(p => p.permission.includes('ATTACHMENTS')).map((p) => p.id),
    removeAttachmentDeleteGrants: async (args) => calls.push(['remove', args]),
    markPermissionLocked: async (args) => calls.push(['mark', args]),
    tryAppend: async (event) => { calls.push(['audit', event.eventType]); if (event.eventType === 'ATTACHMENT_DELETE_LOCKED') locked = event.payload; }
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.schemeId, 10000);
  assert.equal(result.grantsRemoved, 1);
  assert.deepEqual(calls.map((c) => c[0]), ['remove', 'mark', 'audit']);
  assert.equal(calls[2][1], 'ATTACHMENT_DELETE_LOCKED');
  assert.deepEqual(locked.removedGrants, [{ id: 1, permission: 'DELETE_OWN_ATTACHMENTS',
    holder: { type: 'applicationRole', value: 'jira-software', name: null } }], 'enough to re-add it by hand');
});

test('lockAttachmentDeletion skips the removal call when there is nothing to remove', async () => {
  let removeCalled = false;
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1' }),
    removeAttachmentDeleteGrants: async () => { removeCalled = true; }
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.grantsRemoved, 0);
  assert.equal(removeCalled, false);
});

test('with the lockdown OFF (the default) provisioning never touches the scheme, but the app keeps its own right to delete', async () => {
  const calls = [];
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1', project_page_id: 'pp1' }),
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => calls.push('grant'),
    attachmentDeleteGrantIds: () => { calls.push('select'); return [1]; },
    removeAttachmentDeleteGrants: async () => calls.push('remove'),
    getProjectsUsingPermissionScheme: async () => { calls.push('walk'); return []; },
    markPermissionLocked: async () => calls.push('locked')
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.lockdownEnabled, false);
  assert.equal(result.lockdown, null);
  assert.equal(result.appDelete.appGrantAdded, true);
  assert.deepEqual(calls, ['grant'], 'no grant is removed, and the site-wide project walk never runs');
});

test('a lockdown setting that cannot be read counts as OFF', async () => {
  let removed = false;
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1', project_page_id: 'pp1' }),
    projectConfig: async () => { throw new Error('db down'); },
    attachmentDeleteGrantIds: () => [1],
    removeAttachmentDeleteGrants: async () => { removed = true; }
  });
  const result = await provisionVault(7, deps);
  assert.equal(removed, false);
  assert.equal(result.lockdownEnabled, false);
  assert.equal(result.errors[0].step, 'readLockdownSetting');
});

test('provisionVault with the lockdown ON runs every step and reports no errors on success', async () => {
  const deps = baseDeps({
    getVaultSpace: async () => ({ permission_locked_at: null }),
    projectConfig: async () => ({ vault: { lockAttachmentDeletion: true } })
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.lockdownEnabled, true);
  assert.equal(result.lockdown.schemeId, 10000);
});

test('provisionVault never throws and records error when ensureVaultProjectRow fails', async () => {
  const deps = baseDeps({
    ensureVaultProjectRow: async () => { throw new Error('db down'); }
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors.map(e => e.step), ['ensureVaultProjectRow', 'ensureAppDeleteGrant']);
});

test('provisionVault records the lockdown failure independently', async () => {
  let space = null;
  const deps = baseDeps({
    lockdownEnabled: true,
    getVaultSpace: async () => space,
    ensureVaultProjectRow: async () => { space = { app_delete_granted_at: 5 }; return true; },
    getProjectPermissionScheme: async () => { throw new Error('jira down'); }
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.lockdown, null);
  assert.deepEqual(result.errors.map(e => e.step), ['lockAttachmentDeletion'], 'a recorded app grant costs no scheme read');
});

test('a locked project costs no scheme read on the hourly re-run', async () => {
  let schemeRead = false;
  const deps = baseDeps({
    lockdownEnabled: true,
    getVaultSpace: async () => ({ permission_locked_at: 123, app_delete_granted_at: 124 }),
    getProjectPermissionScheme: async () => { schemeRead = true; return { id: 1, permissions: [] }; }
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.lockdown.alreadyLocked, true);
  assert.equal(schemeRead, false, 'the backfill re-runs provisioning; a locked project must cost no Jira calls');
});

test('turning the lockdown on again reads the scheme and removes grants a person re-added', async () => {
  const removed = [];
  let locked = null;
  const deps = baseDeps({
    lockdownEnabled: true,
    forceLock: true,
    getVaultSpace: async () => ({ permission_locked_at: 123, app_delete_granted_at: 124 }),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [{ id: 9, permission: 'DELETE_ALL_ATTACHMENTS' }] }),
    attachmentDeleteGrantIds: (scheme) => scheme.permissions.map(p => p.id),
    removeAttachmentDeleteGrants: async ({ grantIds }) => removed.push(...grantIds),
    tryAppend: async (event) => { if (event.eventType === 'ATTACHMENT_DELETE_LOCKED') locked = event.payload; }
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(removed, [9]);
  assert.equal(result.lockdown.relocked, true);
  assert.equal(locked.relocked, true);
});

test('lockdown audit payload includes otherProjectKeys sharing the scheme', async () => {
  let auditEvent = null;
  const deps = baseDeps({
    getVaultSpace: async () => ({}),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [{ id: 1, permission: 'DELETE_OWN_ATTACHMENTS' }] }),
    attachmentDeleteGrantIds: (scheme) => scheme.permissions.map((p) => p.id),
    getProjectsUsingPermissionScheme: async () => ['ENG', 'SEC'],
    tryAppend: async (event) => { if (event.eventType === 'ATTACHMENT_DELETE_LOCKED') auditEvent = event; }
  });
  await lockAttachmentDeletion(7, deps);
  assert.ok(auditEvent, 'audit event must be recorded');
  assert.deepEqual(auditEvent.payload.otherProjectKeys, ['ENG', 'SEC']);
});

test('the app keeps its own right to delete: its grant is added first and never removed', async () => {
  const calls = [];
  const deps = baseDeps({
    getVaultSpace: async () => ({}),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [
      { id: 1, permission: 'DELETE_ALL_ATTACHMENTS', holder: { type: 'projectRole', value: '10002' } }] }),
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async (args) => calls.push(['grant', args]),
    markAppDeleteGranted: async () => calls.push(['granted']),
    attachmentDeleteGrantIds: (scheme, options) => { calls.push(['select', options]); return [1]; },
    removeAttachmentDeleteGrants: async (args) => calls.push(['remove', args.grantIds]),
    markPermissionLocked: async () => calls.push(['locked']),
    tryAppend: async (event) => calls.push(['audit', event.eventType])
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.deepEqual(calls.map(c => c[0]), ['grant', 'granted', 'audit', 'select', 'remove', 'locked', 'audit']);
  assert.deepEqual(calls[0][1], { schemeId: 10000, accountId: 'app-jira-1' });
  assert.deepEqual(calls[3][1], { keepAccountId: 'app-jira-1' }, 'the app grant is excluded from removal');
  assert.equal(calls[2][1], 'ATTACHMENT_DELETE_GRANTED_TO_APP');
  assert.equal(result.appGrantAdded, true);
});

test('a refused app grant is audited, its time recorded, and nothing removed', async () => {
  const calls = [];
  const deps = baseDeps({
    getVaultSpace: async () => ({}),
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => { throw new Error('403'); },
    markAppDeleteGranted: async () => calls.push('granted'),
    markAppDeleteChecked: async ({ now }) => calls.push(['checked', now]),
    removeAttachmentDeleteGrants: async () => calls.push('remove'),
    tryAppend: async (event) => calls.push(event.eventType)
  });
  await assert.rejects(() => lockAttachmentDeletion(7, deps), /403/);
  assert.deepEqual(calls, ['ATTACHMENT_DELETE_GRANT_FAILED', ['checked', 1000]],
    'nothing is removed while the app would lose its own right to delete');
});

test('ensureAppDeleteGrant is one read for a project whose grant is recorded', async () => {
  let schemeRead = false;
  const deps = baseDeps({
    getVaultSpace: async () => ({ app_delete_granted_at: 5 }),
    getProjectPermissionScheme: async () => { schemeRead = true; return { id: 1, permissions: [] }; }
  });
  const result = await ensureAppDeleteGrant(7, deps);
  assert.equal(result.alreadyGranted, true);
  assert.equal(schemeRead, false);
});

test('provisionVault provisions the Jira project row and attachment-delete grant', async () => {
  const calls = [];
  let space = null;
  const deps = baseDeps({
    ensureVaultProjectRow: async args => { calls.push(['row', args.projectId]); space = {}; return true; },
    getVaultSpace: async () => space,
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => calls.push(['grant'])
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.storage, 'OBJECT_STORE');
  assert.deepEqual(calls, [['row', 7], ['grant']]);
});
