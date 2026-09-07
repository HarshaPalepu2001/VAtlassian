import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { newId, throwing } from './store.js';
import { encodeValue, decodeValue } from '../lib/valuestore.js';

/**
 * va_baseline and va_baseline_value.
 *
 * The value store is written per field, one statement per chunk, because Forge
 * SQL permits one statement per call. That is a lot of round trips for a wide
 * issue, so the writes for independent fields are issued together with
 * Promise.all rather than awaited one after another — the same technique
 * gate.js uses to fit three queries into one round trip of latency. It is safe
 * here for the same reason: no chunk write reads anything another chunk write
 * produces.
 */

const BASELINE_COLUMNS = `
  TO_BASE64(baseline_id) AS baseline_id, issue_id, project_id, issue_type_id, version,
  state, content_hash, field_digests, transition_id, from_status_id, to_status_id,
  approved_by, approved_name, transition_at, captured_at,
  assurance_level, TO_BASE64(approval_id) AS approval_id,
  fidelity, field_count, value_bytes
`;

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    baseline_id: fromBinaryColumn(row.baseline_id),
    approval_id: fromBinaryColumn(row.approval_id)
  };
}

/** The standing baseline for a work item, or null if it has never cleared review. */
export async function activeBaseline(issueId) {
  const rows = await throwing(
    `SELECT ${BASELINE_COLUMNS} FROM va_baseline
     WHERE issue_id = ? AND state = 'ACTIVE'
     ORDER BY version DESC LIMIT 1`,
    [issueId]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

export async function baselineByVersion(issueId, version) {
  const rows = await throwing(
    `SELECT ${BASELINE_COLUMNS} FROM va_baseline WHERE issue_id = ? AND version = ?`,
    [issueId, version]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

/**
 * Has this decision already produced a baseline?
 *
 * THE IDEMPOTENCY GUARD a capture needs the moment it can be triggered from
 * more than one place for the same approval — see writeCapturedBaseline() in
 * lib/capture.js. A decision has one baseline in it; whichever caller gets
 * here first wins, and every caller after that has to be able to tell.
 */
export async function baselineForApproval(issueId, approvalId) {
  if (!approvalId) return null;
  const rows = await throwing(
    `SELECT ${BASELINE_COLUMNS} FROM va_baseline WHERE issue_id = ? AND approval_id = FROM_BASE64(?) LIMIT 1`,
    [issueId, toBinaryParam(approvalId)]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

export async function baselineHistory(issueId, limit = 20) {
  const rows = await throwing(
    `SELECT ${BASELINE_COLUMNS} FROM va_baseline WHERE issue_id = ?
     ORDER BY version DESC LIMIT ${limitClause(limit)}`,
    [issueId]
  );
  return rows.map(decode);
}

/** Highest version number so far. 0 when the item has never been baselined. */
export async function currentVersion(issueId) {
  const rows = await throwing(
    'SELECT MAX(version) AS v FROM va_baseline WHERE issue_id = ?',
    [issueId]
  );
  const v = rows[0]?.v;
  return Number(v ?? 0);
}

/**
 * Write a new baseline and its retained values.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Values are written FIRST, then the
 * va_baseline row, then the previous version is marked superseded. Forge SQL
 * has no transactions, so this sequence is chosen to make every possible
 * partial failure land somewhere safe:
 *
 *   crash after values, before baseline row
 *     → orphaned value rows nobody reads. The daily prune collects them. No
 *       reader can see a baseline that claims values it does not have.
 *
 *   crash after baseline row, before supersede
 *     → two rows briefly marked ACTIVE. `activeBaseline` orders by version DESC
 *       and takes one, so the newer wins and the older is corrected on the next
 *       capture or by the prune. Readers are never wrong, only untidy.
 *
 * The forbidden order is the reverse — superseding the old baseline before the
 * new one is durable would leave a window where an item has NO active baseline
 * and every field reads as un-approved.
 */
export async function writeBaseline({ baseline, values, raw, writable }) {
  const baselineId = newId();
  const now = baseline.captured_at;

  // 1. Values first. Retained fields only — `values`/`raw` are already filtered
  // by content.js's project(), which writes nothing for a field whose
  // store_values is false.
  let totalBytes = 0;
  const allRows = [];
  for (const [fieldId, rawValue] of Object.entries(raw ?? {})) {
    const { encoding, rawBytes, chunks } = encodeValue(rawValue);
    totalBytes += rawBytes;
    chunks.forEach((chunk, seq) => {
      allRows.push([baseline.issue_id, baseline.version, fieldId, seq, encoding, rawBytes, chunk]);
    });
  }
  
  // 2. The baseline row. Until this exists, nothing above is visible.
  await throwing(
    `INSERT INTO va_baseline
     (baseline_id, issue_id, project_id, issue_type_id, version, state, content_hash,
      field_digests, transition_id, from_status_id, to_status_id, approved_by, approved_name,
      transition_at, captured_at, assurance_level, approval_id, fidelity, field_count, value_bytes)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?)`,
    [
      toBinaryParam(baselineId),
      baseline.issue_id,
      baseline.project_id,
      baseline.issue_type_id,
      baseline.version,
      'CAPTURING',
      baseline.content_hash,
      baseline.field_digests,
      baseline.transition_id,
      baseline.from_status_id,
      baseline.to_status_id,
      baseline.approved_by,
      baseline.approved_name,
      baseline.transition_at,
      now,
      baseline.assurance_level,
      baseline.approval_id ? toBinaryParam(baseline.approval_id) : null,
      baseline.fidelity,
      baseline.field_count,
      totalBytes
    ]
  );

  const BATCH_SIZE = 5;
  for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = batch.flat();
    await throwing(
      `INSERT INTO va_baseline_value (issue_id, version, field_id, seq, encoding, raw_bytes, data)
       VALUES ${placeholders}`,
      params
    );
  }

  // Publish only after every chunk is durable. CAPTURING reserves the unique
  // issue/version and issue/approval keys so a second writer cannot mix values.
  await throwing("UPDATE va_baseline SET state = 'ACTIVE' WHERE baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'",
    [toBinaryParam(baselineId)]);

  // 3. Retire every earlier version. Scoped by `version <` rather than by id so
  // a crash between two captures still converges to exactly one ACTIVE row.
  await executeQuery(
    `UPDATE va_baseline SET state = 'SUPERSEDED'
     WHERE issue_id = ? AND version < ? AND state = 'ACTIVE'`,
    [baseline.issue_id, baseline.version]
  );

  // 4. Writability is advisory and belongs on the field definition, not on the
  // baseline: it describes the PROJECT's screen configuration, not this
  // particular approval. Best-effort — a failure here costs the admin console a
  // warning, not the customer a baseline.
  if (writable) {
    for (const [fieldId, canWrite] of Object.entries(writable)) {
      await executeQuery(
        `UPDATE va_controlled_field SET writable = ?
         WHERE project_id = ? AND issue_type_id = ? AND field_id = ?`,
        [canWrite ? 1 : 0, baseline.project_id, baseline.issue_type_id, fieldId]
      );
    }
  }

  return { baselineId, valueBytes: totalBytes };
}

/**
 * Read back one retained field value.
 *
 * Returns { present, value }. `present: false` means the field was never
 * retained — which the panel and the reject dialog must render as "contents not
 * retained", NEVER as an empty value. Those are completely different claims:
 * one says we chose not to store it, the other says the field was cleared.
 */
export async function readValue(issueId, version, fieldId) {
  const meta = await throwing(`SELECT seq FROM va_baseline_value
    WHERE issue_id = ? AND version = ? AND field_id = ? ORDER BY seq ASC`, [issueId, version, fieldId]);
  const chunks = [];
  for (const { seq } of meta) {
    const rows = await throwing(`SELECT seq, encoding, data FROM va_baseline_value
      WHERE issue_id = ? AND version = ? AND field_id = ? AND seq = ?`, [issueId, version, fieldId, seq]);
    if (!rows.length) throw new Error('BASELINE_VALUE_INCOMPLETE');
    chunks.push(rows[0]);
  }
  return decodeValue(chunks);
}

/** Every retained value for a baseline, as { fieldId: value }. */
export async function readAllValues(issueId, version) {
  const rows = await throwing(`SELECT DISTINCT field_id FROM va_baseline_value
    WHERE issue_id = ? AND version = ? ORDER BY field_id ASC`, [issueId, version]);
  const values = {};
  for (const { field_id } of rows) {
    const result = await readValue(issueId, version, field_id);
    if (result.present) values[field_id] = result.value;
  }
  return values;
}

/** Which fields have retained values for this baseline. Cheap; no decode. */
export async function retainedFieldIds(issueId, version) {
  const rows = await throwing(
    'SELECT DISTINCT field_id FROM va_baseline_value WHERE issue_id = ? AND version = ?',
    [issueId, version]
  );
  return rows.map((r) => r.field_id);
}


export async function pruneSupersededValues({ issueId, keepVersions = 2 }) {
  const rows = await throwing(
    `SELECT version FROM va_baseline WHERE issue_id = ?
     ORDER BY version DESC LIMIT ${limitClause(keepVersions)}`,
    [issueId]
  );
  if (rows.length === 0) return 0;
  const floor = rows[rows.length - 1].version;

  const result = await executeQuery(
    'DELETE FROM va_baseline_value WHERE issue_id = ? AND version < ?',
    [issueId, floor]
  );
  return affectedRows(result) ?? 0;
}
