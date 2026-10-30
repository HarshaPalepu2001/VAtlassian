import { randomBytes } from 'crypto';
import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause } from '../lib/db.js';

/**
 * Implement the audit store contract used by lib/ledger.js append/verifyChain
 * with va_audit. Keep the six methods and semantics aligned with
 * test/fake-store.js FakeStore.
 *
 * Throw on failure instead of returning executeQuery's { result: false }.
 * append catches duplicate-key errors and retries to serialize concurrent
 * appends. Swallowing those errors would break that concurrency protection.
 */

/** A fresh BINARY(16) id for event_id / baseline_id / decision_id / etc. */
export function newId() {
  return randomBytes(16);
}

/**
 * Convert BINARY(16) IDs to base64 before returning them to Custom UI.
 * A Buffer crosses invoke as { type: 'Buffer', data: [ ... ] }, which cannot
 * serve as a React key or round-trip ID and renders as "[object Object]".
 *
 * This shared helper replaces a private resolvers/admin.js helper that other
 * callers missed. Previously recordFirstApprovalOnly() returned raw
 * randomBytes(16) as decisionId, leaving the transition receipt unusable.
 * Accept either a row or a bare Buffer.
 */
export function serialiseIds(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value == null || typeof value !== 'object') return value;

  const out = { ...value };
  for (const [key, v] of Object.entries(value)) {
    if (Buffer.isBuffer(v)) out[key] = v.toString('base64');
  }
  return out;
}

/**
 * Forge SQL is MySQL-compatible, so a primary-key collision surfaces the way
 * the mysql2 driver reports it. Falls back to a message match in case the
 * wrapped error lacks `.code`. This lets append retry a real duplicate instead
 * of treating it as fatal.
 */
export function isDuplicateKey(err) {
  const code = err?.code === 'ER_DUP_ENTRY' ? err.code : err?.context?.debug?.code;
  return code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(err?.message ?? '');
}

export async function throwing(queryText, params) {
  const result = await executeQuery(queryText, params);
  if (!result.result) throw result.error;
  return result.data ?? [];
}

// event_id / approval_id are BINARY(16). Every read asks for TO_BASE64(...)
// explicitly and decodes back to a Buffer here, rather than leaving `SELECT *`
// to hand back whatever implicit string form Forge SQL uses for a binary column.
//
// This is not cosmetic: verifyChain recomputes entryHash({ ..., approvalId:
// row.approval_id, ... }) from rows read back off this store and compares it
// against the hash written at append() time, computed from the ORIGINAL Buffer.
// If a read handed back a base64 string instead of that Buffer, every row with
// a non-null approval_id would falsely report as tampered.
const AUDIT_COLUMNS = `
  seq, TO_BASE64(event_id) AS event_id, occurred_at, actor_account_id, event_type,
  issue_id, TO_BASE64(approval_id) AS approval_id, payload, prev_hash, entry_hash,
  product, content_type, content_id, container_id, baseline_subject_identity
`;

function decodeAuditRow(row) {
  if (!row) return row;
  return { ...row, event_id: fromBinaryColumn(row.event_id), approval_id: fromBinaryColumn(row.approval_id) };
}

export async function readTail() {
  const rows = await throwing(`SELECT ${AUDIT_COLUMNS} FROM va_audit ORDER BY seq DESC LIMIT 1`);
  return rows.length > 0 ? decodeAuditRow(rows[0]) : null;
}

export async function insertEntry(row) {
  await throwing(
    `INSERT INTO va_audit
     (seq, event_id, occurred_at, actor_account_id, event_type, issue_id, approval_id, payload, prev_hash, entry_hash, product, content_type, content_id, container_id, baseline_subject_identity)
     VALUES (?, FROM_BASE64(?), ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.seq,
      toBinaryParam(row.event_id),
      row.occurred_at,
      row.actor_account_id,
      row.event_type,
      row.issue_id ?? null,
      row.approval_id != null ? toBinaryParam(row.approval_id) : null,
      row.payload,
      row.prev_hash,
      row.entry_hash,
      row.product ?? null,
      row.content_type ?? null,
      row.content_id ?? null,
      row.container_id ?? null,
      row.baseline_subject_identity ?? null
    ]
  );
}

export async function entryAt(seq) {
  const rows = await throwing(`SELECT ${AUDIT_COLUMNS} FROM va_audit WHERE seq = ?`, [seq]);
  return rows.length > 0 ? decodeAuditRow(rows[0]) : null;
}

export async function entryHashAt(seq) {
  const rows = await throwing('SELECT entry_hash FROM va_audit WHERE seq = ?', [seq]);
  return rows.length > 0 ? rows[0].entry_hash : null;
}

export async function readRange(fromSeq, limit) {
  // LIMIT is inlined via limitClause, not bound because Forge SQL rejects a
  // placeholder there outright (ER_WRONG_ARGUMENTS). See lib/db.js.
  const rows = await throwing(
    `SELECT ${AUDIT_COLUMNS} FROM va_audit WHERE seq >= ? ORDER BY seq ASC LIMIT ${limitClause(limit)}`,
    [fromSeq]
  );
  return rows.map(decodeAuditRow);
}

/** Every ledger entry for one work item, in chain order. Uses idx_audit_issue. */
export async function readForIssue(issueId, limit = 200) {
  const rows = await throwing(
    `SELECT ${AUDIT_COLUMNS} FROM va_audit WHERE issue_id = ? ORDER BY seq DESC LIMIT ${limitClause(limit)}`,
    [issueId]
  );
  return rows.map(decodeAuditRow);
}

/**
 * Bundled to the exact shape lib/ledger.js expects as its `store` argument, so
 * a resolver just does `append(auditStore, event)`.
 */
export const auditStore = { readTail, insertEntry, entryAt, entryHashAt, readRange, isDuplicateKey };

/**
 * Best-effort audit append.
 *
 * Used on paths where the durable fact has ALREADY happened and refusing it
 * because the ledger is slow would turn a bookkeeping problem into a blocked
 * user. Never used where the append is the evidence authorizing an action. Those
 * paths use `append` directly and fail closed, per lib/ledger.js.
 */
export async function tryAppend(event, options) {
  const { append } = await import('../lib/ledger.js');
  try {
    return await append(auditStore, { eventId: newId(), ...event }, options);
  } catch (e) {
    console.error('audit: append failed (continuing)', event?.eventType, e);
    return null;
  }
}
