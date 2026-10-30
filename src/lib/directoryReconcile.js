/**
 * Revoke signer eligibility after confirmed account deactivation.
 *
 * 21 CFR 11.300(b) calls for periodic checks, recall or revision of identification
 * code issuances. lib/deviceCheck.js checks authenticator use; this module
 * checks whether an account should retain signing authority.
 *
 * Manual revocation already takes effect at signing and again at signature
 * consumption through live va_eligibility reads in resolvers/panel.js and
 * gate.js. Directory reconciliation also removes ACTIVE eligibility rows after
 * an Atlassian account is deactivated. Without it, the console and historical
 * authority records could continue to list a former employee as authorized.
 *
 * Revoke only after an explicit inactive-account response. A missing account,
 * partial bulk response, rate limit or directory error does not prove
 * inactivity. Refusing a signature on uncertain evidence is safe; revoking
 * someone's authority on uncertain evidence would change their access.
 *
 * This module contains pure policy functions; jobs/reconcile.js performs the I/O.
 */

export const REVOCATION_REASON = {
  /** Jira says the account exists and is deactivated. */
  DEACTIVATED: 'DEACTIVATED'
};

/**
 * Which eligibility rows should be revoked, given what the directory said.
 *
 * @param {Array<{account_id: string}>} rows        ACTIVE eligibility rows.
 * @param {Map<string, {active: boolean}>} directory What lookupUsers returned.
 * @param {{lookupFailed?: boolean}} options         True when the directory
 *        call itself errored, which suppresses all revocation.
 */
export function revocations(rows, directory, { lookupFailed = false } = {}) {
  if (lookupFailed) return [];
  if (!directory || directory.size === 0) {
    // Nothing came back at all. On a site with eligibility configured that is
    // far more likely to be a broken call than a company that has emptied out.
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const row of rows ?? []) {
    const accountId = row?.account_id;
    if (!accountId || seen.has(accountId)) continue;

    const entry = directory.get(accountId);
    // Missing from the response is NOT a revocation trigger. Deleted accounts
    // and truncated pages look identical from here, and only one of them is a
    // reason to strip somebody's authority.
    if (!entry) continue;
    if (entry.active !== false) continue;

    seen.add(accountId);
    out.push({ accountId, reason: REVOCATION_REASON.DEACTIVATED });
  }
  return out;
}

/**
 * Report account IDs the directory did not return, without changing access.
 * An administrator may need to investigate a deleted user, mistyped ID or
 * post-migration row. Missing data does not justify automatic revocation.
 */
export function unresolved(rows, directory) {
  if (!directory) return [];
  const out = new Set();
  for (const row of rows ?? []) {
    const accountId = row?.account_id;
    if (accountId && !directory.has(accountId)) out.add(accountId);
  }
  return [...out];
}
