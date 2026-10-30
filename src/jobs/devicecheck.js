/**
 * Scan for authenticators overdue for an owner check.
 *
 * This replaces the unused jobs/rotation.js stub. Fixed-schedule TOTP secret
 * rotation was abandoned on 2026-08-18. The retained control checks for
 * credentials with no successful verification in 90 days and prompts the owner
 * to reconfirm the authenticator. See lib/deviceCheck.js for the policy.
 *
 * Signatures test a device only when someone signs. A daily dormancy scan can
 * prompt the owner to notice a lost phone or deleted authenticator before its
 * next use. Overdue status does not block signing or raise a security alert
 * through jobs/alerts.js.
 *
 * Record DEVICE_CHECK_DUE once per credential per overdue interval.
 * last_notified_step stores the elapsed interval count, so daily scans do not
 * repeat the same entry unless the credential crosses into another interval.
 */
// Use explicit .js extensions so Node's ESM loader can import this module in
// node --test. Forge resolves extensionless imports, but Node does not.
import { executeQuery, limitClause } from '../lib/db.js';
import { append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import {
  deviceStatus, daysBetween, DEVICE_STATE, DEVICE_CHECK_INTERVAL_MS
} from '../lib/deviceCheck.js';
import { CREDENTIAL_STATE } from '../lib/totp.js';

const BATCH = 500;

/**
 * Return the overdue interval number: 1 at the first crossing, 2 at the second.
 * Use it to decide whether this interval has already been recorded.
 */
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
    // Skip notification when earlier entries cannot be read. The next scan can
    // retry without risking a duplicate ledger entry.
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
