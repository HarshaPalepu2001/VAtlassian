import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureVaultSpace, lockAttachmentDeletion, provisionVault } from '../src/lib/vaultProvision.js';

function baseDeps(overrides = {}) {
  return {
    getVaultSpace: async () => null,
    insertVaultSpace: async () => {},
    projectKeyFor: async () => 'ENG',
    deriveSpaceKey: (key) => `VLT${key}`,
    createSpace: async () => ({ id: 's1', key: 'VLTENG' }),
    restrictSpacePermissions: async () => {},
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [] }),
    attachmentDeleteGrantIds: () => [],
    removeAttachmentDeleteGrants: async () => {},
    markPermissionLocked: async () => {},
    tryAppend: async () => {},
    now: () => 1000,
    actorAccountId: 'system',
    ...overrides
  };
}

test('ensureVaultSpace returns the existing space without creating a new one', async () => {
  const deps = baseDeps({ getVaultSpace: async () => ({ space_id: 's1', space_key: 'VLTENG' }) });
  let created = false;
  deps.createSpace = async () => { created = true; return { id: 's1', key: 'VLTENG' }; };
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.created, false);
  assert.equal(created, false);
});

test('ensureVaultSpace creates, restricts, and records a new space', async () => {
  const calls = [];
  const deps = baseDeps({
    createSpace: async (args) => { calls.push(['createSpace', args]); return { id: 's1', key: 'VLTENG' }; },
    restrictSpacePermissions: async (key) => calls.push(['restrict', key]),
    insertVaultSpace: async (args) => calls.push(['insert', args]),
    tryAppend: async (event) => calls.push(['audit', event.eventType])
  });
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.created, true);
  assert.equal(result.spaceId, 's1');
  assert.deepEqual(calls.map((c) => c[0]), ['createSpace', 'restrict', 'insert', 'audit']);
  assert.equal(calls[3][1], 'VAULT_SPACE_CREATED');
});

test('lockAttachmentDeletion removes attachment-delete grants and records the scheme', async () => {
  const calls = [];
  const deps = baseDeps({
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
  const deps = baseDeps({ removeAttachmentDeleteGrants: async () => { removeCalled = true; } });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.grantsRemoved, 0);
  assert.equal(removeCalled, false);
});

test('provisionVault runs both steps and reports no errors on success', async () => {
  const deps = baseDeps();
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.space.created, true);
  assert.equal(result.lockdown.schemeId, 10000);
});

test('provisionVault never throws and still attempts the lockdown when space creation fails', async () => {
  const calls = [];
  const deps = baseDeps({
    createSpace: async () => { throw new Error('confluence down'); },
    tryAppend: async (event) => calls.push(event.eventType)
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.space, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'ensureVaultSpace');
  assert.ok(result.lockdown, 'lockdown still ran despite the space failure');
  assert.ok(calls.includes('VAULT_SPACE_CREATE_FAILED'));
});

test('provisionVault records the lockdown failure independently of the space result', async () => {
  const deps = baseDeps({ getProjectPermissionScheme: async () => { throw new Error('jira down'); } });
  const result = await provisionVault(7, deps);
  assert.equal(result.space.created, true);
  assert.equal(result.lockdown, null);
  assert.equal(result.errors[0].step, 'lockAttachmentDeletion');
});
