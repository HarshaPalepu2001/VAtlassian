import * as store from './store.js';
import { executeQuery, affectedRows, toBinaryParam, fromBinaryColumn } from '../lib/db.js';
import { encodeValue } from '../lib/valuestore.js';
import { valueBatches } from './baselineStore.js';
import { controlledFieldsHash } from '../lib/baselinePolicy.js';
import { FailClosed } from '../lib/errors.js';
import { serialiseLinkPolicy } from '../lib/linkPolicy.js';

/**
 * Write a baseline for each child reached by a parent's capture.
 *
 * Decided 2026-09-24 (docs/specs/2026-09-24-child-baselines-design.md): when a
 * parent is baselined, every child its tree capture reaches gets an ordinary
 * single-issue baseline of its own, at the child's next version, over the
 * child's own project and issue type's Controlled Fields. From then on the
 * child has a baseline: the validator holds it on its own drift,
 * the single-issue collector measures it, and its own panel decides it.
 *
 * Use the parent's authentication. The parent's signature binds the tree
 * hash, which covers each child's content hash exactly as recorded here, so
 * each row carries the parent's approval, signer and control policy, and
 * `captured_by_baseline_id` names the parent baseline it came from.
 *
 * Use the same ordering as other captures. Write rows as CAPTURING, publish only
 * after the parent's tree is published, and every step can be repeated: a
 * retry clears this parent's unpublished rows before writing them again, and
 * publication activates whatever is still CAPTURING.
 */

const MAX_VERSION_ATTEMPTS = 3;

/**
 * One row per non-root node that tracks at least one field. Pure.
 * `nodeOf(issueId)` returns the node as read (for its scope); `nextVersion(issueId)`
 * the child's next version in its own lineage.
 */
export function planChildBaselines({ treePlan, rootIssueId, fieldsFor, nodeOf, parent, nextVersion }) {
  const rootId = Number(rootIssueId);
  return (treePlan?.nodes ?? [])
    .filter(node => Number(node.originalIssueId) !== rootId)
    .flatMap(node => {
      const issueId = Number(node.currentIssueId ?? node.originalIssueId);
      const source = nodeOf(issueId) ?? node;
      const own = fieldsFor(source) ?? [];
      // A child whose project and issue type track nothing has nothing to
      // record. It is still a node of the parent's structure.
      if (!own.length) return [];
      return [{
        issue_id: issueId,
        issue_key: node.issueKey,
        project_id: Number(node.projectId),
        issue_type_id: String(node.issueTypeId),
        summary: source?.fields?.summary ?? '',
        version: Number(nextVersion(issueId)),
        content_hash: node.contentHash,
        field_digests: node.fieldDigests,
        raw: treePlan.values?.[node.logicalNodeId] ?? {},
        field_count: own.length,
        captured_by_baseline_id: parent.baselineId,
        transition_id: parent.policy?.transition_id ?? null,
        from_status_id: parent.policy?.from_status_id ?? null,
        to_status_id: parent.policy?.to_status_id ?? null,
        required_role: parent.policy?.required_role ?? null,
        required_assurance: parent.policy?.required_assurance ?? null,
        controlled_fields_hash: controlledFieldsHash(own),
        approved_by: parent.accountId,
        approved_name: parent.displayName,
        assurance_level: parent.assuranceLevel,
        approval_id: parent.approvalId,
        transition_at: parent.transitionAt,
        captured_at: parent.capturedAt,
        fidelity: 'EXACT'
        ,...((node.linkPolicy ?? parent.linkPolicy) ? { link_policy: serialiseLinkPolicy(node.linkPolicy ?? parent.linkPolicy) } : {})
      }];
    });
}

/** issueId -> next version, for many issues in one read. */
export async function nextVersions(issueIds, query = store.throwing) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isFinite))];
  const current = new Map();
  if (ids.length) {
    const rows = await query(`SELECT issue_id, MAX(version) AS v FROM va_baseline
      WHERE issue_id IN (${ids.map(() => '?').join(', ')}) GROUP BY issue_id`, ids);
    for (const row of rows) current.set(Number(row.issue_id), Number(row.v ?? 0));
  }
  return issueId => (current.get(Number(issueId)) ?? 0) + 1;
}

async function clearUnpublished(parentBaselineId, query) {
  const parentId = toBinaryParam(parentBaselineId);
  const leftovers = await query(`SELECT issue_id, version FROM va_baseline
    WHERE captured_by_baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'`, [parentId]);
  for (const row of leftovers) {
    await query('DELETE FROM va_baseline_value WHERE issue_id = ? AND version = ?', [row.issue_id, row.version]);
  }
  if (leftovers.length) {
    await query(`DELETE FROM va_baseline WHERE captured_by_baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'`, [parentId]);
  }
}

async function insertRow(row, baselineId, valueBytes, query) {
  await query(
    `INSERT INTO va_baseline
     (baseline_id, issue_id, project_id, issue_type_id, version, state, content_hash,
      field_digests, transition_id, from_status_id, to_status_id, approved_by, approved_name,
      transition_at, captured_at, assurance_level, approval_id, fidelity, field_count, value_bytes,
      required_role, required_assurance, controlled_fields_hash, captured_by_baseline_id${row.link_policy ? ', link_policy' : ''})
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, 'CAPTURING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, FROM_BASE64(?)${row.link_policy ? ', ?' : ''})`,
    [
      toBinaryParam(baselineId), row.issue_id, row.project_id, row.issue_type_id, row.version,
      row.content_hash, row.field_digests, row.transition_id, row.from_status_id, row.to_status_id,
      row.approved_by, row.approved_name, row.transition_at, row.captured_at, row.assurance_level,
      row.approval_id ? toBinaryParam(row.approval_id) : null, row.fidelity, row.field_count, valueBytes,
      row.required_role, row.required_assurance, row.controlled_fields_hash,
      toBinaryParam(row.captured_by_baseline_id),
      ...(row.link_policy ? [serialiseLinkPolicy(row.link_policy)] : [])
    ]
  );
}

/**
 * Write every child row CAPTURING, with its retained values. Returns the rows
 * as written, each with its `baseline_id` and final `version`: a child whose
 * next version was taken meanwhile (its own capture racing this one) moves to
 * the version after, the same bounded retry as every other capture.
 */
export async function writeChildBaselines({ rows, parentBaselineId, query = store.throwing,
  isDuplicateKey = store.isDuplicateKey, newId = store.newId }) {
  if (!rows?.length) return [];
  await clearUnpublished(parentBaselineId ?? rows[0].captured_by_baseline_id, query);
  const written = [];
  for (const row of rows) {
    const valueRows = [];
    let valueBytes = 0;
    const encoded = Object.entries(row.raw ?? {}).map(([fieldId, rawValue]) => [fieldId, encodeValue(rawValue)]);
    for (const [, { rawBytes }] of encoded) valueBytes += rawBytes;
    const baselineId = newId();
    let version = Number(row.version);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await insertRow({ ...row, version }, baselineId, valueBytes, query);
        break;
      } catch (error) {
        if (!isDuplicateKey(error) || attempt >= MAX_VERSION_ATTEMPTS) throw error;
        const rowsNow = await query('SELECT MAX(version) AS v FROM va_baseline WHERE issue_id = ?', [row.issue_id]);
        version = Number(rowsNow?.[0]?.v ?? 0) + 1;
      }
    }
    // This version is now ours. Anything already stored under it is an
    // orphan of an earlier crashed attempt, never part of this record.
    await query('DELETE FROM va_baseline_value WHERE issue_id = ? AND version = ?', [row.issue_id, version]);
    for (const [fieldId, { encoding, rawBytes, chunks }] of encoded) {
      chunks.forEach((chunk, seq) => valueRows.push([row.issue_id, version, fieldId, seq, encoding, rawBytes, chunk]));
    }
    for (const batch of valueBatches(valueRows)) {
      await query(`INSERT INTO va_baseline_value (issue_id, version, field_id, seq, encoding, raw_bytes, data)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')} ON DUPLICATE KEY UPDATE data = data`, batch.flat());
    }
    written.push({ ...row, version, baseline_id: baselineId, value_bytes: valueBytes });
  }
  return written;
}

/**
 * Publish this parent capture's child rows: activate every CAPTURING one whose
 * provenance is complete, then retire each child's older ACTIVE versions.
 * Safe to call again; returns the child baselines now ACTIVE from this parent.
 */
export async function publishChildBaselines({ parentBaselineId, requireEvidence = false, query = store.throwing, write = executeQuery }) {
  const parentId = toBinaryParam(parentBaselineId);
  // A capture that requires evidence must publish every child it wrote: a child
  // left CAPTURING without its evidence would otherwise be skipped silently by
  // the update below, and the capture would report a child baseline that is not
  // standing. Counted first, compared after.
  const capturing = requireEvidence
    ? Number((await query(`SELECT COUNT(*) AS n FROM va_baseline
        WHERE captured_by_baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'`, [parentId]))?.[0]?.n)
    : null;
  const activated = await write(
    `UPDATE va_baseline SET state = 'ACTIVE'
     WHERE captured_by_baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'
       AND required_role IS NOT NULL AND required_assurance IS NOT NULL
       AND controlled_fields_hash IS NOT NULL${requireEvidence ? ' AND policy_recorded = TRUE' : ''}`,
    [parentId]
  );
  if (!activated?.result) throw new FailClosed('CAPTURE_INCOMPLETE');
  if (requireEvidence && affectedRows(activated) !== capturing) throw new FailClosed('CAPTURE_INCOMPLETE');
  const published = await query(
    `SELECT TO_BASE64(b.baseline_id) AS baseline_id, b.issue_id, b.project_id, b.issue_type_id, b.version,
            b.content_hash, b.field_digests, b.captured_at, n.issue_key
     FROM va_baseline b
     LEFT JOIN va_baseline_node n ON n.baseline_id = b.captured_by_baseline_id AND n.current_issue_id = b.issue_id
     WHERE b.captured_by_baseline_id = FROM_BASE64(?) AND b.state = 'ACTIVE'`,
    [parentId]
  );
  for (let start = 0; start < published.length; start += 50) {
    const batch = published.slice(start, start + 50);
    await query(
      `UPDATE va_baseline SET state = 'SUPERSEDED'
       WHERE state = 'ACTIVE' AND (${batch.map(() => '(issue_id = ? AND version < ?)').join(' OR ')})`,
      batch.flatMap(row => [row.issue_id, row.version])
    );
  }
  return {
    published: affectedRows(activated),
    children: published.map(row => ({ ...row, baseline_id: fromBinaryColumn(row.baseline_id),
      issue_id: Number(row.issue_id), version: Number(row.version) }))
  };
}
