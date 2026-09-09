import { executeQuery } from '../lib/db.js';

/**
 * The credential lifecycle state, and nothing else.
 *
 * WHY THIS IS NOT lib/approval/totpRuntime.js's `read`. That one selects the
 * encrypted secret because verification needs it. The panel only needs to know
 * whether this reviewer can sign at all, and pulling key material through a
 * read-only display path to answer a yes/no question is how secrets end up
 * somewhere they were never meant to be. This selects one column.
 */
export async function credentialState(accountId) {
  if (typeof accountId !== 'string' || !accountId) return null;
  const result = await executeQuery('SELECT state FROM va_credential WHERE account_id = ?', [accountId]);
  if (!result.result) throw result.error ?? new Error('Credential storage unavailable');
  return result.data[0] ?? null;
}
