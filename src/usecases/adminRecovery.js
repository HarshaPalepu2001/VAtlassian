import { runAdmin } from './adminRuntime.js';

export async function issueCredentialResetGrant(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, toBinaryParam, append, EVENT, auditStore, newId, lookupUsers, grantExpiry } = deps;
    const { accountId } = req.context;
  const targetAccountId = req.payload?.targetAccountId;
  if (!targetAccountId) return { success: false, error: 'Choose the person whose authenticator needs resetting.' };
  if (targetAccountId === accountId) {
    return { success: false, error: 'You cannot issue yourself a reset. Ask another administrator. Replacing a signature credential requires two people.' };
  }
  if (typeof targetAccountId !== 'string' || targetAccountId.length > 128) throw new Error('Invalid target account.');
  const target = (await lookupUsers([targetAccountId])).get(targetAccountId);
  if (!target || target.active === false) throw new Error('Choose an active Jira user.');
  const now = Date.now();
  const grantId = newId();
  await append(auditStore, {
    eventId: newId(), actorAccountId: accountId,
    eventType: EVENT.CREDENTIAL_RESET_GRANT_ISSUED,
    payload: { targetAccountId, grantId: grantId.toString('hex'), expiresAt: grantExpiry(now), action: 'ISSUE_REQUESTED' }
  });
  const insert = await executeQuery(
    `INSERT INTO va_credential_reset_grant (grant_id, account_id, issued_by, issued_at, expires_at, redeemed_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, NULL)`,
    [toBinaryParam(grantId), targetAccountId, accountId, now, grantExpiry(now)]
  );
  if (!insert.result) return { success: false, error: 'Failed to issue reset grant' };
  return { success: true, expiresAt: grantExpiry(now) };
  }, overrides, 'adminRecovery');
}

export async function listCredentialResetGrants(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, limitClause, lookupUsers } = deps;
    const { accountId } = req.context;
  const result = await executeQuery(
    `SELECT account_id, issued_by, issued_at, expires_at, redeemed_at
       FROM va_credential_reset_grant
      ORDER BY issued_at DESC
      LIMIT ${limitClause(100)}`
  );
  if (!result.result) return { success: false, error: 'Failed to list reset grants' };
  const rows = result.data ?? [];
  const users = await lookupUsers(rows.flatMap((r) => [r.account_id, r.issued_by]));
  const now = Date.now();
  return {
    success: true,
    grants: rows.map((row) => ({
      accountId: row.account_id,
      forName: users.get(row.account_id)?.displayName ?? null,
      issuedByName: users.get(row.issued_by)?.displayName ?? null,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      redeemedAt: row.redeemed_at,
      status: row.redeemed_at != null ? 'REDEEMED' : (Number(row.expires_at) > now ? 'OPEN' : 'EXPIRED')
    }))
  };
  }, overrides, 'adminRecovery');
}
