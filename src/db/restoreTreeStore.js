import * as store from './store.js';
import { toBinaryParam } from '../lib/db.js';

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
