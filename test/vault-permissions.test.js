import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants,
  hasAppDeleteGrant, grantAppAttachmentDelete, appJiraAccountId } from '../src/lib/vaultPermissions.js';

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

test('the scheme is read WITH its grants: without expand=permissions Jira omits them', async () => {
  let path;
  await getProjectPermissionScheme(7, fakeApi(async (p) => { path = p.value ?? String(p); return { ok: true, json: async () => ({ id: 1 }) }; }));
  assert.match(path, /\/project\/7\/permissionscheme\?expand=permissions,projectRole$/);
});

test("attachmentDeleteGrantIds keeps the app's own grant", () => {
  const scheme = { permissions: [
    { id: 1, permission: 'DELETE_ALL_ATTACHMENTS', holder: { type: 'user', value: 'app-1', parameter: 'app-1' } },
    { id: 2, permission: 'DELETE_ALL_ATTACHMENTS', holder: { type: 'projectRole', value: '10002' } },
    { id: 3, permission: 'DELETE_OWN_ATTACHMENTS', holder: { type: 'user', value: 'someone' } }
  ] };
  assert.deepEqual(attachmentDeleteGrantIds(scheme, { keepAccountId: 'app-1' }), [2, 3]);
  assert.equal(hasAppDeleteGrant(scheme, 'app-1'), true);
  assert.equal(hasAppDeleteGrant(scheme, 'someone'), false, 'delete-own is not delete-all');
});

test('grantAppAttachmentDelete grants Delete all attachments to the app user', async () => {
  let captured;
  await grantAppAttachmentDelete({ schemeId: 10000, accountId: 'app-1' }, fakeApi(async (p, init) => {
    captured = { path: p.value ?? String(p), init };
    return { ok: true, json: async () => ({ id: 9 }) };
  }));
  assert.match(captured.path, /permissionscheme\/10000\/permission$/);
  assert.equal(captured.init.method, 'POST');
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, { holder: { type: 'user', parameter: 'app-1', value: 'app-1' }, permission: 'DELETE_ALL_ATTACHMENTS' });
  await assert.rejects(() => grantAppAttachmentDelete({ schemeId: 1, accountId: 'a' }, fakeApi(async () => ({ ok: false, status: 400, text: async () => 'holder not allowed' }))), /400 holder not allowed/);
});

test("appJiraAccountId reads the app's own account", async () => {
  assert.equal(await appJiraAccountId(fakeApi(async () => ({ ok: true, json: async () => ({ accountId: 'app-1' }) }))), 'app-1');
  await assert.rejects(() => appJiraAccountId(fakeApi(async () => ({ ok: true, json: async () => ({}) }))), /account id/);
});

test("the app role's delete grant is kept: it is how the app deletes, since Jira refuses a direct grant to an app account", () => {
  const scheme = { permissions: [
    { id: 1, permission: 'DELETE_ALL_ATTACHMENTS', holder: { type: 'projectRole', value: '10003', projectRole: { name: 'atlassian-addons-project-access' } } },
    { id: 2, permission: 'DELETE_ALL_ATTACHMENTS', holder: { type: 'projectRole', value: '10002', projectRole: { name: 'Administrators' } } },
    { id: 3, permission: 'DELETE_OWN_ATTACHMENTS', holder: { type: 'applicationRole' } }
  ] };
  assert.deepEqual(attachmentDeleteGrantIds(scheme, { keepAccountId: 'app-1' }), [2, 3]);
  assert.equal(hasAppDeleteGrant(scheme, 'app-1'), true, 'nothing to add: the lockdown goes ahead without a direct grant');
});
