/**
 * DEVICE CHECK SCAN — noticing the authenticators that have gone quiet.
 *
 * Replaces jobs/rotation.js, which was a three-line stub whose scheduled
 * trigger had been commented out since 2026-08-18. The comment left in the
 * manifest described exactly the right control — "flags credentials with zero
 * successful verifications in 90 days, a likely-lost or likely-uninstalled
 * authenticator, and prompts self-service re-confirmation" — and no code
 * performed it. The file is renamed because a file called `rotation` that does
 * not rotate anything is a trap for whoever reads it next: the 2026-08-18 note
 * is clear that fixed-schedule TOTP secret rotation was deliberately abandoned
 * as pointless churn, and the name outlived the idea.
 *
 * WHY THIS JOB EXISTS AT ALL, given lib/deviceCheck.js's argument that every
 * signature is already a device test. Because the test only happens when
 * somebody signs. A device that nobody uses is never tested, and that is
 * precisely where the risk sits: a replaced phone, a deleted app, a secret
 * copied at enrolment and saved for later. None of it surfaces until a
 * signature — and if the person signing is not the owner, the first evidence is
 * the forged signature itself. Scanning for silence is what moves the discovery
 * to the owner, who knows whether they still have their phone.
 *
 * IT PROMPTS, IT DOES NOT PUNISH. An overdue device is not blocked, and no
 * alert is raised through jobs/alerts.js. The alert channel is for things
 * somebody must act on tonight; an authenticator nobody has used since May is
 * housekeeping, and a channel that pages for housekeeping stops being read —
 * which would cost us the findings that mean signatures are being forged.
 *
 * ONE LEDGER ENTRY PER CREDENTIAL PER OVERDUE PERIOD. Without that, a daily
 * scan would write DEVICE_CHECK_DUE for the same dormant account every day
 * forever, and the audit trail would fill with a fact it already recorded. The
 * guard is `last_notified_step`, derived from how many whole intervals have
 * elapsed: the entry repeats only when the credential crosses into a new one.
 */
// Explicit .js extensions. Much of this codebase omits them and gets away with
// it because the Forge bundler resolves extensionless specifiers — but Node's
// own ESM loader does not, so an extensionless import here would make this file
// unimportable from `node --test`. The pure helpers below are unit-tested
// directly, and a module the tests cannot load is a module the tests do not
// cover.
import { executeQuery, limitClause } from '../lib/db.js';
import { append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import {
  deviceStatus, daysBetween, DEVICE_STATE, DEVICE_CHECK_INTERVAL_MS
} from '../lib/deviceCheck.js';
import { CREDENTIAL_STATE } from '../lib/totp.js';

const BATCH = 500;

/** Which overdue interval a credential is currently in. 1 on first crossing,
 *  2 after a second interval of silence, and so on — the number that decides
 *  whether this is a new fact or one already recorded. */
export function overduePeriod(msSinceProven) {
  if (msSinceProven == null) return 0;
  return Math.floor(msSinceProven / DEVICE_CHECK_INTERVAL_MS);
}

/** Whether this scan should write a ledger entry for a credential. Pure, so the
 *  once-per-period rule is testable without a database. */
export function shouldRecord(status, alreadyRecordedPeriod) {
  if (status.state !== DEVICE_STATE.DUE) return false;
  return overduePeriod(status.msSinceProven) > (alreadyRecordedPeriod ?? 0);
}

async function loadActiveCredentials() {
  const res = await executeQuery(
    `SELECT account_id, state, confirmed_at, last_verified_at, verification_count
       FROM va_credential
      WHERE state = ?
      LIMIT ${limitClause(BATCH)}`,
    [CREDENTIAL_STATE.ACTIVE]
  );
  if (!res.result) throw new Error(`devicecheck: could not read credentials: ${res.error}`);
  return res.data ?? [];
}

/** What has already been recorded, so a repeat scan stays quiet.
 *  Read from the ledger rather than a side table: the ledger is already the
 *  record of what we told anyone, and a second store of the same fact would
 *  eventually disagree with it. */
async function recordedPeriods() {
  const res = await executeQuery(
    `SELECT actor_account_id, payload FROM va_audit WHERE event_type = ?`,
    [EVENT.DEVICE_CHECK_DUE]
  );
  if (!res.result) {
    // Cannot tell what was already said. Stay quiet rather than risk writing a
    // duplicate entry into an audit trail — a missed prompt is recoverable next
    // scan, a polluted ledger is not.
    console.error('devicecheck: could not read prior notices; skipping this scan', res.error);
    return null;
  }
  const highest = new Map();
  for (const row of res.data ?? []) {
    let period = 0;
    try { period = Number(JSON.parse(row.payload)?.overduePeriod ?? 0); } catch { period = 0; }
    const current = highest.get(row.actor_account_id) ?? 0;
    if (period > current) highest.set(row.actor_account_id, period);
  }
  return highest;
}

export async function run({ now = Date.now() } = {}) {
  const started = Date.now();

  const credentials = await loadActiveCredentials();
  if (credentials.length === 0) {
    return { ok: true, scanned: 0, due: 0, recorded: 0, ms: Date.now() - started };
  }

  const already = await recordedPeriods();
  if (already === null) {
    return { ok: false, reason: 'LEDGER_UNREADABLE', scanned: credentials.length };
  }

  let due = 0;
  let recorded = 0;
  const overdue = [];

  for (const credential of credentials) {
    const status = deviceStatus(credential, now);
    if (status.state !== DEVICE_STATE.DUE) continue;
    due += 1;
    overdue.push({ accountId: credential.account_id, days: daysBetween(status.lastProvenAt, now) });

    if (!shouldRecord(status, already.get(credential.account_id))) continue;

    try {
      await append(auditStore, {
        eventId: newId(),
        actorAccountId: credential.account_id,
        eventType: EVENT.DEVICE_CHECK_DUE,
        payload: {
          overduePeriod: overduePeriod(status.msSinceProven),
          daysSinceProven: daysBetween(status.lastProvenAt, now),
          verificationCount: status.verificationCount ?? 0
        }
      });
      recorded += 1;
    } catch (e) {
      // One unwritable entry must not stop the scan; the credential stays
      // overdue and is picked up again next run.
      console.error(`devicecheck: could not record notice for ${credential.account_id}`, e);
    }
  }

  const summary = {
    ok: true,
    scanned: credentials.length,
    due,
    recorded,
    truncated: credentials.length === BATCH,
    ms: Date.now() - started
  };
  console.log('devicecheck:', JSON.stringify(summary), due > 0 ? JSON.stringify(overdue.slice(0, 20)) : '');
  return summary;
}

export const handler = run;
