import crypto from 'node:crypto';
export function totpFixture(now) {
  const key = Buffer.alloc(32, 2);
  return {
    now, key: () => key, consume: async () => true, fail: async () => true,
    audit: async () => {}, alert: async () => {}, activate: async () => true,
    read: async () => {
      const iv = Buffer.alloc(16, 3);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(20, 1)), cipher.final()]);
      return { state: 'ACTIVE', algo: 'TOTP-SHA1', digits: 6, period_seconds: 30,
        key_version: 1, version: 1, ciphertext, iv, tag: cipher.getAuthTag() };
    }
  };
}
