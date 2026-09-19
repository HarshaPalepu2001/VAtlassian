import * as store from './store.js';
import { executeQuery, affectedRows, toBinaryParam, fromBinaryColumn } from '../lib/db.js';
import { encodeValue, decodeValue } from '../lib/valuestore.js';
import { FailClosed } from '../lib/errors.js';

export async function beginTreeBaseline({ baseline, resume = null, query = store.throwing }) {
  if (resume) {
    if (resume.state !== 'CAPTURING') throw new FailClosed('CAPTURE_INCOMPLETE');
    // writeTreeCapture's inserts use `ON DUPLICATE KEY UPDATE chunk = chunk` —
    // a no-op, so it stays idempotent for a byte-identical replay of the same
    // row. A resumed capture instead replays from a fresh tree read, which can
    // legitimately differ from what an earlier, crashed attempt already wrote
    // (a field's chunk count shrank, a node dropped out). Clearing this
    // baseline's rows first means the replay always leaves exactly what the
    // current read says, never a mix of this attempt's rows and a prior
    // attempt's leftovers that happened to share a key.
    const bId = toBinaryParam(resume.baseline_id);
    await query('DELETE FROM va_baseline_node_value WHERE baseline_id = FROM_BASE64(?)', [bId]);
    await query('DELETE FROM va_baseline_node WHERE baseline_id = FROM_BASE64(?)', [bId]);
    return { baselineId: resume.baseline_id, version: Number(resume.version) };
  }

  const baselineId = store.newId();
  await query(
    `INSERT INTO va_baseline (
      baseline_id, issue_id, project_id, issue_type_id, version, state, content_hash,
      field_digests, transition_id, from_status_id, to_status_id, approved_by, approved_name,
      transition_at, captured_at, assurance_level, approval_id, fidelity, field_count, value_bytes,
      tree_hash, node_count, edge_count, total_field_count,
      required_role, required_assurance, controlled_fields_hash
    ) VALUES (
      FROM_BASE64(?), ?, ?, ?, ?, 'CAPTURING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_BASE64(?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
    [
      toBinaryParam(baselineId), baseline.issue_id, baseline.project_id,
      baseline.issue_type_id, baseline.version, baseline.content_hash,
      baseline.field_digests, baseline.transition_id, baseline.from_status_id,
      baseline.to_status_id, baseline.approved_by, baseline.approved_name,
      baseline.transition_at, baseline.captured_at, baseline.assurance_level,
      baseline.approval_id ? toBinaryParam(baseline.approval_id) : null, baseline.fidelity, baseline.field_count, 0,
      baseline.tree_hash, 0, 0, 0,
      baseline.required_role, baseline.required_assurance, baseline.controlled_fields_hash
    ]
  );
  return { baselineId, version: Number(baseline.version) };
}

// Multi-row batching, not one query per node/chunk. A 500-node tree with ten
// controlled fields each is 5,000+ rows; at one row per round trip (20-50ms
// each over the Forge SQL HTTPS gateway) that alone can approach the 25s
// Forge synchronous execution ceiling. Batches of 50 keep every statement
// well under typical payload limits while cutting round trips by ~50x.
const NODE_BATCH = 50;
const VALUE_BATCH = 50;

function chunked(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

export async function writeTreeCapture({ baselineId, treeHash, nodes, values, query = store.throwing }) {
  const bId = toBinaryParam(baselineId);

  let totalFieldCount = 0;
  let valueBytes = 0;
  const edgeCount = nodes.filter(n => n.parentLogicalNodeId != null).length;
  const nodeCount = nodes.length;

  for (const batch of chunked(nodes, NODE_BATCH)) {
    const placeholders = batch.map(() => '(FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const node of batch) {
      params.push(
        bId, node.logicalNodeId, node.originalIssueId, node.currentIssueId, node.issueKey,
        node.parentLogicalNodeId || null, node.projectId, node.issueTypeId, node.contentHash,
        node.fieldDigests || '{}', node.nodeOrder ?? 0
      );
    }
    await query(
      `INSERT INTO va_baseline_node (
        baseline_id, logical_node_id, original_issue_id, current_issue_id, issue_key,
        parent_logical_node_id, project_id, issue_type_id, content_hash, field_digests, node_order
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE logical_node_id = logical_node_id`,
      params
    );
  }

  const valueRows = [];
  for (const node of nodes) {
    const nodeValues = values[node.logicalNodeId] || {};
    for (const [fieldId, rawValue] of Object.entries(nodeValues)) {
      totalFieldCount++;
      const { encoding, rawBytes, chunks } = encodeValue(rawValue);
      valueBytes += rawBytes;
      for (let seq = 0; seq < chunks.length; seq++) {
        valueRows.push({ logicalNodeId: node.logicalNodeId, fieldId, seq, encoding, rawBytes, chunk: chunks[seq] });
      }
    }
  }
  for (const batch of chunked(valueRows, VALUE_BATCH)) {
    const placeholders = batch.map(() => '(FROM_BASE64(?), ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const row of batch) {
      params.push(bId, row.logicalNodeId, row.fieldId, row.seq, row.encoding, row.rawBytes, row.chunk);
    }
    await query(
      `INSERT INTO va_baseline_node_value (baseline_id, logical_node_id, field_id, seq, encoding, raw_bytes, chunk)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE chunk = chunk`,
      params
    );
  }

  // Update va_baseline
  await query(
    `UPDATE va_baseline
     SET tree_hash = ?, node_count = ?, edge_count = ?, total_field_count = ?, value_bytes = ?
     WHERE baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'`,
    [treeHash, nodeCount, edgeCount, totalFieldCount, valueBytes, bId]
  );
  return { baselineId, valueBytes };
}

export async function verifyTreeCapture({ baselineId, expectedNodeCount, expectedFieldCount,
  expectedTreeHash, query = store.throwing }) {
  const rows = await query(
    `SELECT b.state, b.tree_hash AS treeHash, b.node_count AS nodeCount,
            b.total_field_count AS totalFieldCount,
            COUNT(DISTINCT n.logical_node_id) AS storedNodeCount,
            COUNT(DISTINCT CONCAT(v.logical_node_id, CHAR(0), v.field_id)) AS storedFieldCount
     FROM va_baseline b
     LEFT JOIN va_baseline_node n ON n.baseline_id = b.baseline_id
     LEFT JOIN va_baseline_node_value v
       ON v.baseline_id = n.baseline_id AND v.logical_node_id = n.logical_node_id
     WHERE b.baseline_id = FROM_BASE64(?)
     GROUP BY b.state, b.tree_hash, b.node_count, b.total_field_count`,
    [toBinaryParam(baselineId)]
  );
  const row = rows[0];
  if (!row || row.state !== 'CAPTURING'
    || row.treeHash !== expectedTreeHash
    || Number(row.nodeCount) !== Number(expectedNodeCount)
    || Number(row.totalFieldCount) !== Number(expectedFieldCount)
    || Number(row.storedNodeCount) !== Number(expectedNodeCount)
    || Number(row.storedFieldCount) !== Number(expectedFieldCount)) {
    throw new FailClosed('CAPTURE_INCOMPLETE');
  }

  const fieldRows = await query(
    `SELECT logical_node_id AS logicalNodeId, field_id AS fieldId,
            MIN(seq) AS minSeq, MAX(seq) AS maxSeq, COUNT(*) AS chunkCount,
            COUNT(DISTINCT encoding) AS encodingCount,
            COUNT(DISTINCT raw_bytes) AS rawBytesCount
     FROM va_baseline_node_value
     WHERE baseline_id = FROM_BASE64(?)
     GROUP BY logical_node_id, field_id`,
    [toBinaryParam(baselineId)]
  );
  const completeFields = fieldRows.length === Number(expectedFieldCount)
    && fieldRows.every(field => Number(field.minSeq) === 0
      && Number(field.maxSeq) + 1 === Number(field.chunkCount)
      && Number(field.encodingCount) === 1
      && Number(field.rawBytesCount) === 1);
  if (!completeFields) throw new FailClosed('CAPTURE_INCOMPLETE');
  return true;
}

export async function publishTreeBaseline({ baselineId, issueId, version, query = store.throwing, write = executeQuery }) {
  // Provenance is re-checked at the row itself: a baseline without its frozen
  // control policy must never become the standing evidence.
  const activated = await write(
    `UPDATE va_baseline SET state = 'ACTIVE'
     WHERE baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'
       AND required_role IS NOT NULL AND required_assurance IS NOT NULL
       AND controlled_fields_hash IS NOT NULL`,
    [toBinaryParam(baselineId)]
  );
  if (!activated?.result || affectedRows(activated) !== 1) throw new FailClosed('CAPTURE_INCOMPLETE');

  await query(
    `UPDATE va_baseline SET state = 'SUPERSEDED'
     WHERE issue_id = ? AND version < ? AND state = 'ACTIVE'`,
    [issueId, version]
  );
  return true;
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

  const nodes = dbNodes.map(node => {
    if (node.fieldDigests == null) return node;
    Object.defineProperties(node, {
      parentLogicalId: { value: node.parentLogicalNodeId ?? null, enumerable: false },
      digests: { value: JSON.parse(node.fieldDigests), enumerable: false }
    });
    return node;
  });
  return { nodes, values };
}

/**
 * Every active baseline that covers this work item, with the provenance of the
 * approval that created it.
 *
 * ─── WHY THE PROVENANCE IS PART OF THE ANSWER ────────────────────────────────
 *
 * A tree baseline is ONE approval over a composite record: a single signature,
 * bound to a tree hash computed over every node. That is a sound model — it is
 * how a validation package or a batch record is approved, and it is stronger
 * than N independent signatures because the aggregate hash makes the scope
 * unambiguous and tamper-evident.
 *
 * It carries an obligation, though, and the app was not meeting it. An auditor
 * looking at a CHILD work item asks "who approved this, when, and to what
 * standard?" — and every surface answered "no baseline", because va_baseline
 * has a row for the root only. The signature covered the child; nothing could
 * show that it did. An approval nobody can trace from the record it governs is
 * an audit finding whatever the hash says.
 *
 * So this returns the approver, the moment, the assurance level and the version
 * along with the root, and panelAccess.snapshot() attaches it to any item that
 * has no baseline of its own. Children are not separately signed — they are
 * demonstrably covered, which is the thing that was missing.
 */
export async function activeRootsForNode(issueId, query = store.throwing) {
  const rows = await query(
    `SELECT TO_BASE64(b.baseline_id) AS baselineId,
            n.original_issue_id AS rootIssueId,
            n.issue_key AS rootIssueKey,
            b.version AS version,
            b.approved_by AS approvedBy,
            b.approved_name AS approvedName,
            b.captured_at AS capturedAt,
            b.transition_at AS transitionAt,
            b.assurance_level AS assuranceLevel,
            b.required_role AS requiredRole,
            b.tree_hash AS treeHash,
            c.content_hash AS nodeContentHash
     FROM va_baseline_node c
     JOIN va_baseline b ON b.baseline_id = c.baseline_id
     JOIN va_baseline_node n ON n.baseline_id = b.baseline_id AND n.parent_logical_node_id IS NULL
     WHERE c.current_issue_id = ? AND b.state = 'ACTIVE'`,
    [issueId]
  );
  return rows.map(r => ({
    baselineId: fromBinaryColumn(r.baselineId),
    rootIssueId: r.rootIssueId,
    rootIssueKey: r.rootIssueKey,
    version: r.version == null ? null : Number(r.version),
    approvedBy: r.approvedBy ?? null,
    approvedName: r.approvedName ?? null,
    capturedAt: r.capturedAt == null ? null : Number(r.capturedAt),
    transitionAt: r.transitionAt == null ? null : Number(r.transitionAt),
    assuranceLevel: r.assuranceLevel ?? null,
    requiredRole: r.requiredRole ?? null,
    treeHash: r.treeHash ?? null,
    nodeContentHash: r.nodeContentHash ?? null
  }));
}
