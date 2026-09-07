import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { newId, throwing } from './store.js';

/**
 * va_restore and va_write_suppression.
 */

const RESTORE_COLUMNS = `
  TO_BASE64(restore_id) AS restore_id, TO_BASE64(approval_id) AS approval_id,
  issue_id, project_id, TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  actor_account_id, started_at, finished_at,
  attempted, succeeded, failed, skipped, irreversible, state, detail
`;

function decode(row) {
  if (!row) return null;
  let detail = [];
  try {
    detail = row.detail ? JSON.parse(row.detail) : [];
  } catch {
    // A report whose detail will not parse still has meaningful counters, and
    // showing those with an empty breakdown is better than showing nothing.
    console.error('restore: unparseable detail for', row.restore_id);
  }
  return {
    ...row,
    restore_id: fromBinaryColumn(row.restore_id),
    approval_id: fromBinaryColumn(row.approval_id),
    baseline_id: fromBinaryColumn(row.baseline_id),
    detail
  };
}

/**
 * Open a restore record before any write happens.
 *
 * WRITTEN FIRST, ON PURPOSE, even though the report is only meaningful once
 * verification has run. If the executor dies halfway — a timeout, a deploy, an
 * unhandled Jira error — an issue that has been half-rewritten with no record
 * of it is the worst possible outcome. A row in state RUNNING with a
 * `started_at` and no `finished_at` is what lets the admin console show
 * "a restore on ABC-12 started and never completed", which is a thing somebody
 * can act on.
 *
 * The counters are all zero here and are only trustworthy after finish().
 */
export async function startRestore({
  approvalId, issueId, projectId, baselineId, baselineVersion, actorAccountId, now
}) {
  const restoreId = newId();
  await throwing(
    `INSERT INTO va_restore
     (restore_id, approval_id, issue_id, project_id, baseline_id, baseline_version,
      actor_account_id, started_at, finished_at, attempted, succeeded, failed, skipped,
      irreversible, state, detail)
     VALUES (FROM_BASE64(?), FROM_BASE64(?), ?, ?, FROM_BASE64(?), ?, ?, ?, NULL, 0, 0, 0, 0, 0, 'RUNNING', NULL)`,
    [
      toBinaryParam(restoreId), toBinaryParam(approvalId), issueId, projectId,
      toBinaryParam(baselineId), baselineVersion, actorAccountId, now
    ]
  );
  return restoreId;
}

/**
 * Close a restore record with VERIFIED counters.
 *
 * The `state` passed here must have been derived from a post-write re-read, not
 * from whether the write calls threw. A field counts as `succeeded` only when
 * the issue was read back and that field matched the baseline. An app whose
 * headline promise is "one click puts it back exactly" cannot report a success
 * it has not confirmed, and a partial restore reporting itself complete is
 * worse than one that fails loudly, because nobody goes looking.
 */
export async function finishRestore({ restoreId, now, counters, state, detail }) {
  await throwing(
    `UPDATE va_restore SET finished_at = ?, attempted = ?, succeeded = ?, failed = ?,
       skipped = ?, irreversible = ?, state = ?, detail = ?
     WHERE restore_id = FROM_BASE64(?)`,
    [
      now,
      counters.attempted, counters.succeeded, counters.failed,
      counters.skipped, counters.irreversible,
      state,
      JSON.stringify(detail ?? []),
      toBinaryParam(restoreId)
    ]
  );
}

export async function restoreById(restoreId) {
  const rows = await throwing(
    `SELECT ${RESTORE_COLUMNS} FROM va_restore WHERE restore_id = FROM_BASE64(?)`,
    [toBinaryParam(restoreId)]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

export async function restoresForIssue(issueId, limit = 20) {
  const rows = await throwing(
    `SELECT ${RESTORE_COLUMNS} FROM va_restore WHERE issue_id = ?
     ORDER BY started_at DESC LIMIT ${limitClause(limit)}`,
    [issueId]
  );
  return rows.map(decode);
}

/** Everything that did not fully succeed, for the admin console. */
export async function restoresNeedingAttention(projectId, limit = 100) {
  const rows = await throwing(
    `SELECT ${RESTORE_COLUMNS} FROM va_restore
     WHERE project_id = ? AND state IN ('PARTIAL', 'FAILED', 'RUNNING')
     ORDER BY started_at DESC LIMIT ${limitClause(limit)}`,
    [projectId]
  );
  return rows.map(decode);
}

// ── va_write_suppression ─────────────────────────────────────────────────────

/**
 * How long a suppression entry stays live.
 *
 * Two minutes. Long enough to cover the gap between our PUT and the
 * avi:jira:updated:issue event it triggers, which is normally sub-second and
 * occasionally much worse under load. Short enough that a suppression left
 * behind by a failed write cannot swallow a genuine edit to the same field
 * later in the day.
 */
export const SUPPRESSION_TTL_MS = 2 * 60 * 1000;

/**
 * Declare a write BEFORE making it.
 *
 * WHY THIS EXISTS. A restore writes to the issue. That write produces a
 * changelog entry and an avi:jira:updated:issue event exactly like any human
 * edit, and without this table the drift collector would faithfully record the
 * restoration itself as fresh drift — leaving the item DRIFTED immediately
 * after being restored to CLEAN, with the reviewer's own reversion sitting in
 * their queue as something to review. A loop, and an embarrassing one.
 *
 * Keyed on the resulting DIGEST rather than on a timestamp window, so the
 * suppression matches the specific value we wrote. A different change to the
 * same field inside the window is still recorded as drift, which is the
 * behaviour you want: suppressing by time would silently swallow a real edit
 * that happened to land while a restore was running.
 *
 * Note that suppressed changes are still RECORDED, with source = 'BASELINE' —
 * the restoration is a real change to the work item and belongs in its history.
 * It is simply not drift.
 */
export async function declareWrite({ issueId, fieldId, digest, now, ttlMs = SUPPRESSION_TTL_MS }) {
  await executeQuery(
    `REPLACE INTO va_write_suppression (issue_id, field_id, digest, written_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [issueId, fieldId, digest, now, now + ttlMs]
  );
}

/**
 * Was this exact field-value written by us?
 *
 * Returns the set of field ids, among those asked about, whose new digest
 * matches a live suppression entry.
 */
export async function suppressedFields({ issueId, digestsByField, now }) {
  const entries = Object.entries(digestsByField ?? {});
  if (entries.length === 0) return new Set();

  const rows = await throwing(
    `SELECT field_id, digest FROM va_write_suppression
     WHERE issue_id = ? AND expires_at > ?`,
    [issueId, now]
  );
  const live = new Map(rows.map((r) => [`${r.field_id}:${r.digest}`, true]));

  const out = new Set();
  for (const [fieldId, digest] of entries) {
    if (digest && live.has(`${fieldId}:${digest}`)) out.add(fieldId);
  }
  return out;
}

export async function pruneSuppressions(now) {
  const result = await executeQuery('DELETE FROM va_write_suppression WHERE expires_at <= ?', [now]);
  return affectedRows(result) ?? 0;
}
