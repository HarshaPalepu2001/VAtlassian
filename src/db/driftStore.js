import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { newId, throwing, isDuplicateKey } from './store.js';

/**
 * va_drift — the append-only record of what changed after approval.
 *
 * `approval_id IS NULL` IS THE REVIEW QUEUE. There is deliberately no separate
 * queue table: a nullable column whose NULL is a WHERE clause cannot fall out
 * of step with the rows it describes, and a
 * second table would need every write to keep two things true at once without
 * transactions to make that safe.
 */

export async function hasUnresolvedDrift(projectId) {
  const rows = await executeQuery(
    `SELECT 1 FROM va_drift WHERE project_id = ? AND approval_id IS NULL LIMIT 1`,
    [projectId]
  );
  return rows.result && rows.data.length > 0;
}

const DRIFT_COLUMNS = `
  TO_BASE64(drift_id) AS drift_id, issue_id, project_id,
  TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  field_id, field_name, from_digest, to_digest, from_repr, to_repr,
  actor_account_id, actor_name, occurred_at, changelog_id, detected_via, source,
  materiality, TO_BASE64(approval_id) AS approval_id
`;

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    drift_id: fromBinaryColumn(row.drift_id),
    baseline_id: fromBinaryColumn(row.baseline_id),
    approval_id: fromBinaryColumn(row.approval_id),
    // A stable string handle for the AI payload and for the panel's citation
    // chips. The model is given these and must cite them; anything it emits
    // that is not in this set is stripped. Base64 rather than hex only because
    // it is what the column already yields — no decode round trip on a path
    // that runs for every drift row on every panel open.
    key: row.drift_id
  };
}

/**
 * Record one observed change.
 *
 * IDEMPOTENT BY CONSTRUCTION. idx_drift_dedupe is UNIQUE on
 * (issue_id, changelog_id, field_id), so the event trigger and the hourly
 * reconcile can both try to insert the same change and exactly one wins. That
 * overlap is deliberate — the reconcile exists to cover what the events
 * dropped, which means it necessarily re-walks entries the events handled — and
 * without the constraint the belt-and-braces design would double-count every
 * change it successfully caught twice, showing a reviewer "4 changes" for two
 * edits.
 *
 * A duplicate is therefore a SUCCESS, not an error, and is reported as such.
 */
export async function recordDrift(drift) {
  const driftId = newId();
  try {
    await throwing(
      `INSERT INTO va_drift
       (drift_id, issue_id, project_id, baseline_id, baseline_version, field_id, field_name,
        from_digest, to_digest, from_repr, to_repr, actor_account_id, actor_name,
        occurred_at, changelog_id, detected_via, source, materiality, approval_id)
       VALUES (FROM_BASE64(?), ?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        toBinaryParam(driftId),
        drift.issue_id,
        drift.project_id,
        toBinaryParam(drift.baseline_id),
        drift.baseline_version,
        drift.field_id,
        drift.field_name ?? drift.field_id,
        drift.from_digest ?? null,
        drift.to_digest ?? null,
        truncate(drift.from_repr, 512),
        truncate(drift.to_repr, 512),
        drift.actor_account_id ?? null,
        drift.actor_name ?? null,
        drift.occurred_at,
        drift.changelog_id ?? null,
        drift.detected_via,
        drift.source,
        drift.materiality
      ]
    );
    return { inserted: true, driftId };
  } catch (e) {
    if (isDuplicateKey(e)) return { inserted: false, duplicate: true };
    throw e;
  }
}

/**
 * VARCHAR(512) means 512 characters, and a value that overflows it fails the
 * whole INSERT — losing a real drift record over a long description. Truncated
 * here rather than trusted to callers, with an ellipsis so the panel can tell a
 * cut string from a short one.
 */
function truncate(s, max) {
  if (s == null) return null;
  const str = String(s);
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

/** Every change to a work item since its current baseline, oldest first. */
export async function driftForIssue(issueId, baselineVersion, { undecidedOnly = false, limit = 500 } = {}) {
  const clause = undecidedOnly ? 'AND approval_id IS NULL' : '';
  const rows = await throwing(
    `SELECT ${DRIFT_COLUMNS} FROM va_drift
     WHERE issue_id = ? AND baseline_version = ? ${clause}
     ORDER BY occurred_at ASC LIMIT ${limitClause(limit)}`,
    [issueId, baselineVersion]
  );
  return rows.map(decode);
}

/** Counts for the review row, computed in the database rather than in JS. */
export async function driftSummary(issueId, baselineVersion) {
  const rows = await throwing(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT field_id) AS fields,
            MAX(occurred_at) AS last_at
     FROM va_drift
     WHERE issue_id = ? AND baseline_version = ? AND approval_id IS NULL
       AND materiality <> 'COSMETIC'`,
    [issueId, baselineVersion]
  );
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    fields: Number(r.fields ?? 0),
    lastAt: r.last_at ?? null
  };
}

/**
 * Attach a decision to every outstanding change, which is what removes them
 * from the queue.
 *
 * Scoped to `approval_id IS NULL` so a re-run cannot re-stamp changes that an
 * earlier decision already covered. That matters because approve and reject
 * both call this, and a retried decision must not silently claim credit for
 * drift somebody else already ruled on.
 */
export async function markDecided({ issueId, baselineVersion, approvalId }) {
  const result = await executeQuery(
    `UPDATE va_drift SET approval_id = FROM_BASE64(?)
     WHERE issue_id = ? AND baseline_version = ? AND approval_id IS NULL`,
    [toBinaryParam(approvalId), issueId, baselineVersion]
  );
  return affectedRows(result) ?? 0;
}

/**
 * Who has been changing approved work, across the site.
 *
 * Serves the one question the by-author index exists for and that no Jira
 * screen answers: not "what changed on this item" but "which people and which
 * automations are routinely editing work after it was signed off". A team that
 * discovers a rule quietly re-prioritising approved tickets learns more from
 * this one query than from a hundred individual diffs.
 */
export async function driftByAuthor({ projectId = null, sinceMs, limit = 50 }) {
  const scope = projectId == null ? '' : 'AND project_id = ?';
  const params = projectId == null ? [sinceMs] : [sinceMs, projectId];
  const rows = await throwing(
    `SELECT actor_account_id, actor_name, source,
            COUNT(*) AS changes, COUNT(DISTINCT issue_id) AS items,
            MAX(occurred_at) AS last_at
     FROM va_drift
     WHERE occurred_at >= ? ${scope} AND materiality <> 'COSMETIC'
     GROUP BY actor_account_id, actor_name, source
     ORDER BY changes DESC LIMIT ${limitClause(limit)}`,
    params
  );
  return rows;
}

/** Drift rows for the reconcile job's dedupe check, as a Set of composite keys. */
export async function existingChangelogKeys(issueId, baselineVersion) {
  const rows = await throwing(
    `SELECT changelog_id, field_id FROM va_drift
     WHERE issue_id = ? AND baseline_version = ? AND changelog_id IS NOT NULL`,
    [issueId, baselineVersion]
  );
  return new Set(rows.map((r) => `${r.changelog_id}:${r.field_id}`));
}

export async function purgeIssue(issueId) {
  await executeQuery('DELETE FROM va_drift WHERE issue_id = ?', [issueId]);
}
