import * as store from './store.js';
import { toBinaryParam, fromBinaryColumn, isUnknownColumn } from '../lib/db.js';
import { FailClosed } from '../lib/errors.js';

/**
 * THE EVIDENCE ROWS OF A BASELINE VERSION
 * (docs/specs/2026-10-03-baseline-evidence-model-design.md §4).
 *
 * Written while the version is CAPTURING, before it publishes: a new capture's
 * publication requires `policy_recorded` (db/baselineStore.js and friends).
 * Rows are written once. A replay of the same capture writes the same rows,
 * and `ON DUPLICATE KEY UPDATE baseline_id = baseline_id` makes that a no-op.
 * Batched across versions: a parent capture writes every child's evidence in a
 * few statements, not a few per child (the 25s ceiling, as in baselineTreeStore).
 */
const BATCH = 50;
const chunks = (rows, size = BATCH) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};
const bin = id => toBinaryParam(Buffer.from(id));
const binOrNull = id => (id == null ? null : bin(id));
const flag = value => (value == null ? null : (value ? 1 : 0));

/** The migration has not run on this site yet (deploy to five-minute job). */
export function isMissingSchema(error) {
  if (isUnknownColumn(error)) return true;
  // Either place the driver code can survive the wrapper (as isUnknownColumn does),
  // so a different top-level code does not hide the nested one. Without a code,
  // only MySQL/TiDB's own missing-table text counts: any other "does not exist"
  // is a real failure, and must not wait out a migration that is not coming.
  return error?.code === 'ER_NO_SUCH_TABLE' || error?.context?.debug?.code === 'ER_NO_SUCH_TABLE'
    || /Table '[^']*' doesn't exist/i.test(error?.message ?? '');
}

const TABLES = {
  va_baseline_field: ['baseline_id', 'field_id', 'label', 'label_source', 'kind', 'schema_type', 'materiality',
    'store_values', 'restorable', 'digest', 'required_by'],
  va_baseline_rule: ['baseline_id', 'rule_key', 'source', 'project_id', 'issue_type_id', 'transition_id', 'approvers',
    'controlled_fields_hash', 'imposed_by_baseline_id', 'imposed_by_version'],
  va_baseline_signature: ['baseline_id', 'approval_id', 'signer_account_id', 'signer_name', 'role', 'assurance', 'cause',
    'cause_baseline_id', 'decision_id', 'transition_id', 'from_status_id', 'to_status_id', 'transition_at',
    'status_at_capture', 'fields_covered', 'signed_at'],
  va_baseline_link: ['baseline_id', 'link_id', 'link_type', 'direction', 'other_issue_id', 'other_issue_key',
    'other_baseline_id', 'other_baseline_version']
};
const BINARY = new Set(['baseline_id', 'imposed_by_baseline_id', 'approval_id', 'cause_baseline_id', 'decision_id',
  'other_baseline_id']);
const FLAGS = new Set(['store_values', 'restorable']);

async function insertRows(query, table, rows) {
  const columns = TABLES[table];
  const one = `(${columns.map(c => (BINARY.has(c) ? 'FROM_BASE64(?)' : '?')).join(', ')})`;
  for (const batch of chunks(rows)) {
    await query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${batch.map(() => one).join(', ')}
       ON DUPLICATE KEY UPDATE baseline_id = baseline_id`,
      batch.flatMap(row => columns.map(c => (BINARY.has(c) ? binOrNull(row[c]) : FLAGS.has(c) ? flag(row[c]) : row[c] ?? null)))
    );
  }
}

export async function writeVersionEvidence({ entries, query = store.throwing }) {
  if (!entries?.length) return { written: 0 };
  const tagged = key => entries.flatMap(entry => (key === 'links' ? entry.links ?? [] : entry.evidence?.[key] ?? [])
    .map(row => ({ ...row, baseline_id: entry.baselineId })));
  try {
    await insertRows(query, 'va_baseline_field', tagged('fields'));
    await insertRows(query, 'va_baseline_rule', tagged('rules'));
    await insertRows(query, 'va_baseline_signature', tagged('signatures'));
    await insertRows(query, 'va_baseline_link', tagged('links'));
    const groups = new Map();
    for (const entry of entries) {
      const recorded = (entry.evidence?.fields?.length ?? 0) > 0 && (entry.evidence?.rules?.length ?? 0) > 0;
      const key = `${entry.cause}|${recorded}`;
      if (!groups.has(key)) groups.set(key, { cause: entry.cause, recorded, ids: [] });
      groups.get(key).ids.push(entry.baselineId);
    }
    for (const { cause, recorded, ids } of groups.values()) {
      for (const batch of chunks(ids)) {
        const list = batch.map(() => 'FROM_BASE64(?)').join(', ');
        const params = [cause, recorded ? 1 : 0, ...batch.map(bin)];
        await query(`UPDATE va_baseline SET cause = ?, policy_recorded = ?
          WHERE state = 'CAPTURING' AND baseline_id IN (${list})`, params);
        // Counted rather than read from affectedRows: a replay that sets the
        // same values changes no rows, and must not read as a failure.
        const [counted] = await query(`SELECT COUNT(*) AS n FROM va_baseline
          WHERE cause = ? AND policy_recorded = ? AND state = 'CAPTURING' AND baseline_id IN (${list})`, params);
        if (Number(counted?.n) !== batch.length) throw new FailClosed('CAPTURE_INCOMPLETE');
      }
    }
  } catch (error) {
    if (isMissingSchema(error)) throw new FailClosed('SCHEMA_PENDING', error);
    throw error;
  }
  return { written: entries.length };
}

/**
 * A RESUMED VERSION STARTS ITS EVIDENCE AGAIN. A replay's insert of a key the
 * crashed attempt already wrote is a no-op (above), and a row the replay no
 * longer produces (a link removed meanwhile) would stay, so the version would
 * publish with a mix of two attempts. Its rows are cleared first. Only a
 * version still CAPTURING is ever cleared: a published version's evidence is
 * the record itself.
 */
export async function clearVersionEvidence({ baselineId, query = store.throwing }) {
  const id = bin(baselineId);
  try {
    const rows = await query('SELECT state FROM va_baseline WHERE baseline_id = FROM_BASE64(?)', [id]);
    if (rows?.[0]?.state !== 'CAPTURING') throw new FailClosed('CAPTURE_INCOMPLETE');
    for (const table of Object.keys(TABLES)) {
      await query(`DELETE FROM ${table} WHERE baseline_id = FROM_BASE64(?)`, [id]);
    }
  } catch (error) {
    if (isMissingSchema(error)) throw new FailClosed('SCHEMA_PENDING', error);
    throw error;
  }
}

const parse = text => (typeof text === 'string' ? JSON.parse(text) : text ?? null);
const asBool = value => (value == null ? null : value === true || value === 1 || value === '1');
const asNumber = value => (value == null ? null : Number(value));

export async function readVersionEvidence(baselineId, query = store.throwing) {
  const id = bin(baselineId);
  try {
    const [fields, rules, signatures, links] = await Promise.all([
      query(`SELECT field_id, label, label_source, kind, schema_type, materiality, store_values, restorable, digest, required_by
        FROM va_baseline_field WHERE baseline_id = FROM_BASE64(?) ORDER BY field_id`, [id]),
      query(`SELECT rule_key, source, project_id, issue_type_id, transition_id, approvers, controlled_fields_hash,
        TO_BASE64(imposed_by_baseline_id) AS imposed_by_baseline_id, imposed_by_version
        FROM va_baseline_rule WHERE baseline_id = FROM_BASE64(?) ORDER BY rule_key`, [id]),
      query(`SELECT TO_BASE64(approval_id) AS approval_id, signer_account_id, signer_name, role, assurance, cause,
        TO_BASE64(cause_baseline_id) AS cause_baseline_id, TO_BASE64(decision_id) AS decision_id, transition_id,
        from_status_id, to_status_id, transition_at, status_at_capture, fields_covered, signed_at
        FROM va_baseline_signature WHERE baseline_id = FROM_BASE64(?) ORDER BY signed_at, approval_id`, [id]),
      query(`SELECT link_id, link_type, direction, other_issue_id, other_issue_key,
        TO_BASE64(other_baseline_id) AS other_baseline_id, other_baseline_version
        FROM va_baseline_link WHERE baseline_id = FROM_BASE64(?) ORDER BY link_id`, [id])
    ]);
    return {
      fields: fields.map(row => ({ ...row, store_values: asBool(row.store_values) === true,
        restorable: asBool(row.restorable), required_by: parse(row.required_by) })),
      rules: rules.map(row => ({ ...row, project_id: Number(row.project_id), approvers: parse(row.approvers),
        imposed_by_baseline_id: fromBinaryColumn(row.imposed_by_baseline_id ?? null),
        imposed_by_version: asNumber(row.imposed_by_version) })),
      signatures: signatures.map(row => ({ ...row, approval_id: fromBinaryColumn(row.approval_id),
        cause_baseline_id: fromBinaryColumn(row.cause_baseline_id ?? null),
        decision_id: fromBinaryColumn(row.decision_id ?? null), transition_at: asNumber(row.transition_at),
        fields_covered: parse(row.fields_covered), signed_at: Number(row.signed_at) })),
      links: links.map(row => ({ ...row, other_issue_id: Number(row.other_issue_id),
        other_baseline_id: fromBinaryColumn(row.other_baseline_id ?? null),
        other_baseline_version: asNumber(row.other_baseline_version) }))
    };
  } catch (error) {
    if (isMissingSchema(error)) throw new FailClosed('SCHEMA_PENDING', error);
    throw error;
  }
}

// Node columns, batched as CASE updates (the same pattern as baselineStore's
// writability update). Written out per column so each statement reads on its own.
export async function pinChildVersions({ parentBaselineId, pins, query = store.throwing }) {
  for (const batch of chunks(pins ?? [])) {
    const ids = batch.map(pin => Number(pin.issueId));
    await query(
      `UPDATE va_baseline_node
       SET child_baseline_id = CASE current_issue_id ${batch.map(() => 'WHEN ? THEN FROM_BASE64(?)').join(' ')} END,
           child_version = CASE current_issue_id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END
       WHERE baseline_id = FROM_BASE64(?) AND current_issue_id IN (${ids.map(() => '?').join(', ')})`,
      [...batch.flatMap(pin => [Number(pin.issueId), bin(pin.baselineId)]),
        ...batch.flatMap(pin => [Number(pin.issueId), Number(pin.version)]),
        bin(parentBaselineId), ...ids]
    );
  }
}

export async function recordNodeSecurity({ baselineId, levels, query = store.throwing }) {
  // A node with no security level keeps a NULL column: skipped, never stored as the text "null".
  for (const batch of chunks((levels ?? []).filter(level => level.securityLevelId != null))) {
    const ids = batch.map(level => Number(level.issueId));
    await query(
      `UPDATE va_baseline_node
       SET security_level_id = CASE current_issue_id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END
       WHERE baseline_id = FROM_BASE64(?) AND current_issue_id IN (${ids.map(() => '?').join(', ')})`,
      [...batch.flatMap(level => [Number(level.issueId), String(level.securityLevelId)]), bin(baselineId), ...ids]
    );
  }
}

/** A link record's children are copied from its source version: so are their pins. */
export async function copyNodePins({ fromBaselineId, toBaselineId, query = store.throwing }) {
  await query(
    `UPDATE va_baseline_node d JOIN va_baseline_node s ON s.baseline_id = FROM_BASE64(?) AND s.logical_node_id = d.logical_node_id
     SET d.child_baseline_id = s.child_baseline_id, d.child_version = s.child_version, d.security_level_id = s.security_level_id
     WHERE d.baseline_id = FROM_BASE64(?)`,
    [bin(fromBaselineId), bin(toBaselineId)]
  );
}
