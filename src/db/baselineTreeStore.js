import * as store from './store.js';
import { toBinaryParam, fromBinaryColumn } from '../lib/db.js';
import { encodeValue, decodeValue } from '../lib/valuestore.js';

export async function writeTreeCapture(baselineId, rootIssueId, rootIssueKey, treeHash, nodes, values, query = store.throwing) {
  const bId = toBinaryParam(baselineId);

  let totalFieldCount = 0;
  const edgeCount = nodes.filter(n => n.parentLogicalNodeId != null).length;
  const nodeCount = nodes.length;

  for (const node of nodes) {
    await query(
      `INSERT INTO va_baseline_node (
        baseline_id, logical_node_id, original_issue_id, current_issue_id, issue_key,
        parent_logical_node_id, project_id, issue_type_id, content_hash, field_digests, node_order
      ) VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bId, node.logicalNodeId, node.originalIssueId, node.currentIssueId, node.issueKey,
        node.parentLogicalNodeId || null, node.projectId, node.issueTypeId, node.contentHash,
        node.fieldDigests || '{}', node.nodeOrder || 0
      ]
    );

    const nodeValues = values[node.logicalNodeId] || {};
    for (const [fieldId, rawValue] of Object.entries(nodeValues)) {
      totalFieldCount++;
      const { encoding, rawBytes, chunks } = encodeValue(rawValue);
      for (let seq = 0; seq < chunks.length; seq++) {
        await query(
          `INSERT INTO va_baseline_node_value (baseline_id, logical_node_id, field_id, seq, encoding, raw_bytes, chunk)
           VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?)`,
          [bId, node.logicalNodeId, fieldId, seq, encoding, rawBytes, chunks[seq]]
        );
      }
    }
  }

  // Update va_baseline
  await query(
    `UPDATE va_baseline
     SET tree_hash = ?, node_count = ?, edge_count = ?, total_field_count = ?
     WHERE baseline_id = FROM_BASE64(?)`,
    [treeHash, nodeCount, edgeCount, totalFieldCount, bId]
  );
}

export async function readBaselineTree(baselineId, query = store.throwing) {
  const bId = toBinaryParam(baselineId);
  const dbNodes = await query(
    `SELECT logical_node_id AS logicalNodeId, original_issue_id AS originalIssueId,
            current_issue_id AS currentIssueId, issue_key AS issueKey,
            parent_logical_node_id AS parentLogicalNodeId, project_id AS projectId,
            issue_type_id AS issueTypeId, content_hash AS contentHash,
            field_digests AS fieldDigests, node_order AS nodeOrder
     FROM va_baseline_node
     WHERE baseline_id = FROM_BASE64(?)
     ORDER BY node_order ASC`,
    [bId]
  );

  const valueRows = await query(
    `SELECT logical_node_id, field_id, seq, encoding, raw_bytes, chunk AS data
     FROM va_baseline_node_value
     WHERE baseline_id = FROM_BASE64(?)
     ORDER BY logical_node_id, field_id, seq`,
    [bId]
  );

  const values = {};
  const chunksByField = {};

  for (const row of valueRows) {
    if (!chunksByField[row.logical_node_id]) chunksByField[row.logical_node_id] = {};
    if (!chunksByField[row.logical_node_id][row.field_id]) chunksByField[row.logical_node_id][row.field_id] = [];
    chunksByField[row.logical_node_id][row.field_id].push(row);
  }

  for (const [logicalNodeId, fields] of Object.entries(chunksByField)) {
    values[logicalNodeId] = {};
    for (const [fieldId, chunks] of Object.entries(fields)) {
      const decoded = decodeValue(chunks);
      if (decoded.present) {
        values[logicalNodeId][fieldId] = decoded.value;
      }
    }
  }

  return { nodes: dbNodes, values };
}

export async function activeRootsForNode(issueId, query = store.throwing) {
  const rows = await query(
    `SELECT TO_BASE64(b.baseline_id) AS baselineId,
            n.original_issue_id AS rootIssueId,
            n.issue_key AS rootIssueKey
     FROM va_baseline_node c
     JOIN va_baseline b ON b.baseline_id = c.baseline_id
     JOIN va_baseline_node n ON n.baseline_id = b.baseline_id AND n.parent_logical_node_id IS NULL
     WHERE c.current_issue_id = ? AND b.state = 'ACTIVE'`,
    [issueId]
  );
  return rows.map(r => ({
    baselineId: fromBinaryColumn(r.baselineId),
    rootIssueId: r.rootIssueId,
    rootIssueKey: r.rootIssueKey
  }));
}
