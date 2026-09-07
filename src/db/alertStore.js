/**
 * Persistence for the alert outbox. See lib/alerts.js for why alerts exist and
 * why Jira is the delivery channel; this file is only storage.
 *
 * EVERY WRITE HERE IS BEST-EFFORT AND SAYS SO. enqueue() is called from the
 * middle of a request that is already refusing a signer — the lockout path in
 * resolvers/panel.js. If the outbox INSERT fails, the correct outcome is a
 * logged error and a completed refusal, never an exception that turns "your
 * code was wrong" into "something went wrong", which would tell an attacker
 * they had found an edge and tell an honest user nothing useful.
 *
 * That is a deliberate asymmetry with lib/ledger.js, which fails CLOSED when it
 * cannot record. The difference is what the record is for: an unrecorded
 * signature would be an action taken without evidence, so it must not happen;
 * an undelivered alert is evidence that exists (the ledger already has the
 * lockout) but has not yet been carried to a person. Losing the carrier must
 * not also lose the refusal.
 */
import { executeQuery, toBinaryParam, affectedRows, limitClause } from '../lib/db.js';
import { newId } from './store.js';

/**
 * Put an alert in the outbox. Returns true if it is now queued or was already
 * queued, false only if it could not be stored at all.
 *
 * The UNIQUE key on dedupe_key does the collapsing: a condition observed again
 * updates nothing and creates nothing. `attempts` and `delivered_at` are
 * deliberately untouched on conflict, so re-observing an already-delivered
 * alert does not resurrect it and re-notify.
 */
export async function enqueue(alert) {
  const res = await executeQuery(
    `INSERT INTO va_alert
       (alert_id, dedupe_key, kind, severity, title, body, occurred_at, attempts, last_error, delivered_at, delivery_ref)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)
     ON DUPLICATE KEY UPDATE dedupe_key = dedupe_key`,
    [
      toBinaryParam(newId()),
      alert.dedupeKey,
      alert.kind,
      alert.severity,
      alert.title,
      JSON.stringify(alert.body),
      alert.occurredAt
    ]
  );
  if (!res.result) {
    console.error('alertStore: could not enqueue alert', alert.dedupeKey, res.error);
    return false;
  }
  return true;
}

/** Undelivered alerts, oldest first. */
export async function pending(limit = 25) {
  const res = await executeQuery(
    `SELECT TO_BASE64(alert_id) AS alert_id, dedupe_key, kind, severity, title, body,
            occurred_at, attempts
       FROM va_alert
      WHERE delivered_at IS NULL
      ORDER BY occurred_at ASC
      LIMIT ${limitClause(limit)}`
  );
  if (!res.result) {
    console.error('alertStore: could not read pending alerts', res.error);
    return null;
  }
  return res.data ?? [];
}

export async function markDelivered(alertIdBase64, ref, now = Date.now()) {
  const res = await executeQuery(
    `UPDATE va_alert SET delivered_at = ?, delivery_ref = ?, last_error = NULL
      WHERE alert_id = FROM_BASE64(?) AND delivered_at IS NULL`,
    [now, String(ref).slice(0, 64), alertIdBase64]
  );
  if (!res.result) {
    console.error('alertStore: could not mark alert delivered', alertIdBase64, res.error);
    return false;
  }
  // Zero rows means someone else delivered it first. Not an error: the alert
  // reached a person, which is the only thing that matters.
  return affectedRows(res) !== 0;
}

export async function markAttemptFailed(alertIdBase64, error) {
  const res = await executeQuery(
    `UPDATE va_alert SET attempts = attempts + 1, last_error = ?
      WHERE alert_id = FROM_BASE64(?)`,
    [String(error).slice(0, 500), alertIdBase64]
  );
  if (!res.result) console.error('alertStore: could not record delivery failure', alertIdBase64, res.error);
  return res.result === true;
}

/** How much is stuck. Surfaced in the admin console, because an outbox nobody
 *  can drain is the same failure as no outbox at all — just quieter. */
export async function undeliveredCount() {
  const res = await executeQuery(
    'SELECT COUNT(*) AS n FROM va_alert WHERE delivered_at IS NULL'
  );
  if (!res.result) return null;
  return Number(res.data?.[0]?.n ?? 0);
}
