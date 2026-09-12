import * as store from './store.js';
import { toBinaryParam, fromBinaryColumn } from '../lib/db.js';

export async function replaceTreeDrift(baselineId, driftRows, query = store.throwing) {
  const bId = toBinaryParam(baselineId);

  await query(
    `DELETE FROM va_tree_drift WHERE baseline_id = FROM_BASE64(?)`,
    [bId]
  );

  for (const row of driftRows) {
    await query(
      `INSERT INTO va_tree_drift (
        baseline_id, logical_node_id, field_id, field_name,
        baseline_digest, current_digest, materiality, detected_at
      ) VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?)`,
      [
        bId, row.logicalNodeId, row.fieldId, row.fieldName || null,
        row.baselineDigest || null, row.currentDigest || null,
        row.materiality || null, row.detectedAt
      ]
    );
  }
}

export async function readTreeDrift(baselineId, query = store.throwing) {
  const bId = toBinaryParam(baselineId);
  const rows = await query(
    `SELECT logical_node_id AS logicalNodeId, field_id AS fieldId,
            field_name AS fieldName, baseline_digest AS baselineDigest,
            current_digest AS currentDigest, materiality, detected_at AS detectedAt
     FROM va_tree_drift
     WHERE baseline_id = FROM_BASE64(?)`,
    [bId]
  );
  return rows;
}
