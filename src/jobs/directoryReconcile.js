/**
 * DIRECTORY RECONCILE — revoking signer eligibility for people who have left.
 *
 * manifest.yml has scheduled this daily since it was written, described as
 * "deactivated Jira users -> revoke eligibility", against three empty
 * functions. The policy is in lib/directoryReconcile.js, including the reason
 * this job is the one place in the codebase that deliberately does NOT fail
 * closed: every other control refuses an action when unsure, which is safe,
 * whereas revoking on incomplete information TAKES an action on evidence we did
 * not confirm. Missing from the directory is not the same as deactivated.
 *
 * WHAT IT DOES NOT NEED TO DO. It does not have to race anything. Revocation by
 * hand is already immediate — resolvers/panel.js checks va_eligibility live
 * before creating a signature, and gate.js re-checks it before consuming one,
 * so a revoked signer is stopped even mid-approval. This job is not the
 * enforcement; it is the part that notices a person is gone when nobody
 * remembered to tell us. Daily is the right cadence for that.
 *
 * IT REVOKES ELIGIBILITY, NOT CREDENTIALS. A deactivated account cannot hold a
 * session, so its authenticator is already unusable; deleting the credential
 * would destroy the enrolment record behind signatures that person made while
 * they were employed, which is evidence 11.10(c) says to keep. Authority is
 * what gets withdrawn. The record stays.
 */
import { executeQuery } from '../lib/db.js';
import { append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import { lookupUsers } from '../lib/directory.js';
import { revocations, unresolved, REVOCATION_REASON } from '../lib/directoryReconcile.js';

const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';
const ACTOR = 'system:reconcile';

async function loadActiveEligibility() {
  const res = await executeQuery(
    'SELECT TO_BASE64(el_id) AS el_id, account_id, issue_type_id, role FROM va_eligibility WHERE state = ?',
    [ACTIVE]
  );
  if (!res.result) throw new Error(`reconcile: could not read eligibility: ${res.error}`);
  return res.data ?? [];
}

/**
 * Revoke every ACTIVE row this account holds, in one statement.
 *
 * Per account rather than per row: someone who has left the company has left
 * for every issue type and role at once, and issuing one UPDATE per row would
 * leave a half-revoked signer if the job died in the middle.
 */
async function revokeAllFor(accountId) {
  const res = await executeQuery(
    'UPDATE va_eligibility SET state = ? WHERE account_id = ? AND state = ?',
    [REVOKED, accountId, ACTIVE]
  );
  if (!res.result) {
    console.error(`reconcile: could not revoke eligibility for ${accountId}`, res.error);
    return false;
  }
  return true;
}

export async function run({ directory = lookupUsers } = {}) {
  const started = Date.now();

  const rows = await loadActiveEligibility();
  if (rows.length === 0) {
    return { ok: true, checked: 0, revoked: 0, ms: Date.now() - started };
  }

  const accountIds = [...new Set(rows.map((r) => r.account_id))];

  // lookupUsers swallows its own errors and returns whatever it managed to
  // resolve, so an empty map is ambiguous between "call failed" and "nobody
  // found". Treat an empty result against a non-empty request as a failed
  // lookup: on a site with eligibility configured, the alternative reading is
  // that the entire company left on the same day.
  let resolved;
  let lookupFailed = false;
  try {
    resolved = await directory(accountIds);
    if (!resolved || resolved.size === 0) lookupFailed = true;
  } catch (e) {
    console.error('reconcile: directory lookup threw; revoking nothing this run', e);
    resolved = new Map();
    lookupFailed = true;
  }

  if (lookupFailed) {
    console.error('reconcile: directory unreadable, revoking nothing', JSON.stringify({ accounts: accountIds.length }));
    return { ok: false, reason: 'DIRECTORY_UNREADABLE', checked: accountIds.length, revoked: 0 };
  }

  const toRevoke = revocations(rows, resolved, { lookupFailed });
  const unknown = unresolved(rows, resolved);

  let revoked = 0;
  for (const { accountId, reason } of toRevoke) {
    const rolesLost = rows
      .filter((r) => r.account_id === accountId)
      .map((r) => `${r.role}@${r.issue_type_id}`);

    if (!(await revokeAllFor(accountId))) continue;
    revoked += 1;

    try {
      await append(auditStore, {
        eventId: newId(),
        actorAccountId: ACTOR,
        eventType: EVENT.ELIGIBILITY_CHANGED,
        payload: {
          action: 'REVOKED',
          targetAccountId: accountId,
          reason,
          // Named individually so the ledger says exactly what authority was
          // withdrawn, not merely that something was.
          rolesRevoked: rolesLost
        }
      });
    } catch (e) {
      // The revocation itself has already landed and is the control. A missing
      // ledger entry is bad and is logged loudly, but restoring the eligibility
      // to keep the two in step would be strictly worse.
      console.error(`reconcile: revoked ${accountId} but could not record it`, e);
    }
  }

  if (unknown.length > 0) {
    // Not revoked — see lib/directoryReconcile.js. Surfaced so an administrator
    // can decide, because a deleted account and a truncated page look the same
    // from here.
    console.warn('reconcile: eligibility rows for accounts Jira did not resolve', JSON.stringify(unknown.slice(0, 20)));
  }

  const summary = {
    ok: true,
    checked: accountIds.length,
    revoked,
    unresolved: unknown.length,
    reason: REVOCATION_REASON.DEACTIVATED,
    ms: Date.now() - started
  };
  console.log('reconcile:', JSON.stringify(summary));
  return summary;
}

export const handler = run;
