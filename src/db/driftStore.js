import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows, isUnknownColumn } from '../lib/db.js';
import { newId, throwing, isDuplicateKey } from './store.js';
import { observationOf } from '../lib/observation.js';

/**
 * va_drift is the append-only record of what changed after approval.
 *
 * `approval_id IS NULL` defines the review queue. There is no separate
 * queue table: a nullable column whose NULL is a WHERE clause cannot fall out
 * of step with the rows it describes, and a
 * second table would need every write to keep two things true at once without
 * transactions to make that safe.
 */

const LEGACY_DRIFT_COLUMNS = `
  TO_BASE64(drift_id) AS drift_id, issue_id, project_id,
  TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  field_id, field_name, from_digest, to_digest, from_repr, to_repr,
  actor_account_id, actor_name, occurred_at, changelog_id, detected_via, source,
  materiality, TO_BASE64(approval_id) AS approval_id
`;
// Written since v082/v096 (docs/specs/2026-10-03-baseline-evidence-model-design.md §7.1).
// Until those land on a site, reads fall back to the legacy list rather than
// failing every panel, hold and decision for the minutes after a deploy.
const DRIFT_COLUMNS = `${LEGACY_DRIFT_COLUMNS},
  observed_at, trigger_kind, trigger_account_id, edit_status, edited_at,
  TO_BASE64(decision_id) AS decision_id
`;

async function selectDrift(query, build, params) {
  try {
    return await query(build(DRIFT_COLUMNS), params);
  } catch (error) {
    if (!isUnknownColumn(error)) throw error;
    return query(build(LEGACY_DRIFT_COLUMNS), params);
  }
}

function toObservation(row) {
  if (!row) return null;
  return {
    ...row,
    drift_id: fromBinaryColumn(row.drift_id),
    baseline_id: fromBinaryColumn(row.baseline_id),
    approval_id: fromBinaryColumn(row.approval_id),
    decision_id: fromBinaryColumn(row.decision_id ?? null),
    // A stable string handle for the AI payload and the panel's citation chips.
    key: row.drift_id,
    observation: observationOf(row)
  };
}

const LEGACY_INSERT_COLUMNS = `drift_id, issue_id, project_id, baseline_id, baseline_version, field_id, field_name,
        from_digest, to_digest, from_repr, to_repr, actor_account_id, actor_name,
        occurred_at, changelog_id, detected_via, source, materiality, approval_id`;
const LEGACY_INSERT_VALUES = 'FROM_BASE64(?), ?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL';

/**
 * Record one observed change.
 *
 * idx_drift_dedupe makes inserts idempotent through a UNIQUE key on
 * (issue_id, changelog_id, field_id), so the event trigger and the hourly
 * reconcile can both try to insert the same change and exactly one wins. That
 * overlap is required. Reconcile covers what the events
 * dropped, so it also revisits entries the events handled, and
 * without the constraint the belt-and-braces design would double-count every
 * change it successfully caught twice, showing a reviewer "4 changes" for two
 * edits.
 *
 * A duplicate is therefore a SUCCESS, not an error, and is reported as such.
 */
export async function recordDrift(drift, query = throwing) {
  const driftId = newId();
  const legacy = [
    toBinaryParam(driftId), drift.issue_id, drift.project_id, toBinaryParam(drift.baseline_id),
    drift.baseline_version, drift.field_id, drift.field_name ?? drift.field_id,
    drift.from_digest ?? null, drift.to_digest ?? null,
    truncate(drift.from_repr, 512), truncate(drift.to_repr, 512),
    drift.actor_account_id ?? null, drift.actor_name ?? null, drift.occurred_at,
    drift.changelog_id ?? null, drift.detected_via ?? 'EVENT', drift.source ?? 'JIRA', drift.materiality
  ];
  const provenance = [drift.observed_at ?? null, drift.trigger_kind ?? null, drift.trigger_account_id ?? null,
    drift.edit_status ?? null, drift.edited_at ?? null];
  try {
    try {
      await query(
        `INSERT INTO va_drift (${LEGACY_INSERT_COLUMNS},
          observed_at, trigger_kind, trigger_account_id, edit_status, edited_at)
         VALUES (${LEGACY_INSERT_VALUES}, ?, ?, ?, ?, ?)`,
        [...legacy, ...provenance]
      );
    } catch (error) {
      // Before v082 lands on a site: the observation is still recorded.
      if (!isUnknownColumn(error)) throw error;
      await query(`INSERT INTO va_drift (${LEGACY_INSERT_COLUMNS}) VALUES (${LEGACY_INSERT_VALUES})`, legacy);
    }
    return { inserted: true, driftId };
  } catch (e) {
    if (isDuplicateKey(e)) return { inserted: false, duplicate: true };
    throw e;
  }
}

/**
 * VARCHAR(512) means 512 characters, and a value that overflows it fails the
 * whole INSERT and lose a drift record because of a long description. Truncated
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
  const rows = await selectDrift(throwing, columns =>
    `SELECT ${columns} FROM va_drift
     WHERE issue_id = ? AND baseline_version = ? ${clause}
     ORDER BY occurred_at ASC LIMIT ${limitClause(limit)}`,
    [issueId, baselineVersion]
  );
  return rows.map(toObservation);
}

/** One bounded read for the changed descendants in a root review. */
export async function driftForIssueVersions(pairs, query = throwing, limit = 2000) {
  const unique = new Map();
  for (const pair of pairs ?? []) {
    const issueId = Number(pair.issueId), version = Number(pair.version);
    if (!Number.isSafeInteger(issueId) || issueId <= 0 || !Number.isSafeInteger(version) || version <= 0) continue;
    unique.set(`${issueId}:${version}`, [issueId, version]);
  }
  if (!unique.size) return { rows: [], truncated: false };
  const selected = [...unique.values()];
  const clauses = selected.map(() => '(issue_id = ? AND baseline_version = ?)').join(' OR ');
  const rows = await selectDrift(query, columns =>
    `SELECT ${columns} FROM va_drift
     WHERE approval_id IS NULL AND (${clauses})
     ORDER BY occurred_at ASC LIMIT ${limitClause(limit + 1)}`,
    selected.flat()
  );
  return { rows: rows.slice(0, limit).map(toObservation), truncated: rows.length > limit };
}

/** Counts for the review row, computed in the database rather than in JS. */
export async function driftSummary(issueId, baselineVersion) {
  const rows = await throwing(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT field_id) AS fields,
            MAX(occurred_at) AS last_at
     FROM va_drift
     WHERE issue_id = ? AND baseline_version = ? AND approval_id IS NULL
       AND source <> 'BASELINE'`,
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
export async function markDecided({ issueId, baselineVersion, approvalId }, execute = executeQuery) {
  const result = await execute(
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
