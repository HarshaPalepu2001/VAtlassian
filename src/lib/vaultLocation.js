/**
 * WHERE A VAULTED COPY LIVES. Pure.
 *
 * Attachments are vaulted in the Forge Object Store only.
 */
export const STORAGE = Object.freeze({ OBJECT_STORE: 'OBJECT_STORE' });

/**
 * Object Store keys are content-addressed: the same bytes vaulted from two
 * baselines, or two work items, are one object.
 */
export function objectKeyFor(sha256Hex) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256Hex ?? ''))) throw new Error('A vault object key needs a SHA-256 hex digest.');
  return `vault/sha256/${sha256Hex}`;
}

/** Whether a va_vault_attachment row names somewhere the bytes can be read from. */
export function isReadableCopy(copy) {
  if (!copy) return false;
  return copy.storage === STORAGE.OBJECT_STORE && Boolean(copy.object_key);
}

/** Where a copy is, in words for a refusal or the ledger. */
export function describeLocation(copy) {
  return 'the Forge Object Store';
}
