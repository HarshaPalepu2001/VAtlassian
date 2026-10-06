import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureVaultSpace, ensureAppDeleteGrant, lockAttachmentDeletion, provisionVault } from '../src/lib/vaultProvision.js';

function baseDeps(overrides = {}) {
  let site = null;
  let vaultSpace = null;
  return {
    getVaultSite: async () => site,
    insertVaultSite: async (args) => { site = { space_id: args.spaceId, space_key: args.spaceKey, homepage_id: args.homepageId }; },
    getVaultSpace: async () => vaultSpace,
    insertVaultSpace: async (args) => { vaultSpace = { space_id: args.spaceId, space_key: args.spaceKey, project_page_id: args.projectPageId }; },
    setVaultProjectPage: async (args) => { vaultSpace = { ...vaultSpace, project_page_id: args.projectPageId }; },
    appAccountId: async () => 'app-1',
    createSpace: async () => ({ id: 's1', key: 'VATVAULT', homepageId: 'h1', authorId: 'app-1' }),
    projectFor: async () => ({ key: 'ENG', name: 'Engineering' }),
    findPageByTitle: async () => null,
    createProjectPage: async () => ({ id: 'pp1' }),
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
    vaultTier: async () => null,
    ensureVaultProjectRow: async () => true,
    tryAppend: async () => {},
    now: () => 1000,
    actorAccountId: 'system',
    ...overrides
  };
}

test('the first project creates ONE private site vault, then a project page under its home page', async () => {
  const calls = [];
  const deps = baseDeps({
    createSpace: async (args) => { calls.push(['createSpace', args]); return { id: 's1', key: 'VATVAULT', homepageId: 'h1' }; },
    createProjectPage: async (args) => { calls.push(['projectPage', args]); return { id: 'pp1' }; },
    tryAppend: async (event) => calls.push(['audit', event.eventType])
  });
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.spaceId, 's1');
  assert.equal(result.projectPageId, 'pp1');
  const create = calls.find(c => c[0] === 'createSpace')[1];
  assert.equal(create.spaceKey, 'VATVAULT');
  assert.equal(create.ownerAccountId, 'app-1', 'adoption is limited to a space the app itself made');
  const page = calls.find(c => c[0] === 'projectPage')[1];
  assert.equal(page.parentId, 'h1');
  assert.equal(page.title, 'ENG — Engineering');
  assert.deepEqual(calls.filter(c => c[0] === 'audit').map(c => c[1]), ['VAULT_SPACE_CREATED', 'VAULT_PROJECT_ADDED']);
});

test('a second project reuses the site vault — there is never a space per project', async () => {
  let spacesCreated = 0;
  const deps = baseDeps({
    getVaultSite: async () => ({ space_id: 's1', space_key: 'VATVAULT', homepage_id: 'h1' }),
    createSpace: async () => { spacesCreated += 1; return { id: 'sX' }; }
  });
  const result = await ensureVaultSpace(8, deps);
  assert.equal(spacesCreated, 0);
  assert.equal(result.spaceId, 's1');
  assert.equal(result.projectPageId, 'pp1');
});

test('a fully provisioned project returns at once, with no Confluence calls', async () => {
  let touched = false;
  const deps = baseDeps({
    getVaultSite: async () => { touched = true; return null; },
    getVaultSpace: async () => ({ space_id: 's1', space_key: 'VATVAULT', project_page_id: 'pp1' })
  });
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.projectPageId, 'pp1');
  assert.equal(touched, false);
});

test('a project page left behind by a failed earlier attempt is found by title, not duplicated', async () => {
  let created = 0;
  const deps = baseDeps({
    getVaultSite: async () => ({ space_id: 's1', space_key: 'VATVAULT', homepage_id: 'h1' }),
    findPageByTitle: async () => ({ id: 'pp-old' }),
    createProjectPage: async () => { created += 1; return { id: 'pp-new' }; }
  });
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.projectPageId, 'pp-old');
  assert.equal(created, 0);
});

test('a row from the old per-project design is re-pointed at the site vault', async () => {
  const updates = [];
  const deps = baseDeps({
    getVaultSite: async () => ({ space_id: 's1', space_key: 'VATVAULT', homepage_id: 'h1' }),
    getVaultSpace: async () => ({ space_id: 'old', space_key: 'VLTENG', project_page_id: null }),
    insertVaultSpace: async () => { throw new Error('must update, not insert'); },
    setVaultProjectPage: async (args) => updates.push(args)
  });
  await ensureVaultSpace(7, deps);
  assert.deepEqual(updates, [{ projectId: 7, spaceId: 's1', spaceKey: 'VATVAULT', projectPageId: 'pp1' }]);
});

test('two first-time provisions racing on the site row converge on the recorded one', async () => {
  let reads = 0;
  const deps = baseDeps({
    getVaultSite: async () => (++reads === 1 ? null : { space_id: 's-winner', space_key: 'VATVAULT', homepage_id: 'h1' }),
    insertVaultSite: async () => { throw new Error('Duplicate entry'); }
  });
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.spaceId, 's-winner');
});

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
  const deps = baseDeps({ projectConfig: async () => ({ vault: { lockAttachmentDeletion: true } }) });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.space.projectPageId, 'pp1');
  assert.equal(result.lockdownEnabled, true);
  assert.equal(result.lockdown.schemeId, 10000);
});

test('provisionVault never throws and records every failure when space creation fails', async () => {
  const calls = [];
  const deps = baseDeps({
    lockdownEnabled: true,
    createSpace: async () => { throw new Error('confluence down'); },
    tryAppend: async (event) => calls.push(event.eventType)
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.space, null);
  // The project row is stubbed away here, so every later step has nothing to act on.
  assert.deepEqual(result.errors.map(e => e.step), ['ensureVaultSpace', 'ensureAppDeleteGrant', 'lockAttachmentDeletion']);
  assert.equal(result.lockdown, null);
  assert.ok(calls.includes('VAULT_SPACE_CREATE_FAILED'));
  assert.ok(calls.includes('ATTACHMENT_DELETE_LOCK_FAILED'));
});

test('provisionVault records the lockdown failure independently of the space result', async () => {
  let space = null;
  const deps = baseDeps({
    lockdownEnabled: true,
    getVaultSpace: async () => space,
    insertVaultSpace: async (args) => { space = { space_id: args.spaceId, project_page_id: args.projectPageId, app_delete_granted_at: 5 }; },
    getProjectPermissionScheme: async () => { throw new Error('jira down'); }
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.space.projectPageId, 'pp1');
  assert.equal(result.lockdown, null);
  assert.deepEqual(result.errors.map(e => e.step), ['lockAttachmentDeletion'], 'a recorded app grant costs no scheme read');
});

test('a locked project costs no scheme read on the hourly re-run', async () => {
  let schemeRead = false;
  const deps = baseDeps({
    lockdownEnabled: true,
    getVaultSpace: async () => ({ space_id: 's1', project_page_id: 'pp1', permission_locked_at: 123, app_delete_granted_at: 124 }),
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
    getVaultSpace: async () => ({ space_id: 's1', project_page_id: 'pp1', permission_locked_at: 123, app_delete_granted_at: 124 }),
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
    getVaultSpace: async () => ({ space_id: 's1' }),
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
    getVaultSpace: async () => ({ space_id: 's1' }),
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
    getVaultSpace: async () => ({ space_id: 's1' }),
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
    getVaultSpace: async () => ({ space_id: 's1', app_delete_granted_at: 5 }),
    getProjectPermissionScheme: async () => { schemeRead = true; return { id: 1, permissions: [] }; }
  });
  const result = await ensureAppDeleteGrant(7, deps);
  assert.equal(result.alreadyGranted, true);
  assert.equal(schemeRead, false);
});

test('on an Object Store site no Confluence space is made, and the grant still goes ahead on the project row', async () => {
  const calls = [];
  let space = null;
  const deps = baseDeps({
    vaultTier: async () => 'OBJECT_STORE',
    createSpace: async () => { throw new Error('must not create a Confluence space'); },
    getVaultSite: async () => { throw new Error('must not look for a Confluence vault'); },
    ensureVaultProjectRow: async args => { calls.push(['row', args.projectId]); space = { space_id: null }; return true; },
    getVaultSpace: async () => space,
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => calls.push(['grant'])
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.storage, 'OBJECT_STORE');
  assert.equal(result.space, null);
  assert.deepEqual(calls, [['row', 7], ['grant']]);
});

test('a Confluence vault that cannot be made yet does not hold up the app grant', async () => {
  const calls = [];
  let space = null;
  const deps = baseDeps({
    createSpace: async () => { throw new Error('confluence down'); },
    ensureVaultProjectRow: async () => { calls.push('row'); space = { space_id: null }; return true; },
    getVaultSpace: async () => space,
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => calls.push('grant')
  });
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors.map(e => e.step), ['ensureVaultSpace']);
  assert.deepEqual(calls, ['row', 'grant']);
});
