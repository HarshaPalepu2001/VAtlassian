import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { throwing } from './store.js';
import { REVIEW_STATE } from '../lib/interception.js';

/**
 * va_item_state — one row per work item. THIS IS THE REVIEWER QUEUE.
 *
 * Every mutation here is a compare-and-swap on `version`, because Forge SQL has
 * no transactions and two triggers firing for the same item concurrently is the
 * normal case, not the exotic one. A caller that loses the race gets
 * `{ updated: false }` and re-reads; it never silently discards its update, which
 * for a drift counter would mean under-reporting how much has changed.
 */

const REVIEW_COLUMNS = `
  issue_id, issue_key, project_id, issue_type_id, summary,
  reviewer_account_id, reviewer_name, state,
  TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  content_hash, field_digests, drift_count, drifted_field_count, max_materiality,
  last_drift_at, last_drift_by, last_checked_at, last_changelog_id, version
`;

function decode(row) {
  if (!row) return null;
  return { ...row, baseline_id: fromBinaryColumn(row.baseline_id) };
}

export async function getReview(issueId) {
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state WHERE issue_id = ?`,
    [issueId]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

/**
 * Create or replace the review row for a freshly captured baseline.
 *
 * REPLACE rather than INSERT ... ON DUPLICATE KEY UPDATE because the column
 * list is long and every column is being set anyway: a new baseline resets the
 * whole row by definition. The `version` restarts at 0, which is correct — the
 * CAS token guards concurrent updates WITHIN a baseline's life, and a new
 * baseline is a new life.
 */
export async function upsertBaselined({
  issueId, issueKey, projectId, issueTypeId, summary,
  reviewerAccountId, reviewerName, baselineId, baselineVersion,
  contentHash, fieldDigests, lastChangelogId, now
}) {
  await throwing(
    `REPLACE INTO va_item_state
     (issue_id, issue_key, project_id, issue_type_id, summary, reviewer_account_id, reviewer_name,
      state, baseline_id, baseline_version, content_hash, field_digests,
      drift_count, drifted_field_count, max_materiality,
      last_drift_at, last_drift_by, last_checked_at, last_changelog_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?, 0)`,
    [
      issueId, issueKey, projectId, issueTypeId, truncate(summary, 255),
      reviewerAccountId ?? null, reviewerName ?? null,
      REVIEW_STATE.BASELINED,
      toBinaryParam(baselineId), baselineVersion,
      contentHash, fieldDigests,
      now, lastChangelogId ?? null
    ]
  );
}

/**
 * Apply an observation's result. Compare-and-swap on `version`.
 *
 * @returns { updated: boolean } — false means another writer got there first
 *          and the caller should re-read and decide again. Never treat false as
 *          an error: it is the mechanism working.
 */
export async function applyObservation({ issueId, expectedVersion, review, counters }) {
  const result = await executeQuery(
    `UPDATE va_item_state SET
       state = ?, content_hash = ?, field_digests = ?,
       drift_count = ?, drifted_field_count = ?, max_materiality = ?,
       last_drift_at = ?, last_drift_by = ?, last_checked_at = ?, last_changelog_id = ?,
       version = version + 1
     WHERE issue_id = ? AND version = ?`,
    [
      review.state,
      review.content_hash ?? null,
      review.field_digests ?? null,
      counters?.driftCount ?? 0,
      counters?.driftedFieldCount ?? 0,
      counters?.maxMateriality ?? null,
      review.last_drift_at ?? null,
      review.last_drift_by ?? null,
      review.last_checked_at,
      review.last_changelog_id ?? null,
      issueId,
      expectedVersion
    ]
  );
  return { updated: (affectedRows(result) ?? 0) === 1 };
}

/**
 * Touch only the last-checked timestamp.
 *
 * The NO_CHANGE path, which is the overwhelmingly common one — most
 * avi:jira:updated:issue events are comments, worklogs and sprint moves. It
 * deliberately does NOT bump `version`: this write carries no information any
 * concurrent writer could conflict with, and bumping the CAS token would make
 * a housekeeping update able to defeat a real one.
 */
export async function touch(issueId, now, lastChangelogId = undefined) {
  if (lastChangelogId === undefined) {
    await executeQuery('UPDATE va_item_state SET last_checked_at = ? WHERE issue_id = ?', [now, issueId]);
  } else {
    await executeQuery(
      'UPDATE va_item_state SET last_checked_at = ?, last_changelog_id = ? WHERE issue_id = ?',
      [now, lastChangelogId, issueId]
    );
  }
}

/**
 * Move the row into a state that blocks concurrent work, and prove we did.
 *
 * This is the lock. DECIDING and RESTORING both mean "an operation is in
 * flight"; observe() returns BUSY for either, so the drift collector will not
 * record a restore's own writes as new drift. The CAS is what makes it a lock
 * rather than a flag — two reviewers clicking Reject at the same moment, one
 * wins.
 */
export async function acquire({ issueId, expectedVersion, state }) {
  const result = await executeQuery(
    `UPDATE va_item_state SET state = ?, version = version + 1
     WHERE issue_id = ? AND version = ?
       AND state NOT IN ('DECIDING', 'RESTORING')`,
    [state, issueId, expectedVersion]
  );
  return { acquired: (affectedRows(result) ?? 0) === 1 };
}

/** Release a lock into a settled state. Unconditional: we hold it. */
export async function release({ issueId, state, now, counters }) {
  await executeQuery(
    `UPDATE va_item_state SET state = ?, last_checked_at = ?,
       drift_count = ?, drifted_field_count = ?, max_materiality = ?,
       version = version + 1
     WHERE issue_id = ?`,
    [
      state, now,
      counters?.driftCount ?? 0,
      counters?.driftedFieldCount ?? 0,
      counters?.maxMateriality ?? null,
      issueId
    ]
  );
}

/**
 * A reviewer's worklist, across every project they hold authority in.
 *
 * ONE INDEXED READ. This is the query the whole product is judged on: if
 * "what do I have to review?" needs JQL and then an issue fetch per row, the
 * page is slow at exactly the scale where it matters. idx_review_reviewer is
 * (reviewer_account_id, state, last_drift_at), and issue_key and summary are
 * denormalised onto this table so nothing else has to be read to render a row.
 */
/**
 * EVERY DRIFTED ITEM IN THESE PROJECTS, whoever it was assigned to.
 *
 * THE GAP THIS CLOSES. The review page found its items with a JQL search over
 * gated review STATUSES — which can only ever surface work that is still
 * sitting in review. But drift is by definition something that happens AFTER
 * approval, once the item has moved on to In Progress, Done, or wherever the
 * team took it. Those rows sit here in va_item_state with state DRIFTED and are in
 * no review status at all, so the search could not see them. The one thing this
 * app exists to catch was the one thing its worklist could not show.
 *
 * BY PROJECT, NOT BY ASSIGNED REVIEWER, and that is the other half. Its sibling
 * queueForReviewer() filters on reviewer_account_id — who the item was routed
 * to. Authority here is held by ROLE: anybody holding the required role on that
 * project and issue type may rule on it, and routing is a convenience on top of
 * that. Filtering by assignment meant a reviewer holding the role saw nothing
 * unless the item had also been pointed at them personally.
 *
 * The caller filters the rows by role — project_id and issue_type_id are
 * returned for exactly that, so the check costs no extra reads.
 */
export async function driftedInProjects(projectIds, {
  states = [REVIEW_STATE.DRIFTED, REVIEW_STATE.ERROR], limit = 200
} = {}) {
  const ids = (projectIds ?? []).map(Number).filter(Number.isFinite);
  if (ids.length === 0 || states.length === 0) return [];

  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE project_id IN (${ids.map(() => '?').join(', ')})
       AND state IN (${states.map(() => '?').join(', ')})
     ORDER BY last_drift_at DESC LIMIT ${limitClause(limit)}`,
    [...ids, ...states]
  );
  return rows.map(decode);
}

export async function queueForReviewer(accountId, { states = [REVIEW_STATE.DRIFTED], limit = 100 } = {}) {
  const placeholders = states.map(() => '?').join(', ');
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE reviewer_account_id = ? AND state IN (${placeholders})
     ORDER BY last_drift_at DESC LIMIT ${limitClause(limit)}`,
    [accountId, ...states]
  );
  return rows.map(decode);
}

/**
 * Review rows for a set of work items, in one read.
 *
 * The review page starts from JQL — "what is sitting in a gated status that I
 * can act on" — and then needs whatever Baseline knows about each result. The
 * alternative is a query per row, which at forty items across nine projects is
 * forty round trips to decorate a list.
 *
 * Items with no row simply do not come back, and that absence is meaningful:
 * a work item in a gated status with nothing in va_item_state has never been
 * baselined, which is precisely the AWAITING_FIRST_APPROVAL population the old
 * queue could not see at all.
 */
export async function reviewsByIds(issueIds) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE issue_id IN (${placeholders}) LIMIT ${limitClause(ids.length)}`,
    ids
  );
  return rows.map(decode);
}

/** The same list for a project, for the admin console. */
export async function queueForProject(projectId, { states = [REVIEW_STATE.DRIFTED], limit = 100 } = {}) {
  const placeholders = states.map(() => '?').join(', ');
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE project_id = ? AND state IN (${placeholders})
     ORDER BY last_drift_at DESC LIMIT ${limitClause(limit)}`,
    [projectId, ...states]
  );
  return rows.map(decode);
}

/**
 * Items the reconcile job should re-examine, least-recently-checked first.
 *
 * Only baselined and drifted items are worth sweeping: an archived item has no
 * baseline to measure against, and
 * one that is DECIDING or RESTORING is mid-operation and must be left alone.
 */
export async function dueForReconcile(limit = 50) {
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE state IN ('BASELINED', 'DRIFTED')
     ORDER BY last_checked_at ASC LIMIT ${limitClause(limit)}`,
    []
  );
  return rows.map(decode);
}

/** Items whose drift has gone unreviewed past the digest threshold. */
export async function staleDrift(olderThanMs, limit = 200) {
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE state = 'DRIFTED' AND last_drift_at IS NOT NULL AND last_drift_at < ?
     ORDER BY last_drift_at ASC LIMIT ${limitClause(limit)}`,
    [olderThanMs]
  );
  return rows.map(decode);
}

/** Keep the denormalised header fresh. Cheap, and never worth failing over. */
export async function refreshHeader({ issueId, issueKey, summary, reviewerAccountId, reviewerName }) {
  await executeQuery(
    `UPDATE va_item_state SET issue_key = ?, summary = ?, reviewer_account_id = ?, reviewer_name = ?
     WHERE issue_id = ?`,
    [issueKey, truncate(summary, 255), reviewerAccountId ?? null, reviewerName ?? null, issueId]
  );
}

export async function archive(issueId, now) {
  await executeQuery(
    `UPDATE va_item_state SET state = ?, last_checked_at = ?, version = version + 1 WHERE issue_id = ?`,
    [REVIEW_STATE.ARCHIVED, now, issueId]
  );
}

function truncate(s, max) {
  if (s == null) return '';
  const str = String(s);
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}
