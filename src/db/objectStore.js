import { default as fos } from '@forge/object-store';
import { fetch } from '@forge/api';
import { createHash } from 'crypto';

export const objectStore = {
  async set(key, value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const checksum = createHash('sha256').update(buffer).digest('hex');
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

