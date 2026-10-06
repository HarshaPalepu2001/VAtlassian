/**
 * WHERE A VAULTED COPY LIVES. Pure.
 *
 * A site with Confluence keeps copies in its private vault space; a Jira-only
 * site keeps them in the Forge Object Store (./vaultTier.js). Each copy's row
 * in va_vault_attachment says which, and a restore reads it back from there.
 */
export const STORAGE = Object.freeze({ CONFLUENCE: 'CONFLUENCE', OBJECT_STORE: 'OBJECT_STORE' });

/**
 * Object Store keys are content-addressed: the same bytes vaulted from two
 * baselines, or two work items, are one object. The prefix keeps them apart
 * from the Confluence page-governance snapshots, which are keyed by bare hash
 * and have their own lifecycle.
 */
export function objectKeyFor(sha256Hex) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256Hex ?? ''))) throw new Error('A vault object key needs a SHA-256 hex digest.');
  return `vault/sha256/${sha256Hex}`;
}

/** Whether a va_vault_attachment row (joined to its page) names somewhere the bytes can be read from. */
export function isReadableCopy(copy) {
  if (!copy) return false;
  if ((copy.storage ?? STORAGE.CONFLUENCE) === STORAGE.OBJECT_STORE) return Boolean(copy.object_key);
  return Boolean(copy.confluence_attachment_id && copy.confluence_page_id);
}

/** Where a copy is, in words for a refusal or the ledger. */
export function describeLocation(copy) {
  return (copy?.storage ?? STORAGE.CONFLUENCE) === STORAGE.OBJECT_STORE
    ? 'the Forge Object Store'
    : 'the Confluence vault';
}
