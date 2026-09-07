import { executeQuery } from '../lib/db.js';
import { pruneSupersededValues } from '../db/baselineStore.js';
import { pruneReports } from '../db/reportStore.js';
import { pruneSuppressions } from '../db/restoreStore.js';
import { limitClause } from '../lib/db.js';

/**
 * Retention.
 *
 * THE ASYMMETRY IS THE POINT, and it is worth stating in one sentence before
 * any of the code: the history of WHAT HAPPENED is evidence and is never
 * deleted; superseded CONTENTS are not evidence and are what consumes the
 * install's storage budget.
 *
 * So this job deletes:
 *   - field values belonging to baselines that are no longer current,
 *   - cached AI reports that no decision refers to,
 *   - expired write-suppression entries and old event receipts.
 *
 * And never deletes:
 *   - va_baseline rows, their digests or their fidelity grades,
 *   - va_drift rows,
 *   - va_decision rows,
 *   - va_restore reports,
 *   - anything in va_audit.
 *
 * An app that stored only hashes would never face this trade. Baseline stores
 * values, so it does — and the answer is that a customer can always prove what
 * was approved, who changed it and who ruled on it, even after the copy of the
 * old description is gone.
 */

/** How many superseded baseline versions keep their values. */
const KEEP_VERSIONS = 2;

/** Report cache and event receipts older than this go. */
const REPORT_RETENTION_DAYS = 90;
const RECEIPT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Items to sweep per run.
 *
 * Bounded like the reconcile job, and for the same reason: a daily trigger has
 * an invocation budget. Ordered by issue_id so successive runs cover the whole
 * set rather than re-examining the same items.
 */
const BATCH = 200;

export async function run({ now = Date.now() } = {}) {
  const started = now;
  let valuesPruned = 0;
  let itemsExamined = 0;

  try {
    // Items with more than KEEP_VERSIONS baselines are the only ones that can
    // have anything to prune. Asking the database that question is far cheaper
    // than walking every baselined item and finding nothing.
    const result = await executeQuery(
      `SELECT issue_id FROM va_baseline
       GROUP BY issue_id HAVING COUNT(*) > ?
       ORDER BY issue_id ASC LIMIT ${limitClause(BATCH)}`,
      [KEEP_VERSIONS]
    );

    if (result.result) {
      for (const row of result.data) {
        valuesPruned += await pruneSupersededValues({
          issueId: row.issue_id,
          keepVersions: KEEP_VERSIONS
        });
        itemsExamined++;
      }
    }
  } catch (e) {
    console.error('prune: baseline values failed', e);
  }

  let reportsPruned = 0;
  try {
    reportsPruned = await pruneReports(now - REPORT_RETENTION_DAYS * DAY_MS);
  } catch (e) {
    console.error('prune: reports failed', e);
  }

  let receiptsPruned = 0;
  try {
    const res = await executeQuery(
      'DELETE FROM va_event_receipt WHERE received_at < ?',
      [now - RECEIPT_RETENTION_DAYS * DAY_MS]
    );
    receiptsPruned = res.result ? (res.data?.affectedRows ?? 0) : 0;
  } catch (e) {
    console.error('prune: receipts failed', e);
  }

  let suppressionsPruned = 0;
  try {
    suppressionsPruned = await pruneSuppressions(now);
  } catch (e) {
    console.error('prune: suppressions failed', e);
  }

  console.log('prune: done', JSON.stringify({
    itemsExamined, valuesPruned, reportsPruned, receiptsPruned, suppressionsPruned,
    elapsedMs: Date.now() - started
  }));

  return { itemsExamined, valuesPruned, reportsPruned, receiptsPruned, suppressionsPruned };
}

/**
 * How much space the value store is using, for the admin console's retention
 * screen.
 *
 * An administrator who has been asked to turn on value retention for a field
 * deserves to see what that decision costs, in the same place they made it.
 */
export async function storageReport() {
  const result = await executeQuery(
    `SELECT COUNT(DISTINCT issue_id) AS items,
            COUNT(*) AS chunks,
            SUM(raw_bytes) AS raw_bytes,
            SUM(LENGTH(data)) AS stored_bytes
     FROM va_baseline_value`
  );
  if (!result.result || result.data.length === 0) {
    return { items: 0, chunks: 0, rawBytes: 0, storedBytes: 0, compression: null };
  }
  const r = result.data[0];
  const raw = Number(r.raw_bytes ?? 0);
  const stored = Number(r.stored_bytes ?? 0);
  return {
    items: Number(r.items ?? 0),
    chunks: Number(r.chunks ?? 0),
    rawBytes: raw,
    storedBytes: stored,
    // Shown as "4.2× smaller than the original text", which is the figure that
    // makes retention feel affordable rather than alarming.
    compression: stored > 0 ? Number((raw / stored).toFixed(1)) : null
  };
}
