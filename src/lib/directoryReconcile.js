/**
 * DIRECTORY RECONCILIATION — taking away what someone should no longer have.
 *
 * 21 CFR 11.300(b) asks that identification code issuances be "periodically
 * checked, recalled, or revised". Two halves: checking that a credential still
 * works, which is lib/deviceCheck.js, and recalling one that should no longer
 * exist, which is this.
 *
 * THE GAP THIS CLOSES. Revoking eligibility by hand already takes effect
 * instantly — resolvers/panel.js checks va_eligibility live before creating a
 * signature, and gate.js re-checks it again before consuming one, so a revoked
 * signer cannot sign and cannot even complete a transition on a signature they
 * made minutes earlier. What nothing did was notice that a person had left. An
 * employee whose Atlassian account is deactivated on their last day keeps an
 * ACTIVE va_eligibility row indefinitely, because deactivation happens in
 * Atlassian's directory and this app was never looking at it.
 *
 * In practice their session dies with the account, so this is not an open door
 * so much as a lie in the record: the console goes on listing them as an
 * authorised signer, and "who was authorised to sign in March" — the question
 * an auditor actually asks — gets the wrong answer forever.
 *
 * NEVER REVOKE ON SILENCE. The rule that shapes everything here. Revocation is
 * destructive and, for a signer mid-approval, disruptive. The directory can be
 * unreachable, rate-limited, or partial; an account id can be missing from a
 * bulk response for reasons that have nothing to do with the person. So this
 * revokes ONLY on a positive statement that the account is inactive. Missing is
 * not inactive. An error is not inactive. An empty response is not everyone
 * having left the company.
 *
 * That is the opposite of the fail-closed posture everywhere else in this
 * codebase, and deliberately so: failing closed means refusing an action, which
 * is safe. Revoking on incomplete information means TAKING an action on the
 * strength of something we did not confirm.
 *
 * PURE. Policy here; jobs/reconcile.js does the I/O.
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
 * Account ids that the directory could not account for.
 *
 * Reported rather than acted on: an eligibility row for an account Jira has
 * never heard of is worth an administrator's attention — a deleted user, a
 * mistyped id, a row that outlived a site migration — but it is not something
 * to resolve by guessing.
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
