/**
 * Reconcile signer eligibility with Atlassian account status each day.
 *
 * The scheduled job replaces the empty functions originally registered in
 * manifest.yml. lib/directoryReconcile.js defines the policy: revoke only on
 * confirmed deactivation. Missing accounts and failed reads leave eligibility
 * unchanged.
 *
 * Live eligibility reads already enforce manual revocation before signature
 * creation in resolvers/panel.js and consumption in gate.js. This job finds
 * accounts whose deactivation has not yet been reflected in va_eligibility.
 *
 * Revoke eligibility but retain credentials. A deactivated account cannot hold
 * a session, while its enrolment record remains evidence for earlier signatures
 * under 21 CFR 11.10(c).
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
    // Report without revoking. A deleted account and an incomplete page are
    // indistinguishable here; an administrator must investigate.
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
