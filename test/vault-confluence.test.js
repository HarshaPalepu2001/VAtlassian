import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSpaceKey, findSpaceByKey, createSpace, restrictSpacePermissions,
  createVaultPage, uploadAttachmentToPage
} from '../src/lib/vaultConfluence.js';

function fakeApi(handler) {
  return { asApp: () => ({ requestConfluence: handler }) };
}

test('deriveSpaceKey uppercases and strips non-alphanumerics', () => {
  assert.equal(deriveSpaceKey('eng'), 'VLTENG');
  assert.equal(deriveSpaceKey('My-Proj 1'), 'VLTMYPROJ1');
});

test('deriveSpaceKey refuses an empty project key', () => {
  assert.throws(() => deriveSpaceKey(''), /empty project key/);
});

test('findSpaceByKey returns the first match or null', async () => {
  const found = await findSpaceByKey('VLTENG', fakeApi(async () => ({ ok: true, json: async () => ({ results: [{ id: 's1', key: 'VLTENG' }] }) })));
  assert.equal(found.id, 's1');
  const missing = await findSpaceByKey('VLTENG', fakeApi(async () => ({ ok: true, json: async () => ({ results: [] }) })));
  assert.equal(missing, null);
});

test('createSpace posts key and name and returns the created space', async () => {
  let captured;
  const space = await createSpace({ spaceKey: 'VLTENG', name: 'VAtlassian Vault — ENG' }, fakeApi(async (path, init) => {
    captured = { path: path.value, init };
    return { ok: true, json: async () => ({ id: 's1', key: 'VLTENG' }) };
  }));
  assert.equal(space.id, 's1');
  assert.match(captured.path, /\/wiki\/api\/v2\/spaces$/);
  assert.deepEqual(JSON.parse(captured.init.body), { key: 'VLTENG', name: 'VAtlassian Vault — ENG' });
});

test('createSpace on a 409 adopts the existing space by key instead of failing', async () => {
  let call = 0;
  const forgeApi = fakeApi(async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 409 };
    return { ok: true, json: async () => ({ results: [{ id: 's1', key: 'VLTENG' }] }) };
  });
  const space = await createSpace({ spaceKey: 'VLTENG', name: 'x' }, forgeApi);
  assert.equal(space.id, 's1');
});

test('createSpace throws when the create fails for a reason other than a conflict', async () => {
  await assert.rejects(
    () => createSpace({ spaceKey: 'VLTENG', name: 'x' }, fakeApi(async () => ({ ok: false, status: 500 }))),
    /Failed to create Confluence space/
  );
});

test('restrictSpacePermissions removes every existing grant', async () => {
  const deleted = [];
  const forgeApi = fakeApi(async (path, init) => {
    if (!init) return { ok: true, json: async () => ({ results: [{ id: 'g1' }, { id: 'g2' }] }) };
    deleted.push(path.value);
    return { ok: true };
  });
  await restrictSpacePermissions('VLTENG', forgeApi);
  assert.equal(deleted.length, 2);
  assert.match(deleted[0], /permission\/g1$/);
  assert.match(deleted[1], /permission\/g2$/);
});

test('createVaultPage posts a page titled with the issue key', async () => {
  let captured;
  const page = await createVaultPage({ spaceId: 's1', issueKey: 'ENG-1' }, fakeApi(async (path, init) => {
    captured = { path: path.value, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ id: 'p1' }) };
  }));
  assert.equal(page.id, 'p1');
  assert.equal(captured.body.title, 'ENG-1');
  assert.equal(captured.body.spaceId, 's1');
});

test('uploadAttachmentToPage posts multipart form data with the filename', async () => {
  let captured;
  const uploaded = await uploadAttachmentToPage(
    { pageId: 'p1', filename: 'evidence.png', buffer: Buffer.from('bytes') },
    fakeApi(async (path, init) => {
      captured = { path: path.value, init };
      return { ok: true, json: async () => ({ results: [{ id: 'att1' }] }) };
    })
  );
  assert.equal(uploaded.id, 'att1');
  assert.match(captured.path, /\/wiki\/rest\/api\/content\/p1\/child\/attachment$/);
  assert.match(captured.init.body.toString('utf8'), /filename="evidence\.png"/);
  assert.match(captured.init.body.toString('utf8'), /bytes/);
});
