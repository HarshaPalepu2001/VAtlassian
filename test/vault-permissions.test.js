import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants } from '../src/lib/vaultPermissions.js';

function fakeApi(handler) {
  return { asApp: () => ({ requestJira: handler }) };
}

test('getProjectPermissionScheme reads the scheme for a project', async () => {
  const scheme = await getProjectPermissionScheme(7, fakeApi(async () => ({ ok: true, json: async () => ({ id: 10000, name: 'Default', permissions: [] }) })));
  assert.equal(scheme.id, 10000);
});

test('getProjectPermissionScheme throws on a failed read', async () => {
  await assert.rejects(
    () => getProjectPermissionScheme(7, fakeApi(async () => ({ ok: false, status: 404 }))),
    /Failed to read permission scheme/
  );
});

test('attachmentDeleteGrantIds finds only the two attachment-delete permission types', () => {
  const scheme = { permissions: [
    { id: 1, permission: 'DELETE_OWN_ATTACHMENTS' },
    { id: 2, permission: 'DELETE_ALL_ATTACHMENTS' },
    { id: 3, permission: 'EDIT_ISSUES' }
  ] };
  assert.deepEqual(attachmentDeleteGrantIds(scheme), [1, 2]);
});

test('attachmentDeleteGrantIds returns an empty list when the scheme has none', () => {
  assert.deepEqual(attachmentDeleteGrantIds({ permissions: [] }), []);
  assert.deepEqual(attachmentDeleteGrantIds({}), []);
});

test('removeAttachmentDeleteGrants deletes every grant id from the scheme', async () => {
  const deleted = [];
  await removeAttachmentDeleteGrants({ schemeId: 10000, grantIds: [1, 2] }, fakeApi(async (path) => {
    deleted.push(path.value);
    return { ok: true };
  }));
  assert.equal(deleted.length, 2);
  assert.match(deleted[0], /permissionscheme\/10000\/permission\/1$/);
  assert.match(deleted[1], /permissionscheme\/10000\/permission\/2$/);
});

test('removeAttachmentDeleteGrants tolerates a grant already gone (404)', async () => {
  await removeAttachmentDeleteGrants({ schemeId: 10000, grantIds: [1] }, fakeApi(async () => ({ ok: false, status: 404 })));
});

test('removeAttachmentDeleteGrants throws on a real failure', async () => {
  await assert.rejects(
    () => removeAttachmentDeleteGrants({ schemeId: 10000, grantIds: [1] }, fakeApi(async () => ({ ok: false, status: 500 }))),
    /Failed to remove permission grant/
  );
});
