/**
 * Store the alert outbox. lib/alerts.js explains the alert policy and Jira
 * delivery channel.
 *
 * Writes return failure and log errors without throwing. enqueue() runs while
 * resolvers/panel.js is refusing a locked-out signer. An outbox failure must
 * preserve that refusal instead of replacing it with a generic exception that
 * reveals the failing path and hides the useful error.
 *
 * This differs from lib/ledger.js, which refuses an action if it cannot record
 * the evidence. The ledger has already recorded the lockout before enqueue().
 * Failure to deliver its alert must not undo the refusal.
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

/**
 * Count undelivered alerts for the admin console so administrators can detect
 * an outbox that is not draining.
 */
export async function undeliveredCount() {
  const res = await executeQuery(
    'SELECT COUNT(*) AS n FROM va_alert WHERE delivered_at IS NULL'
  );
  if (!res.result) return null;
  return Number(res.data?.[0]?.n ?? 0);
}
