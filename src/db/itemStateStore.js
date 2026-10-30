import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { throwing, isDuplicateKey } from './store.js';
import { REVIEW_STATE, LOCK_TTL_MS, RESTORE_LEASE_MS } from '../lib/interception.js';

/**
 * va_item_state holds one row per work item and supplies the reviewer queue.
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

/** Publish monotonically. Duplicate/older captures cannot clear newer drift,
 * and the CAS version never resets (which would let an old observer win). */
export async function upsertBaselined({
  issueId, issueKey, projectId, issueTypeId, summary,
  reviewerAccountId, reviewerName, baselineId, baselineVersion,
  contentHash, fieldDigests, lastChangelogId, now
}) {
  const args = [
    issueId, issueKey, projectId, issueTypeId, truncate(summary, 255),
    reviewerAccountId ?? null, reviewerName ?? null,
    REVIEW_STATE.BASELINED,
    toBinaryParam(baselineId), baselineVersion,
    contentHash, fieldDigests,
    now, lastChangelogId ?? null
  ];

  const existing = await throwing('SELECT baseline_version FROM va_item_state WHERE issue_id = ?', [issueId]);

  if (existing.length === 0) {
    try {
      await throwing(
        `INSERT INTO va_item_state
         (issue_id, issue_key, project_id, issue_type_id, summary, reviewer_account_id, reviewer_name,
          state, baseline_id, baseline_version, content_hash, field_digests,
          drift_count, drifted_field_count, max_materiality,
          last_drift_at, last_drift_by, last_checked_at, last_changelog_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?, 0)`,
        args
      );
      return;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // Fall through to update in case of race condition
    }
  }

  await throwing(
    `UPDATE va_item_state SET
     issue_key = ?, project_id = ?, issue_type_id = ?, summary = ?, reviewer_account_id = ?, reviewer_name = ?,
     state = ?, baseline_id = FROM_BASE64(?), baseline_version = ?, content_hash = ?, field_digests = ?,
     drift_count = 0, drifted_field_count = 0, max_materiality = NULL,
     last_drift_at = NULL, last_drift_by = NULL, last_checked_at = ?, last_changelog_id = ?,
     version = version + 1
     WHERE issue_id = ? AND (baseline_version IS NULL OR baseline_version <= ?)`,
    [
      issueKey, projectId, issueTypeId, truncate(summary, 255),
      reviewerAccountId ?? null, reviewerName ?? null,
      REVIEW_STATE.BASELINED,
      toBinaryParam(baselineId), baselineVersion,
      contentHash, fieldDigests,
      now, lastChangelogId ?? null,
      issueId, baselineVersion
    ]
  );
}

/**
 * Apply an observation's result. Compare-and-swap on `version`.
 *
 * @returns { updated: boolean } false means another writer got there first
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
 * Update the last-checked timestamp for NO_CHANGE events. Most
 * avi:jira:updated:issue events concern comments, worklogs or sprint moves.
 * Do not increment `version`: this update has no content for concurrent writers
 * to conflict with, and changing the CAS token could reject a substantive write.
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
 * effective: if two reviewers click Reject at once, only one wins.
 */
export async function acquire({ issueId, expectedVersion, state, allowedStates = null, now = Date.now(),
  staleOlderThan = LOCK_TTL_MS, restoreLeaseMs = RESTORE_LEASE_MS }) {
  const states = Array.isArray(allowedStates) && allowedStates.length ? allowedStates : null;
  let stateClause = '';
  const params = [state, now, issueId, expectedVersion];
  if (states) {
    stateClause = ` AND (state IN (${states.map(() => '?').join(', ')}) OR ${STALE_LOCK})`;
    params.push(...states, ...staleCutoffs(now, staleOlderThan, restoreLeaseMs));
  }
  const result = await executeQuery(
    `UPDATE va_item_state SET state = ?, last_checked_at = ?, version = version + 1
     WHERE issue_id = ? AND version = ?${stateClause}`,
    params
  );
  return { acquired: (affectedRows(result) ?? 0) === 1 };
}

/**
 * An operation lock past its lease (lib/interception.js lockLeaseMs): a
 * DECIDING row after a minute, a RESTORING row only after the restore lease.
 * Bind the two cutoffs in that order. See staleCutoffs().
 */
const STALE_LOCK = `((state = 'DECIDING' AND (last_checked_at IS NULL OR last_checked_at <= ?))
  OR (state = 'RESTORING' AND (last_checked_at IS NULL OR last_checked_at <= ?)))`;
const staleCutoffs = (now, decidingTtl = LOCK_TTL_MS, restoreLease = RESTORE_LEASE_MS) =>
  [now - decidingTtl, now - restoreLease];

/** Break abandoned locks past their lease and return them to the queue. */
export async function recoverStaleLocks(now = Date.now(), staleOlderThan = LOCK_TTL_MS, restoreLeaseMs = RESTORE_LEASE_MS) {
  const result = await executeQuery(
    `UPDATE va_item_state
     SET state = CASE WHEN drift_count > 0 THEN '${REVIEW_STATE.DRIFTED}' ELSE '${REVIEW_STATE.BASELINED}' END,
         last_checked_at = ?,
         version = version + 1
     WHERE ${STALE_LOCK}`,
    [now, ...staleCutoffs(now, staleOlderThan, restoreLeaseMs)]
  );
  return affectedRows(result) ?? 0;
}

/**
 * The restore worker's heartbeat on the work item's lock. Only a RESTORING row
 * is touched, so a lock already released or taken over is left alone, and the
 * CAS version is not bumped: this carries nothing a concurrent writer could
 * conflict with, exactly like touch().
 */
export async function refreshRestoreLock({ issueId, now = Date.now() }) {
  const result = await executeQuery(
    `UPDATE va_item_state SET last_checked_at = ? WHERE issue_id = ? AND state = '${REVIEW_STATE.RESTORING}'`,
    [now, issueId]
  );
  return (affectedRows(result) ?? 0) === 1;
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
 * Read the reviewer's worklist across authorized projects in one indexed query.
 * idx_review_reviewer covers (reviewer_account_id, state, last_drift_at).
 * Denormalized issue_key and summary let the caller render each row without
 * JQL or separate Jira issue reads.
 */
/**
 * Return drifted items in these projects regardless of assignment.
 *
 * A JQL search over controlled review statuses misses drift after approval,
 * when an issue has moved to In Progress, Done or another status. These items
 * remain in va_item_state with state DRIFTED and still require a decision.
 *
 * queueForReviewer() filters by reviewer_account_id, but authority belongs to
 * any holder of the required role for the project and issue type. Assignment
 * only routes work. Return project_id and issue_type_id so the caller can
 * check role authority without extra reads.
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

/**
 * Every item waiting on a decision in the projects a reviewer's grants cover:
 * changed since approval (DRIFTED), or a decision or restore that did not
 * finish (ERROR). Scoped by the reviewer's grants, not by which transitions
 * are controlled today. An item signed under a rule since removed is still
 * held by Jira until someone decides it. `siteWide` for a grant with no
 * project. Oldest first, so a cut at `limit` drops the newest, not the most
 * overdue. The caller checks the role each item's baseline froze.
 */
/**
 * `issue_id ASC` breaks ties on `last_drift_at` (plausible at millisecond
 * resolution for a bulk capture): without it, two rows sharing a timestamp
 * have no guaranteed relative order across separate query executions, which
 * a value-based (last_drift_at, issue_id) pagination cursor depends on.
 */
export async function awaitingDecision({ projectIds = [], siteWide = false, limit = 200 } = {}) {
  const ids = [...new Set((projectIds ?? []).map(Number).filter(Number.isFinite))];
  if (!siteWide && ids.length === 0) return [];
  const scope = siteWide ? '' : ` AND project_id IN (${ids.map(() => '?').join(', ')})`;
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE state IN ('${REVIEW_STATE.DRIFTED}', '${REVIEW_STATE.ERROR}')${scope}
     ORDER BY last_drift_at ASC, issue_id ASC LIMIT ${limitClause(limit)}`,
    siteWide ? [] : ids
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
 * The review page starts with JQL for actionable work in a controlled status,
 * then loads Baseline's state for each result. The
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
    `SELECT i.issue_id, i.issue_key, i.project_id, i.issue_type_id, i.summary,
            i.reviewer_account_id, i.reviewer_name, i.state,
            TO_BASE64(COALESCE(b.baseline_id, i.baseline_id)) AS baseline_id,
            COALESCE(b.version, i.baseline_version) AS baseline_version,
            i.content_hash, i.field_digests, i.drift_count, i.drifted_field_count, i.max_materiality,
            i.last_drift_at, i.last_drift_by, i.last_checked_at, i.last_changelog_id, i.version
     FROM va_item_state i
     LEFT JOIN va_baseline b ON b.issue_id = i.issue_id AND b.state = 'ACTIVE'
     WHERE i.issue_id IN (${placeholders}) LIMIT ${limitClause(ids.length)}`,
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
export async function dueForReconcile(limit = 50, now = Date.now(), staleOlderThan = LOCK_TTL_MS) {
  const rows = await throwing(
    `SELECT ${REVIEW_COLUMNS} FROM va_item_state
     WHERE state IN ('BASELINED', 'DRIFTED') OR ${STALE_LOCK}
     ORDER BY last_checked_at ASC LIMIT ${limitClause(limit)}`,
    staleCutoffs(now, staleOlderThan)
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

/**
 * Record that a work item now lives in another project or issue type.
 *
 * Conditional on the scope it was last seen in, so when several collectors
 * notice the same move at once exactly one wins. Only that winner
 * writes the audit entry (lib/scopeMove.js).
 */
export async function moveScope({ issueId, fromProjectId, fromIssueTypeId, toProjectId, toIssueTypeId }) {
  const result = await executeQuery(
    `UPDATE va_item_state SET project_id = ?, issue_type_id = ?, version = version + 1
     WHERE issue_id = ? AND project_id = ? AND issue_type_id = ?`,
    [toProjectId, String(toIssueTypeId), issueId, fromProjectId, String(fromIssueTypeId)]
  );
  return (affectedRows(result) ?? 0) === 1;
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

/**
 * Return tree roots due for a sweep, with one row per tree.
 *
 * The va_baseline_node join restricts va_item_state to roots of ACTIVE baselines
 * that have been captured, verified and published. The aggregate collector
 * checks each tree from its root, so descendant item-state rows are not
 * separate sweep targets.
 */
export async function dueTreeRoots(limit = 50, now = Date.now(), staleOlderThan = LOCK_TTL_MS) {
  const rows = await throwing(
    `SELECT i.issue_id, i.issue_key, i.state, TO_BASE64(i.baseline_id) AS baseline_id, i.baseline_version,
             i.last_checked_at, i.last_drift_at
     FROM va_item_state i
     JOIN va_baseline b ON b.baseline_id = i.baseline_id
     JOIN va_baseline_node n ON n.baseline_id = b.baseline_id AND n.original_issue_id = i.issue_id AND n.parent_logical_node_id IS NULL
     WHERE b.state = 'ACTIVE' AND (
        i.state IN ('BASELINED', 'DRIFTED')
        OR (i.state = 'DECIDING' AND (i.last_checked_at IS NULL OR i.last_checked_at <= ?))
        OR (i.state = 'RESTORING' AND (i.last_checked_at IS NULL OR i.last_checked_at <= ?))
     )
     ORDER BY i.last_checked_at ASC LIMIT ${limitClause(limit)}`,
    staleCutoffs(now, staleOlderThan)
  );
  return rows.map(decode);
}
