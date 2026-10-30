import { executeQuery } from '../lib/db.js';

/**
 * Read only the credential lifecycle state needed to show whether a reviewer
 * can sign. lib/approval/totpRuntime.js read also selects the encrypted secret
 * for verification; keep that key material out of this display-only path.
 */
export async function credentialState(accountId) {
  if (typeof accountId !== 'string' || !accountId) return null;
  const result = await executeQuery('SELECT state FROM va_credential WHERE account_id = ?', [accountId]);
  if (!result.result) throw result.error ?? new Error('Credential storage unavailable');
  return result.data[0] ?? null;
}
