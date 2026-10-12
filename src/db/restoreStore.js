import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { newId, throwing } from './store.js';

/**
 * va_restore and va_write_suppression.
 */

const RESTORE_COLUMNS = `
  TO_BASE64(restore_id) AS restore_id, TO_BASE64(approval_id) AS approval_id,
  issue_id, project_id, TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  actor_account_id, started_at, finished_at,
  attempted, succeeded, failed, skipped, irreversible, state, detail, candidate_digests
  ,job_id, queued_at, heartbeat_at, total_steps, completed_steps, last_checkpoint, last_error
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
  let candidateDigests = {};
  try {
    candidateDigests = row.candidate_digests ? JSON.parse(row.candidate_digests) : {};
  } catch {
    // Unlike detail, this one has a consequence: lib/restore/resume.js treats an
    // empty candidate as NO_SIGNED_CANDIDATE and refuses the retry. Failing to
    // an empty object is therefore failing closed, which is what we want.
    console.error('restore: unparseable candidate digests for', row.restore_id);
  }
  return {
    ...row,
    restore_id: fromBinaryColumn(row.restore_id),
    approval_id: fromBinaryColumn(row.approval_id),
    baseline_id: fromBinaryColumn(row.baseline_id),
    detail,
    candidate_digests: candidateDigests
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
  approvalId, issueId, projectId, baselineId, baselineVersion, actorAccountId, now,
  candidateDigests = {}, state = 'RUNNING', totalSteps = 0, detail = null
}) {
  const restoreId = newId();
  await throwing(
    `INSERT INTO va_restore
     (restore_id, approval_id, issue_id, project_id, baseline_id, baseline_version,
      actor_account_id, started_at, finished_at, attempted, succeeded, failed, skipped,
      irreversible, state, detail, candidate_digests, job_id, queued_at, heartbeat_at,
      total_steps, completed_steps, last_checkpoint, last_error)
     VALUES (FROM_BASE64(?), FROM_BASE64(?), ?, ?, FROM_BASE64(?), ?, ?, ?, NULL, 0, 0, 0, 0, 0, ?, ?, ?, NULL, NULL, NULL, ?, 0, NULL, NULL)`,
    [
      toBinaryParam(restoreId), toBinaryParam(approvalId), issueId, projectId,
      toBinaryParam(baselineId), baselineVersion, actorAccountId, now,
      state, detail == null ? null : JSON.stringify(detail), JSON.stringify(candidateDigests ?? {}),
      totalSteps
    ]
  );
  return restoreId;
}

function changed(result) {
  return Number(result?.affectedRows ?? result?.data?.affectedRows ?? 0) > 0;
}

function errorText(error) {
  return String(error?.message ?? error ?? 'Unknown restore queue failure').slice(0, 2000);
}

/** Publish a queue job only after the restore row and action plan are durable. */
export async function markRestoreQueued({ restoreId, jobId, now, totalSteps = undefined }) {
  const result = await throwing(
    `UPDATE va_restore SET state = 'QUEUING', job_id = ?, queued_at = ?, heartbeat_at = NULL,
       finished_at = NULL, last_error = NULL, total_steps = COALESCE(?, total_steps)
     WHERE restore_id = FROM_BASE64(?) AND state IN ('QUEUING', 'RESTORING', 'QUEUING_FAILED', 'FAILED', 'PARTIAL')`,
    [jobId, now, totalSteps ?? null, toBinaryParam(restoreId)]
  );
  if (!changed(result)) throw new Error('Restore queue state was not durable');
  return true;
}

/** A failed push is visible and retryable; it never erases the saved plan. */
export async function markRestoreQueueFailure({ restoreId, error, now }) {
  const result = await throwing(
    `UPDATE va_restore SET state = 'QUEUING_FAILED', last_error = ?, heartbeat_at = NULL
     WHERE restore_id = FROM_BASE64(?) AND state IN ('QUEUING', 'RESTORING', 'QUEUING_FAILED', 'FAILED', 'PARTIAL')`,
    [errorText(error), toBinaryParam(restoreId)]
  );
  return changed(result);
}

/** Claim one delivery. A recent RESTORING heartbeat makes duplicate delivery a no-op. */
export async function claimRestore({ restoreId, now, staleAfterMs = 60_000 }) {
  const result = await throwing(
    `UPDATE va_restore SET state = 'RESTORING', heartbeat_at = ?, last_error = NULL
     WHERE restore_id = FROM_BASE64(?)
       AND (state = 'QUEUING' OR (state = 'RESTORING' AND
            (heartbeat_at IS NULL OR heartbeat_at <= ?)))`,
    [now, toBinaryParam(restoreId), now - staleAfterMs]
  );
  return changed(result);
}

export async function heartbeatRestore({ restoreId, completedSteps, totalSteps, now }) {
  const result = await throwing(
    `UPDATE va_restore SET heartbeat_at = ?, completed_steps = ?, total_steps = ?, last_checkpoint = ?
     WHERE restore_id = FROM_BASE64(?) AND state = 'RESTORING'`,
    [now, completedSteps, totalSteps, now, toBinaryParam(restoreId)]
  );
  if (!changed(result)) throw new Error('Restore heartbeat was not durable');
  return true;
}

export const updateRestoreProgress = heartbeatRestore;
export const claimRestoreJob = claimRestore;

/** Reserve terminal verification so duplicate deliveries cannot verify twice. */
export async function beginRestoreVerification({ restoreId, now }) {
  const result = await throwing(
    `UPDATE va_restore SET state = 'VERIFYING', heartbeat_at = ?, last_checkpoint = ?
     WHERE restore_id = FROM_BASE64(?) AND state = 'RESTORING'`,
    [now, now, toBinaryParam(restoreId)]
  );
  return changed(result);
}

export async function finishQueuedRestore({ restoreId, now, counters, state, detail }) {
  const result = await throwing(
    `UPDATE va_restore SET finished_at = ?, attempted = ?, succeeded = ?, failed = ?,
       skipped = ?, irreversible = ?, state = ?, detail = ?, heartbeat_at = NULL,
       completed_steps = ?, last_checkpoint = ?, last_error = NULL
     WHERE restore_id = FROM_BASE64(?) AND state = 'VERIFYING'`,
    [now, counters.attempted, counters.succeeded, counters.failed, counters.skipped,
      counters.irreversible, state, JSON.stringify(detail ?? []), counters.completedSteps ?? counters.succeeded,
      now, toBinaryParam(restoreId)]
  );
  if (!changed(result)) throw new Error('Restore terminal state was not durable');
  return true;
}

export async function failRestore({ restoreId, error, now, state = 'FAILED' }) {
  const result = await throwing(
    `UPDATE va_restore SET state = ?, finished_at = ?, heartbeat_at = NULL, last_error = ?
     WHERE restore_id = FROM_BASE64(?) AND state NOT IN ('COMPLETE', 'COMPLETE_WITH_REPLACEMENTS', 'FAILED')`,
    [state, now, errorText(error), toBinaryParam(restoreId)]
  );
  return changed(result);
}

export const completeRestore = finishQueuedRestore;
export const markRestoreFailed = failRestore;

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

/**
 * The latest restore of ANOTHER work item that wrote to this one.
 *
 * A parent's restore puts each child back to the child's own record, under the
 * parent's signature, so restoresForIssue() — restores started FROM this item —
 * never finds it. One indexed read (idx_restore_action_issue); null when no
 * parent's restore has rewritten this item.
 */
export async function restoreReaching(issueId) {
  const rows = await throwing(
    `SELECT TO_BASE64(r.restore_id) AS restore_id, r.issue_id AS parent_issue_id, s.issue_key AS parent_issue_key,
            r.state, r.finished_at, r.baseline_version
     FROM va_restore_action a
     JOIN va_restore r ON r.restore_id = a.restore_id
     LEFT JOIN va_item_state s ON s.issue_id = r.issue_id
     WHERE a.issue_id = ? AND a.state = 'COMPLETE' AND r.issue_id <> a.issue_id
       AND a.kind IN ('RESTORE_FIELDS', 'RESTORE_LINKS', 'RESTORE_ATTACHMENTS', 'REPOINT_RICH_TEXT', 'MOVE_NODE')
     ORDER BY r.started_at DESC LIMIT 1`,
    [issueId]
  );
  return rows?.[0] ?? null;
}

/**
 * The latest restore of each item, in one read: Map(issueId -> row), for the
 * worklist. Only what it shows is selected — never the detail blob.
 */
export async function latestRestoresFor(issueIds) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const rows = await throwing(
    `SELECT TO_BASE64(restore_id) AS restore_id, issue_id, baseline_version, actor_account_id, state,
            started_at, finished_at
     FROM va_restore WHERE issue_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY started_at DESC LIMIT ${limitClause(ids.length * 20)}`,
    ids
  );
  const latest = new Map();
  for (const row of rows) {
    const issueId = Number(row.issue_id);
    if (!latest.has(issueId)) latest.set(issueId, { ...row, issue_id: issueId, restore_id: fromBinaryColumn(row.restore_id) });
  }
  return latest;
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
