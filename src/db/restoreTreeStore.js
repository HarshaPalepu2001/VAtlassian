import * as store from './store.js';
import { toBinaryParam } from '../lib/db.js';

export async function claimRestoreStep(restoreId, logicalNodeId, issueId) {
  const rId = toBinaryParam(restoreId);
  await store.throwing(
    `INSERT INTO va_restore_step (restore_id, logical_node_id, issue_id, started_at)
     VALUES (FROM_BASE64(?), ?, ?, ?)`,
    [rId, logicalNodeId, issueId, Date.now()]
  );
}

export async function finishRestoreStep(restoreId, logicalNodeId, success, detail) {
  const rId = toBinaryParam(restoreId);
  const detailStr = detail ? JSON.stringify(detail) : null;
  await store.throwing(
    `UPDATE va_restore_step
     SET finished_at = ?, success = ?, detail = ?
     WHERE restore_id = FROM_BASE64(?) AND logical_node_id = ?`,
    [Date.now(), success ? 1 : 0, detailStr, rId, logicalNodeId]
  );
}

export async function recordReplacement(restoreId, logicalNodeId, oldIssueId, newIssueId) {
  const rId = toBinaryParam(restoreId);
  await store.throwing(
    `INSERT INTO va_restore_replacement (restore_id, logical_node_id, old_issue_id, new_issue_id, replaced_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?)`,
    [rId, logicalNodeId, oldIssueId, newIssueId, Date.now()]
  );
}
