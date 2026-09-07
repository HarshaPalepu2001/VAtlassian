/** Shared key validation for TOTP consumers. Never returned by an endpoint. */
export function getEncryptionKey() {
  const value = process.env.TOTP_ENC_KEY_V1?.trim();
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error('Server misconfiguration: TOTP_ENC_KEY_V1 must contain exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}
