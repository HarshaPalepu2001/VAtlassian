import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { APPROVAL_STATE, APPROVAL_TTL_MS, DECISION } from '../lib/approval/record.js';
export { APPROVAL_STATE, APPROVAL_TTL_MS, DECISION };

const columns = ['approval_id','issue_id','issue_key','project_id','issue_type_id','baseline_id','baseline_version',
  'decision','state','actor_account_id','account_id','actor_name','printed_name','decided_at','signed_at','created_at',
  'expires_at','consumed_at','from_status_id','to_status_id','transition_id','signer_role','meaning','content_hash',
  'covers_from_hash','covers_to_hash','drift_count','report_hash','note','assurance_level','provider_id',
  'provider_ref','provider_evidence','evidence_hash','decision_map','decision_map_hash'];
const binary = new Set(['approval_id','baseline_id']);
const selection = columns.map(key => binary.has(key) ? `TO_BASE64(${key}) AS ${key}` : key).join(', ');
const encode = value => value == null ? null : toBinaryParam(value);
const decode = row => row ? { ...row, approval_id: fromBinaryColumn(row.approval_id), baseline_id: fromBinaryColumn(row.baseline_id) } : null;
async function query(sql, params) {
  const result = await executeQuery(sql, params);
  if (!result.result) throw result.error ?? new Error('Approval storage unavailable');
  return result;
}

/** The single insert owner. A durable row starts unusable, even if audit fails. */
export async function recordApproval(row) {
  if (row.state !== APPROVAL_STATE.VOID) throw new TypeError('Approval must start VOID');
  await query(`INSERT INTO va_approval (${columns.join(', ')}) VALUES (${columns.map(key => binary.has(key) ? 'FROM_BASE64(?)' : '?').join(', ')})`,
    columns.map(key => binary.has(key) ? encode(row[key]) : row[key] ?? null));
  return row;
}
export async function activateApproval({ approvalId, now, state = APPROVAL_STATE.PENDING }) {
  if (![APPROVAL_STATE.PENDING, APPROVAL_STATE.CONSUMED].includes(state)) throw new TypeError('Invalid activation state');
  const result = await query(`UPDATE va_approval SET state = ?, consumed_at = ?
    WHERE approval_id = FROM_BASE64(?) AND state = 'VOID' AND expires_at > ?`,
  [state, state === 'CONSUMED' ? now : null, encode(approvalId), now]);
  return affectedRows(result) === 1;
}
export async function invalidateApproval({ approvalId }) {
  const result = await query(`UPDATE va_approval SET state = 'VOID', consumed_at = NULL
    WHERE approval_id = FROM_BASE64(?) AND state = 'PENDING'`, [encode(approvalId)]);
  return affectedRows(result) === 1;
}
/**
 * The PENDING approval recorded for this exact Jira transition — not just this
 * status pair. `transitionId` is required for the same reason it is required
 * on gatedTransition(): two sibling transitions can share a destination
 * status, and a receipt signed for one must never be usable to complete the
 * other. A caller with no exact transition id gets no candidate at all.
 */
export async function pendingApprovalFor({ issueId, fromStatusId, toStatusId, transitionId, now = Date.now(), approvalId }) {
  if (transitionId == null) return null;
  const params = [issueId, fromStatusId, toStatusId, String(transitionId), now];
  let idClause = '';
  if (approvalId) { idClause = ' AND approval_id = FROM_BASE64(?)'; params.push(encode(Buffer.isBuffer(approvalId) ? approvalId : Buffer.from(approvalId, 'hex'))); }
  const result = await query(`SELECT ${selection} FROM va_approval WHERE issue_id = ?
    AND state = 'PENDING' AND decision = 'APPROVE' AND from_status_id = ? AND to_status_id = ? AND transition_id = ? AND expires_at > ?${idClause}
    ORDER BY decided_at DESC LIMIT 1`, params);
  return decode(result.data[0]);
}

/** A transition-screen capability is itself the exact edge binding. */
export async function pendingApprovalByToken({ issueId, fromStatusId, toStatusId, approvalId, now = Date.now() }) {
  if (!approvalId) return null;
  const result = await query(`SELECT ${selection} FROM va_approval WHERE issue_id = ?
    AND state = 'PENDING' AND decision = 'APPROVE' AND from_status_id = ? AND to_status_id = ?
    AND expires_at > ? AND approval_id = FROM_BASE64(?) LIMIT 1`,
  [issueId, fromStatusId, toStatusId, now, encode(Buffer.isBuffer(approvalId) ? approvalId : Buffer.from(approvalId, 'hex'))]);
  return decode(result.data[0]);
}
/**
 * The approval this reviewer signed whose transition never landed.
 *
 * Scoped to the signer and to the status the item is actually in, because those
 * are two of the preconditions usecases/approval.js retryTransition enforces
 * (`row.account_id === accountId`, `row.from_status_id === issue.statusId`).
 * Reading it any wider would let the panel offer a retry the resolver is
 * certain to refuse. The to-status is deliberately left open: the caller
 * matches it against the transitions Jira is currently offering.
 */
export async function pendingApprovalForActor({ issueId, accountId, fromStatusId, now = Date.now() }) {
  if (!accountId) return null;
  const result = await query(`SELECT ${selection} FROM va_approval WHERE issue_id = ?
    AND state = 'PENDING' AND decision = 'APPROVE' AND baseline_id IS NULL
    AND account_id = ? AND from_status_id = ? AND expires_at > ?
    ORDER BY decided_at DESC LIMIT 1`, [issueId, accountId, fromStatusId, now]);
  return decode(result.data[0]);
}
/**
 * pendingApprovalForActor() for a whole worklist page in one read: this
 * reviewer's signed workflow approvals whose transition has not happened yet.
 */
export async function pendingMovesFor({ accountId, issueIds, now = Date.now() }) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isFinite))];
  if (!accountId || ids.length === 0) return [];
  const result = await query(`SELECT issue_id, transition_id, from_status_id, to_status_id FROM va_approval
    WHERE account_id = ? AND state = 'PENDING' AND decision = 'APPROVE' AND baseline_id IS NULL AND expires_at > ?
      AND issue_id IN (${ids.map(() => '?').join(', ')})`, [accountId, now, ...ids]);
  return result.data.map(row => ({ ...row, issue_id: Number(row.issue_id) }));
}
export async function casConsume({ approvalId, now }) {
  const result = await query(`UPDATE va_approval SET state = 'CONSUMED', consumed_at = ?
    WHERE approval_id = FROM_BASE64(?) AND state = 'PENDING' AND decision = 'APPROVE' AND expires_at > ?`,
  [now, encode(approvalId), now]);
  return { consumed: affectedRows(result) === 1 };
}
export async function voidOthers({ issueId, exceptApprovalId = null }) {
  const params = [issueId];
  if (exceptApprovalId) params.push(encode(exceptApprovalId));
  return affectedRows(await query(`UPDATE va_approval SET state = 'VOID', consumed_at = NULL
    WHERE issue_id = ? AND state = 'PENDING'${exceptApprovalId ? ' AND approval_id <> FROM_BASE64(?)' : ''}`, params)) ?? 0;
}
export async function approvalById(approvalId) {
  const result = await query(`SELECT ${selection} FROM va_approval WHERE approval_id = FROM_BASE64(?)`, [encode(approvalId)]);
  return decode(result.data[0]);
}
export async function approvalHistory(issueId, limit = 50) {
  return (await query(`SELECT ${selection} FROM va_approval WHERE issue_id = ? ORDER BY decided_at DESC LIMIT ${limitClause(limit)}`, [issueId])).data.map(decode);
}
/** The most recent transition approval for this issue, decided or not, with or without a baseline.
 *  Used by the panel summary to show "latest approval owner/time/outcome" without the full history read. */
export async function latestApproval(issueId) {
  const result = await query(`SELECT ${selection} FROM va_approval WHERE issue_id = ? ORDER BY decided_at DESC LIMIT 1`, [issueId]);
  return decode(result.data[0]);
}
export async function approvalsForActor(accountId, { limit = 50 } = {}) {
  return (await query(`SELECT ${selection} FROM va_approval WHERE actor_account_id = ? ORDER BY decided_at DESC LIMIT ${limitClause(limit)}`, [accountId])).data.map(decode);
}
export async function approvalsForProject(projectId, { sinceMs = 0, limit = 100 } = {}) {
  return (await query(`SELECT ${selection} FROM va_approval WHERE project_id = ? AND decided_at >= ? ORDER BY decided_at DESC LIMIT ${limitClause(limit)}`, [projectId, sinceMs])).data.map(decode);
}
export async function expireStale(now) {
  return affectedRows(await query(`UPDATE va_approval SET state = 'VOID' WHERE state = 'PENDING' AND expires_at <= ?`, [now])) ?? 0;
}
