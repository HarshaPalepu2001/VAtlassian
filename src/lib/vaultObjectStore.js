import { createHash } from 'node:crypto';
import { STORAGE, objectKeyFor } from './vaultLocation.js';

/**
 * THE ATTACHMENT VAULT: the Forge Object Store.
 *
 * It keeps the app inside the customer's Atlassian tenant (Runs on Atlassian),
 * holds an object of up to 1 GB, and keeps it until it is deleted — there is no
 * expiry unless one is asked for, and none is. Objects are keyed by their
 * SHA-256 (./vaultLocation.js), so one set of bytes is stored once however many
 * baselines record it.
 *
 * TWO FAILURES ARE KEPT APART. An object that is not there is a 404: the copy is
 * gone, and a restore names that file as unrestorable. Anything else (the store
 * unreachable, rate limited) is a 503, which a queued restore retries — the
 * copy may be perfectly fine.
 *
 * `fos` is @forge/object-store's client and `fetch` is @forge/api's, injected so
 * this can be tested; the upload and download themselves go to pre-signed URLs.
 */

/**
 * Whole files are held in memory by the worker that copies them and the one
 * that restores them. Well under the Object Store's 1 GB object limit, and
 * matched to the memory those functions are given in manifest.yml.
 */
export const MAX_VAULT_BYTES = 250 * 1024 * 1024;
export const MAX_VAULT_RANGE_BYTES = 1024 * 1024;

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function tooLarge(size) {
  return Number.isFinite(Number(size)) && Number(size) > MAX_VAULT_BYTES;
}

export function createVaultObjectStore({ fos, fetch }) {
  return {
    /** Metadata only: do not carry a missing object into another baseline. */
    async hasContent(objectKey) {
      try { return Boolean(await fos.get(objectKey)); }
      catch (error) { throw failure(503, `The Forge Object Store metadata could not be read: ${error?.message ?? error}`); }
    },

    /** Stores `buffer` under its content hash. Returns where it went. */
    async putContent({ buffer, hash }) {
      const hex = hash ?? createHash('sha256').update(buffer).digest('hex');
      const objectKey = objectKeyFor(hex);
      if (buffer.length > MAX_VAULT_BYTES) throw failure(413, `The file is larger than the vault accepts (${MAX_VAULT_BYTES} bytes).`);
      // Already there: content-addressed, so the same key is the same bytes.
      const existing = await fos.get(objectKey).catch(() => null);
      if (existing && Number(existing.size) === buffer.length) return { storage: STORAGE.OBJECT_STORE, objectKey, reused: true };

      const upload = await fos.createUploadUrl({
        key: objectKey,
        length: buffer.length,
        // The store checks the bytes it receives against this: base64, not hex.
        checksum: Buffer.from(hex, 'hex').toString('base64'),
        checksumType: 'SHA256',
        overwrite: true
      });
      if (!upload?.url) throw failure(503, 'The Forge Object Store gave no upload address.');
      const res = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buffer });
      if (!res.ok) throw failure(res.status >= 500 || res.status === 429 ? 503 : res.status, `The Forge Object Store refused the upload (${res.status}).`);
      return { storage: STORAGE.OBJECT_STORE, objectKey, reused: false };
    },

    /**
     * Bounded downloads use the HTTP Range support documented for createDownloadUrl:
     * https://developer.atlassian.com/platform/forge/storage-reference/object-store-api/
     * A server ignoring Range must never cause us to consume the full object.
     */
    async getContentRange(objectKey, { offset, length, totalBytes }) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || !Number.isSafeInteger(totalBytes)
        || offset < 0 || length < 1 || length > MAX_VAULT_RANGE_BYTES || totalBytes < 0
        || totalBytes > MAX_VAULT_BYTES || offset > totalBytes) throw failure(416, 'Invalid vault download range.');
      const end = Math.min(totalBytes, offset + length);
      if (offset === end) {
        let metadata;
        try { metadata = await fos.get(objectKey); }
        catch { throw failure(503, 'The Forge Object Store metadata could not be read.'); }
        if (!metadata) throw failure(404, `No object ${objectKey} is in the Forge Object Store.`);
        if (Number(metadata.size) !== totalBytes) throw failure(416, 'The retained object size changed.');
        return Buffer.alloc(0);
      }
      let download;
      try { download = await fos.createDownloadUrl(objectKey); }
      catch { throw failure(503, 'The Forge Object Store download address could not be read.'); }
      if (!download?.url) throw failure(404, `No object ${objectKey} is in the Forge Object Store.`);
      const response = await fetch(download.url, { headers: { Range: `bytes=${offset}-${end - 1}` } });
      if (response.status === 404) throw failure(404, `No object ${objectKey} is in the Forge Object Store.`);
      if (response.status === 416) throw failure(416, 'The retained object no longer contains this range.');
      if (response.status !== 206) throw failure(503, `The Forge Object Store did not return a partial download (${response.status}).`);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers?.get?.('content-range') ?? '');
      const contentLength = response.headers?.get?.('content-length');
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== end - 1 || Number(range[3]) !== totalBytes
        || (contentLength != null && Number(contentLength) !== end - offset)) throw failure(416, 'The retained object range or size changed.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== end - offset) throw failure(416, 'The retained object download was truncated.');
      return bytes;
    },

    /** The bytes stored under `objectKey`. 404 when the object is gone, 503 for anything else. */
    async getContent(objectKey) {
      let download;
      try {
        download = await fos.createDownloadUrl(objectKey);
      } catch (error) {
        throw failure(503, `The Forge Object Store could not be read: ${error?.message ?? error}`);
      }
      // The client answers undefined for a key it does not have.
      if (!download?.url) throw failure(404, `No object ${objectKey} is in the Forge Object Store.`);
      const res = await fetch(download.url);
      if (res.status === 404) throw failure(404, `No object ${objectKey} is in the Forge Object Store.`);
      if (!res.ok) throw failure(503, `The Forge Object Store download failed (${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    }
  };
}

/** The production store, loaded only where it is used. */
export async function defaultVaultObjectStore() {
  const [store, forge] = await Promise.all([import('@forge/object-store'), import('@forge/api')]);
  // The named export: `default` is the whole CommonJS module outside a bundler.
  return createVaultObjectStore({ fos: store.objectStore, fetch: forge.fetch });
}
