// The named export: `default` is the whole CommonJS module outside a bundler.
import { objectStore as fos } from '@forge/object-store';
import { fetch } from '@forge/api';
import { createHash } from 'crypto';

export const objectStore = {
  async set(key, value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    // The store checks the upload against this, and expects it base64-encoded.
    const checksum = createHash('sha256').update(buffer).digest('base64');
    const uploadDetails = await fos.createUploadUrl({
      key,
      length: buffer.length,
      checksum,
      checksumType: 'SHA256'
    });
    if (!uploadDetails || !uploadDetails.url) {
       throw new Error('Failed to get upload URL');
    }
    const response = await fetch(uploadDetails.url, {
       method: 'PUT',
       body: buffer
    });
    if (!response.ok) {
       throw new Error(`Failed to upload to object store: ${response.statusText}`);
    }
    return key;
  },
  async get(key) {
    try {
      const downloadDetails = await fos.createDownloadUrl(key);
      if (!downloadDetails || !downloadDetails.url) return null;
      const response = await fetch(downloadDetails.url);
      if (!response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (e) {
      if (e.message?.includes('not found')) return null;
      throw e;
    }
  },
  async delete(key) {
    try {
      await fos.delete(key);
    } catch (e) {
      if (!e.message?.includes('not found')) throw e;
    }
  }
};

