import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVaultObjectStore, MAX_VAULT_BYTES, tooLarge } from '../src/lib/vaultObjectStore.js';
import { objectKeyFor, isReadableCopy, describeLocation, STORAGE } from '../src/lib/vaultLocation.js';

const bytes = Buffer.from('approved file');
const hex = createHash('sha256').update(bytes).digest('hex');

function store({ existing = null, uploadStatus = 200, downloadUrl = 'https://dl', downloadStatus = 200, downloadThrows = null } = {}) {
  const calls = [];
  const fos = {
    get: async key => { calls.push(['get', key]); return existing; },
    createUploadUrl: async body => { calls.push(['upload-url', body]); return { url: 'https://ul' }; },
    createDownloadUrl: async key => { calls.push(['download-url', key]); if (downloadThrows) throw downloadThrows; return downloadUrl ? { url: downloadUrl } : undefined; }
  };
  const fetch = async (url, options) => {
    calls.push(['fetch', url, options?.method ?? 'GET']);
    if (url === 'https://ul') return { ok: uploadStatus < 300, status: uploadStatus };
    return { ok: downloadStatus < 300, status: downloadStatus, arrayBuffer: async () => bytes };
  };
  return { calls, os: createVaultObjectStore({ fos, fetch }) };
}

test('keys are content addresses, kept apart from the page-governance snapshots', () => {
  assert.equal(objectKeyFor(hex), `vault/sha256/${hex}`);
  assert.throws(() => objectKeyFor('not-a-hash'));
});

test('a copy is readable only where it says it lives', () => {
  assert.equal(isReadableCopy({ storage: 'OBJECT_STORE', object_key: 'k' }), true);
  assert.equal(isReadableCopy({ storage: 'OBJECT_STORE', confluence_attachment_id: 'c', confluence_page_id: 'p' }), false);
  assert.equal(isReadableCopy({ confluence_attachment_id: 'c', confluence_page_id: 'p' }), true, 'a row from before tiers is a Confluence copy');
  assert.equal(isReadableCopy({ storage: 'CONFLUENCE', confluence_attachment_id: 'c' }), false, 'no page to read it from');
  assert.equal(isReadableCopy(null), false);
  assert.equal(describeLocation({ storage: STORAGE.OBJECT_STORE }), 'the Forge Object Store');
});

test('an upload sends the SHA-256 base64-encoded, as the store checks it', async () => {
  const { calls, os } = store();
  const result = await os.putContent({ buffer: bytes, hash: hex });
  assert.deepEqual(result, { storage: 'OBJECT_STORE', objectKey: `vault/sha256/${hex}`, reused: false });
  const body = calls.find(c => c[0] === 'upload-url')[1];
  assert.equal(body.checksum, createHash('sha256').update(bytes).digest('base64'));
  assert.equal(body.checksumType, 'SHA256');
  assert.equal(body.length, bytes.length);
  assert.equal('ttlSeconds' in body, false, 'evidence never expires');
  assert.ok(calls.some(c => c[0] === 'fetch' && c[2] === 'PUT'));
});

test('the same bytes already stored are not uploaded again', async () => {
  const { calls, os } = store({ existing: { key: `vault/sha256/${hex}`, size: bytes.length } });
  const result = await os.putContent({ buffer: bytes });
  assert.equal(result.reused, true);
  assert.equal(calls.some(c => c[0] === 'upload-url'), false);
});

test('a refused upload is a failure the caller sees, transient ones as 503', async () => {
  await assert.rejects(() => store({ uploadStatus: 400 }).os.putContent({ buffer: bytes }), error => error.status === 400);
  await assert.rejects(() => store({ uploadStatus: 502 }).os.putContent({ buffer: bytes }), error => error.status === 503);
});

test('a missing object is a 404; a store that cannot be read is a 503', async () => {
  assert.equal((await store().os.getContent('k')).toString(), 'approved file');
  await assert.rejects(() => store({ downloadUrl: null }).os.getContent('k'), error => error.status === 404);
  await assert.rejects(() => store({ downloadStatus: 404 }).os.getContent('k'), error => error.status === 404);
  await assert.rejects(() => store({ downloadStatus: 500 }).os.getContent('k'), error => error.status === 503);
  await assert.rejects(() => store({ downloadThrows: new Error('rate limited') }).os.getContent('k'), error => error.status === 503);
});

test('the size cap is checked from the reported size', () => {
  assert.equal(tooLarge(MAX_VAULT_BYTES), false);
  assert.equal(tooLarge(MAX_VAULT_BYTES + 1), true);
  assert.equal(tooLarge(undefined), false, 'an unknown size is not refused');
});
