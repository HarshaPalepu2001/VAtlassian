import { executeQuery, fromBinaryColumn } from './db.js';
import { meetsAssurance } from './approval/levels.js';
import { baselineLinkPolicy } from './linkPolicy.js';

export async function recentConsumedApproval(issueId, fromStatusId, toStatusId, at) {
  const statement = `SELECT TO_BASE64(approval_id) AS approval_id,
    actor_account_id, actor_name, assurance_level, decision, state, content_hash, link_policy
    FROM va_approval WHERE issue_id = ? AND state = 'CONSUMED' AND decision = 'APPROVE'
    AND from_status_id = ? AND to_status_id = ? AND consumed_at >= ? AND consumed_at <= ?
    ORDER BY consumed_at DESC LIMIT 1`;
  const params = [issueId, fromStatusId, toStatusId, at - 120000, at + 1000];
  let result = await executeQuery(statement, params);
  if (!result.result && (result.error?.code === 'ER_BAD_FIELD_ERROR' || result.error?.context?.debug?.code === 'ER_BAD_FIELD_ERROR')) {
    result = await executeQuery(statement.replace(', link_policy', ''), params);
  }
  if (!result.result) throw result.error;
  const row = result.data[0];
  return row ? { ...row, approval_id: fromBinaryColumn(row.approval_id) } : null;
}

export function approvalFrom(record, requiredAssurance = 'NATIVE_TRANSITION') {
  if (!record?.approval_id || record.decision !== 'APPROVE' || record.state !== 'CONSUMED') return { ok: false, reason: 'NO_APPROVAL' };
  if (!meetsAssurance(record.assurance_level, requiredAssurance)) return { ok: false, reason: 'INSUFFICIENT_ASSURANCE' };
  return { ok: true, approver: { accountId: record.actor_account_id ?? record.account_id,
    displayName: record.actor_name ?? record.printed_name, approvalId: record.approval_id,
    assuranceLevel: record.assurance_level, contentHash: record.content_hash, linkPolicy: baselineLinkPolicy(record) } };
}
