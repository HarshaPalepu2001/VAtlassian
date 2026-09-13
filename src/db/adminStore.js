import { executeQuery } from '../lib/db.js';

/**
 * Single indexed read on va_admin.
 *
 * Checks whether the account holds an active administrator grant.
 * Never uses the Jira user REST API, which is slow and requires external round trips.
 */
export async function isActiveAdmin(accountId) {
  if (typeof accountId !== 'string' || !accountId) return false;
  const result = await executeQuery("SELECT 1 FROM va_admin WHERE account_id = ? AND state = 'ACTIVE' LIMIT 1", [accountId]);
  if (!result?.result) return false;
  return Array.isArray(result.data) && result.data.length > 0;
}
