import test from 'node:test';
import assert from 'node:assert/strict';
import { createVaultObjectStore } from '../src/lib/vaultObjectStore.js';

function world({ status = 206, contentRange = 'bytes 4-6/10', contentLength = '3', bytes = Buffer.from('456'), total = 10 } = {}) {
  const calls = []; let bodyReads = 0;
  const os = createVaultObjectStore({ fos: {
    createDownloadUrl: async key => { calls.push(['url', key]); return { url: 'https://forge-object-store/download' }; },
    get: async key => ({ key, size: total })
  }, fetch: async (url, options) => { calls.push(['fetch', url, options]); return { status, ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'content-range' ? contentRange : name.toLowerCase() === 'content-length' ? contentLength : null },
    arrayBuffer: async () => { bodyReads++; return bytes; } }; } });
  assert.equal(typeof os.getContentRange, 'function', 'vault must support documented HTTP range downloads');
  return { os, calls, bodyReads: () => bodyReads };
}
test('vault range uses the existing private download URL and exact HTTP Range header', async () => {
  const w = world();
  const bytes = await w.os.getContentRange('vault-key', { offset: 4, length: 3, totalBytes: 10 });
  assert.equal(bytes.toString(), '456');
  assert.equal(w.calls[1][2].headers.Range, 'bytes=4-6');
});
for (const [name, options] of [
  ['ignored Range', { status: 200 }], ['wrong total size', { contentRange: 'bytes 4-6/11' }],
  ['wrong offset', { contentRange: 'bytes 0-2/10' }], ['wrong response length', { contentLength: '20' }]
]) test(`vault rejects ${name} before consuming an oversized or unrelated response`, async () => {
  const w = world(options);
  await assert.rejects(w.os.getContentRange('vault-key', { offset: 4, length: 3, totalBytes: 10 }));
  assert.equal(w.bodyReads(), 0);
});
test('vault rejects truncated response bytes even when range headers match', async () => {
  const w = world({ bytes: Buffer.from('45') });
  await assert.rejects(w.os.getContentRange('vault-key', { offset: 4, length: 3, totalBytes: 10 }));
});
test('a range without Content-Length is checked by its exact Content-Range and returned bytes', async () => {
  const w = world({ contentLength: null });
  assert.equal((await w.os.getContentRange('vault-key', { offset: 4, length: 3, totalBytes: 10 })).toString(), '456');
});
test('missing and transient download failures remain distinguishable', async () => {
  const missing = world({ status: 404 });
  await assert.rejects(missing.os.getContentRange('vault-key', { offset: 4, length: 3, totalBytes: 10 }), error => error.status === 404);
  const transient = world({ status: 429 });
  await assert.rejects(transient.os.getContentRange('vault-key', { offset: 4, length: 3, totalBytes: 10 }), error => error.status === 503);
});
test('vault validates range bounds and handles a proven empty object without a full GET', async () => {
  const w = world({ total: 0 });
  assert.equal((await w.os.getContentRange('empty-key', { offset: 0, length: 192 * 1024, totalBytes: 0 })).length, 0);
  assert.equal(w.calls.length, 0);
  for (const patch of [{ offset: -1 }, { offset: 11 }, { offset: 1.1 }, { length: 0 }, { length: 2 * 1024 * 1024 }]) {
    await assert.rejects(w.os.getContentRange('key', { offset: 4, length: 3, totalBytes: 10, ...patch }));
  }
});
