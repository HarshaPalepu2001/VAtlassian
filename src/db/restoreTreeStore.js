import * as store from './store.js';
import { toBinaryParam } from '../lib/db.js';

const ACTION_LEASE_MS = 60_000;

function changed(result) {
  return Number(result?.affectedRows ?? result?.data?.affectedRows ?? 0) > 0;
}

function encodeDetail(detail) {
  if (detail == null) return null;
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

export async function claimRestoreAction(restoreId, step, issue = {}, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  const now = Number(issue.now ?? Date.now());
  const params = [
    rId, step.stepKey, step.logicalNodeId, step.kind,
    issue.issueId ?? null, issue.issueKey ?? null, now
  ];
  try {
    const inserted = await query(
      `INSERT INTO va_restore_action (
        restore_id, step_key, logical_node_id, kind, issue_id, issue_key,
        state, attempts, started_at, finished_at, detail
      ) VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, 'RUNNING', 1, ?, NULL, NULL)`,
      params
    );
    return changed(inserted) || inserted == null;
  } catch (error) {
    if (!store.isDuplicateKey(error)) throw error;
  }

  const reclaimed = await query(
    `UPDATE va_restore_action
     SET state = 'RUNNING', attempts = attempts + 1, started_at = ?,
         finished_at = NULL, detail = NULL, issue_id = ?, issue_key = ?
     WHERE restore_id = FROM_BASE64(?) AND step_key = ?
       AND (state = 'FAILED' OR (state = 'RUNNING' AND started_at <= ?))`,
    [now, issue.issueId ?? null, issue.issueKey ?? null, rId, step.stepKey, now - ACTION_LEASE_MS]
  );
  return changed(reclaimed);
}

export async function finishRestoreAction(restoreId, stepKey, success, detail, options = {}, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  const result = await query(
    `UPDATE va_restore_action
     SET state = ?, finished_at = ?, detail = ?
     WHERE restore_id = FROM_BASE64(?) AND step_key = ? AND state = 'RUNNING'`,
    [success ? 'COMPLETE' : 'FAILED', Number(options.now ?? Date.now()), encodeDetail(detail), rId, stepKey]
  );
  return changed(result) || result == null;
}

export async function readRestoreActions(restoreId, query = store.throwing) {
  const rows = await query(
    `SELECT step_key AS stepKey, logical_node_id AS logicalNodeId, kind,
            issue_id AS issueId, issue_key AS issueKey, state, attempts,
            started_at AS startedAt, finished_at AS finishedAt, detail
     FROM va_restore_action
     WHERE restore_id = FROM_BASE64(?)
     ORDER BY started_at, step_key`,
    [toBinaryParam(restoreId)]
  );
  return rows.map(row => {
    let detail = row.detail;
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch { /* preserve Jira's plain-text detail */ }
    }
    return { ...row, attempts: Number(row.attempts ?? 0), detail };
  });
}

export async function claimRestoreStep(restoreId, logicalNodeId, issueId, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  await query(
    `INSERT INTO va_restore_step (restore_id, logical_node_id, issue_id, started_at)
     VALUES (FROM_BASE64(?), ?, ?, ?)`,
    [rId, logicalNodeId, issueId, Date.now()]
  );
}

export async function finishRestoreStep(restoreId, logicalNodeId, success, detail, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  const detailStr = detail ? JSON.stringify(detail) : null;
  await query(
    `UPDATE va_restore_step
     SET finished_at = ?, success = ?, detail = ?
     WHERE restore_id = FROM_BASE64(?) AND logical_node_id = ?`,
    [Date.now(), success ? 1 : 0, detailStr, rId, logicalNodeId]
  );
}

export async function recordReplacement(restoreId, logicalNodeId, oldIssueId, newIssueId, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  await query(
    `INSERT INTO va_restore_replacement (restore_id, logical_node_id, old_issue_id, new_issue_id, replaced_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?)`,
    [rId, logicalNodeId, oldIssueId, newIssueId, Date.now()]
  );
}

export async function readReplacements(restoreId, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  const rows = await query(
    `SELECT logical_node_id AS logicalNodeId, old_issue_id AS oldIssueId, new_issue_id AS newIssueId
     FROM va_restore_replacement
     WHERE restore_id = FROM_BASE64(?)`,
    [rId]
  );
  return rows.map(r => ({ logicalNodeId: r.logicalNodeId, oldIssueId: r.oldIssueId, newIssueId: r.newIssueId }));
}

export async function readRestoreSteps(restoreId, query = store.throwing) {
  const rId = toBinaryParam(restoreId);
  const rows = await query(
    `SELECT logical_node_id AS logicalNodeId, issue_id AS issueId, started_at AS startedAt, finished_at AS finishedAt, success, detail
     FROM va_restore_step
     WHERE restore_id = FROM_BASE64(?)`,
    [rId]
  );
  return rows.map(r => ({
    logicalNodeId: r.logicalNodeId,
    issueId: r.issueId,
    success: r.success === 1,
    finished: r.finishedAt !== null,
    detail: r.detail ? JSON.parse(r.detail) : null
  }));
}
