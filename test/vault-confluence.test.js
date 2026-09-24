import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findSpaceByKey, createSpace, appAccountId, findPageByTitle,
  createProjectPage, createVaultPage, uploadAttachmentToPage, SITE_VAULT_KEY
} from '../src/lib/vaultConfluence.js';

function fakeApi(handler) {
  return { asApp: () => ({ requestConfluence: handler }) };
}

test('findSpaceByKey returns the first match or null', async () => {
  const found = await findSpaceByKey('VLTENG', fakeApi(async () => ({ ok: true, json: async () => ({ results: [{ id: 's1', key: 'VLTENG' }] }) })));
  assert.equal(found.id, 's1');
  const missing = await findSpaceByKey('VLTENG', fakeApi(async () => ({ ok: true, json: async () => ({ results: [] }) })));
  assert.equal(missing, null);
});

test('createSpace creates the space PRIVATE to the app, so no person can see or find it', async () => {
  let captured;
  const space = await createSpace({ spaceKey: 'VATVAULT', name: 'VAtlassian Vault' }, fakeApi(async (path, init) => {
    captured = { path: path.value, init };
    return { ok: true, json: async () => ({ id: 's1', key: 'VATVAULT', homepageId: 'h1' }) };
  }));
  assert.equal(space.id, 's1');
  assert.equal(space.homepageId, 'h1');
  assert.match(captured.path, /\/wiki\/api\/v2\/spaces$/);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.key, 'VATVAULT');
  assert.equal(body.createPrivateSpace, true);
  assert.equal(body.roleAssignments, undefined, 'nobody is granted access at creation');
});

test('the site vault key is a fixed, valid Confluence space key', () => {
  assert.match(SITE_VAULT_KEY, /^[A-Z0-9]{1,255}$/);
});

test('createSpace adopts an existing space by key only when this app created it', async () => {
  let call = 0;
  const forgeApi = fakeApi(async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 409 };
    return { ok: true, json: async () => ({ results: [{ id: 's1', key: 'VATVAULT', authorId: 'app-1' }] }) };
  });
  const space = await createSpace({ spaceKey: 'VATVAULT', name: 'x', ownerAccountId: 'app-1' }, forgeApi);
  assert.equal(space.id, 's1');
  assert.equal(space.adopted, true);
});

test('createSpace refuses to adopt a same-key space someone else created', async () => {
  let call = 0;
  const forgeApi = fakeApi(async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 400 };
    return { ok: true, json: async () => ({ results: [{ id: 's9', key: 'VATVAULT', authorId: 'a-person' }] }) };
  });
  await assert.rejects(() => createSpace({ spaceKey: 'VATVAULT', name: 'x', ownerAccountId: 'app-1' }, forgeApi),
    /not created by this app/);
});

test('appAccountId reads the account the app acts as', async () => {
  const id = await appAccountId(fakeApi(async (path) => {
    assert.match(path.value, /\/wiki\/rest\/api\/user\/current$/);
    return { ok: true, json: async () => ({ accountId: 'app-1' }) };
  }));
  assert.equal(id, 'app-1');
});

test('findPageByTitle looks a page up inside one space', async () => {
  let path;
  const page = await findPageByTitle({ spaceId: 's1', title: 'ENG — Engineering' }, fakeApi(async (p) => {
    path = p.value;
    return { ok: true, json: async () => ({ results: [{ id: 'p1' }] }) };
  }));
  assert.equal(page.id, 'p1');
  assert.match(path, /space-id=s1/);
  assert.match(path, /title=ENG/);
});

test('createProjectPage nests the project under the vault home page', async () => {
  let body;
  const page = await createProjectPage({ spaceId: 's1', parentId: 'h1', title: 'ENG — Engineering' }, fakeApi(async (p, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ id: 'pp1' }) };
  }));
  assert.equal(page.id, 'pp1');
  assert.equal(body.parentId, 'h1');
  assert.equal(body.spaceId, 's1');
  assert.equal(body.title, 'ENG — Engineering');
});

test('createSpace throws when the create fails for a reason other than a conflict', async () => {
  await assert.rejects(
    () => createSpace({ spaceKey: 'VLTENG', name: 'x' }, fakeApi(async () => ({ ok: false, status: 500 }))),
    /Failed to create Confluence space/
  );
});

test('createVaultPage posts a page titled with the issue key', async () => {
  let captured;
  const page = await createVaultPage({ spaceId: 's1', parentId: 'pp1', issueKey: 'ENG-1' }, fakeApi(async (path, init) => {
    captured = { path: path.value, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ id: 'p1' }) };
  }));
  assert.equal(page.id, 'p1');
  assert.equal(captured.body.title, 'ENG-1');
  assert.equal(captured.body.spaceId, 's1');
  assert.equal(captured.body.parentId, 'pp1', 'an issue page sits under its project page');
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
  // PUT creates-or-versions: a later baseline of the same file must not be refused.
  assert.equal(captured.init.method, 'PUT');
  assert.match(captured.init.body.toString('utf8'), /name="minorEdit"\r\n\r\ntrue/);
  assert.match(captured.init.body.toString('utf8'), /filename="evidence\.png"/);
  assert.match(captured.init.body.toString('utf8'), /bytes/);
});

test('uploadAttachmentToPage strips CR/LF and quotes from a hostile filename so it cannot break out of the multipart header', async () => {
  let captured;
  await uploadAttachmentToPage(
    { pageId: 'p1', filename: 'evil.png"\r\nContent-Disposition: form-data; name="admin', buffer: Buffer.from('x') },
    fakeApi(async (path, init) => {
      captured = init;
      return { ok: true, json: async () => ({ results: [{ id: 'att1' }] }) };
    })
  );
  const bodyText = captured.body.toString('utf8');
  const dispositionLine = bodyText.split('\r\n')[1];
  assert.match(dispositionLine, /^Content-Disposition: form-data; name="file"; filename="[^"\r\n]*"$/,
    'the filename value must not contain a raw quote or CR/LF that could break out of the header line');
});

test('createVaultPage HTML-escapes the issue key before it reaches Confluence storage format', async () => {
  let captured;
  await createVaultPage({ spaceId: 's1', issueKey: '<script>alert(1)</script>' }, fakeApi(async (path, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ id: 'p1' }) };
  }));
  assert.doesNotMatch(captured.body.value, /<script>/);
  assert.match(captured.body.value, /&lt;script&gt;/);
});
