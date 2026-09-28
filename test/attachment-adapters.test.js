import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentRestoreDeps } from '../src/lib/restore/attachmentAdapters.js';
import { downloadVaultAttachment } from '../src/lib/vaultConfluence.js';

const route = (s, ...v) => s.reduce((a, b, i) => a + b + (i < v.length ? encodeURIComponent(String(v[i])) : ''), '');

function fakeApi(handler) {
  const calls = [];
  const client = { requestJira: async (path, init = {}) => { calls.push({ path: String(path), init }); return handler(String(path), init); } };
  return { calls, api: { asApp: () => client, asUser: () => { throw new Error('attachments always act as the app'); } } };
}

test('a restored file is uploaded as the app, as multipart with the XSRF bypass and its original name', async () => {
  const { calls, api } = fakeApi(async () => ({ ok: true, status: 200, json: async () => [{ id: '900', filename: 'spec.pdf' }] }));
  const deps = createAttachmentRestoreDeps({ api, route });
  const uploaded = await deps.upload({ issueKey: 'T-1', filename: 'sp"ec\r\n.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  assert.equal(uploaded.id, '900');
  const { path, init } = calls[0];
  assert.equal(path, '/rest/api/3/issue/T-1/attachments');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Atlassian-Token'], 'no-check');
  const body = init.body.toString();
  assert.match(body, /name="file"; filename="sp'ec\.pdf"/, 'quotes and line breaks cannot break out of the header');
  assert.match(body, /Content-Type: application\/pdf/);
  assert.match(body, /%PDF/);
});

test('an unusual mime type is not written into the multipart header', async () => {
  const { calls, api } = fakeApi(async () => ({ ok: true, status: 200, json: async () => [{ id: '1' }] }));
  await createAttachmentRestoreDeps({ api, route }).upload({ issueKey: 'T-1', filename: 'x', mimeType: 'text/plain\r\nX-Evil: 1', buffer: Buffer.from('x') });
  assert.match(calls[0].init.body.toString(), /Content-Type: application\/octet-stream/);
  assert.doesNotMatch(calls[0].init.body.toString(), /X-Evil/);
});

test('a refused upload or delete carries Jira\'s status, and a delete of a file already gone succeeds', async () => {
  const { api } = fakeApi(async (path, init) => {
    if (init.method === 'DELETE') return { ok: false, status: path.endsWith('/404') ? 404 : 403, json: async () => ({ errorMessages: ['nope'] }) };
    return { ok: false, status: 413, json: async () => ({ errorMessages: ['too big'] }) };
  });
  const deps = createAttachmentRestoreDeps({ api, route });
  await assert.rejects(() => deps.upload({ issueKey: 'T-1', filename: 'x', buffer: Buffer.from('x') }), e => e.status === 413 && /too big/.test(e.detail));
  await deps.remove('404');
  await assert.rejects(() => deps.remove('7'), e => e.status === 403);
});

test('the audit entry is strict: one that was not written is a failure, not a gap', async () => {
  const written = [];
  const deps = createAttachmentRestoreDeps({ api: fakeApi(async () => ({})).api, route, actorAccountId: 'rev', approvalId: 'appr',
    append: async (event) => { written.push(event); return written.length === 1 ? { seq: 1 } : null; } });
  await deps.audit('ATTACHMENT_REMOVED_BY_RESTORE', { filename: 'x' }, 11);
  assert.deepEqual(written[0], { actorAccountId: 'rev', issueId: 11, approvalId: 'appr',
    eventType: 'ATTACHMENT_REMOVED_BY_RESTORE', payload: { filename: 'x' } });
  await assert.rejects(() => deps.audit('ATTACHMENT_REMOVED_BY_RESTORE', {}, 11), e => e.status === 503);
});

test('the vault copy is downloaded from its page as the app, and a failure carries its status', async () => {
  const seen = [];
  const api = { asApp: () => ({ requestConfluence: async (path) => {
    seen.push(path.value ?? String(path));
    return seen.length === 1 ? { ok: true, arrayBuffer: async () => new TextEncoder().encode('bytes').buffer } : { ok: false, status: 404 };
  } }) };
  const bytes = await downloadVaultAttachment({ pageId: 'p1', attachmentId: 'att9' }, api);
  assert.equal(bytes.toString(), 'bytes');
  assert.match(seen[0], /\/wiki\/rest\/api\/content\/p1\/child\/attachment\/att9\/download$/);
  await assert.rejects(() => downloadVaultAttachment({ pageId: 'p1', attachmentId: 'x' }, api), e => e.status === 404);
});
