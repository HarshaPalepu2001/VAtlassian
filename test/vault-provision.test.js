import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureVaultSpace, lockAttachmentDeletion, provisionVault } from '../src/lib/vaultProvision.js';

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

test('lockAttachmentDeletion removes attachment-delete grants and records the scheme', async () => {
  const calls = [];
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1' }),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [{ id: 1, permission: 'DELETE_OWN_ATTACHMENTS' }] }),
    attachmentDeleteGrantIds: (scheme) => scheme.permissions.map((p) => p.id),
    removeAttachmentDeleteGrants: async (args) => calls.push(['remove', args]),
    markPermissionLocked: async (args) => calls.push(['mark', args]),
    tryAppend: async (event) => calls.push(['audit', event.eventType])
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.schemeId, 10000);
  assert.equal(result.grantsRemoved, 1);
  assert.deepEqual(calls.map((c) => c[0]), ['remove', 'mark', 'audit']);
  assert.equal(calls[2][1], 'ATTACHMENT_DELETE_LOCKED');
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

test('provisionVault runs both steps and reports no errors on success', async () => {
  const deps = baseDeps();
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.space.projectPageId, 'pp1');
  assert.equal(result.lockdown.schemeId, 10000);
});

test('provisionVault never throws and records both failures when space creation fails and blocks lockdown', async () => {
  const calls = [];
  const deps = baseDeps({
    createSpace: async () => { throw new Error('confluence down'); },
    tryAppend: async (event) => calls.push(event.eventType)
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.space, null);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].step, 'ensureVaultSpace');
  assert.equal(result.errors[1].step, 'lockAttachmentDeletion');
  assert.equal(result.lockdown, null);
  assert.ok(calls.includes('VAULT_SPACE_CREATE_FAILED'));
  assert.ok(calls.includes('ATTACHMENT_DELETE_LOCK_FAILED'));
});

test('provisionVault records the lockdown failure independently of the space result', async () => {
  const deps = baseDeps({ getProjectPermissionScheme: async () => { throw new Error('jira down'); } });
  const result = await provisionVault(7, deps);
  assert.equal(result.space.projectPageId, 'pp1');
  assert.equal(result.lockdown, null);
  assert.equal(result.errors[0].step, 'lockAttachmentDeletion');
});

test('lockAttachmentDeletion does nothing once the project is locked and the app holds its grant', async () => {
  let schemeRead = false;
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1', permission_locked_at: 123, app_delete_granted_at: 124 }),
    getProjectPermissionScheme: async () => { schemeRead = true; return { id: 1, permissions: [] }; }
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.alreadyLocked, true);
  assert.equal(schemeRead, false, 'the backfill re-runs provisioning; a locked project must cost no Jira calls');
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

test('a project recorded as locked before grants were read is finished: app grant added, the rest removed', async () => {
  const calls = [];
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1', permission_locked_at: 123, permission_scheme_id: '10000' }),
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [{ id: 5, permission: 'DELETE_ALL_ATTACHMENTS' }] }),
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => calls.push('grant'),
    markAppDeleteGranted: async () => calls.push('granted'),
    attachmentDeleteGrantIds: (scheme) => scheme.permissions.map(p => p.id),
    removeAttachmentDeleteGrants: async ({ grantIds }) => calls.push(['remove', grantIds]),
    markPermissionLocked: async () => calls.push('locked-again'),
    tryAppend: async (event) => calls.push([event.eventType, event.payload.repaired ?? null])
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.deepEqual(calls, ['grant', 'granted', ['ATTACHMENT_DELETE_GRANTED_TO_APP', null], ['remove', [5]],
    ['ATTACHMENT_DELETE_LOCKED', true]]);
  assert.equal(result.repaired, true);
  assert.equal(result.grantsRemoved, 1);
});

test('a refused app grant is audited and leaves the project unmarked, so the backfill retries', async () => {
  const calls = [];
  const deps = baseDeps({
    getVaultSpace: async () => ({ space_id: 's1' }),
    hasAppDeleteGrant: () => false,
    grantAppAttachmentDelete: async () => { throw new Error('403'); },
    markAppDeleteGranted: async () => calls.push('granted'),
    removeAttachmentDeleteGrants: async () => calls.push('remove'),
    tryAppend: async (event) => calls.push(event.eventType)
  });
  await assert.rejects(() => lockAttachmentDeletion(7, deps), /403/);
  assert.deepEqual(calls, ['ATTACHMENT_DELETE_GRANT_FAILED'], 'nothing is removed while the app would lose its own right to delete');
});
