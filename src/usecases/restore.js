import { load, respond, fail } from './panelAccess.js';
import { restoresForIssue, restoreById } from '../db/restoreStore.js';
import { approvalById } from '../db/approvalStore.js';
import { applyApproval } from './drift.js';

export async function getState(args) { return respond(async () => {
  const prepared = await load(args);
  return { restores: await restoresForIssue(prepared.issueId) };
}); }
export async function retry(args) { return respond(async () => {
  const prepared = await load(args, { requireAuthority: true });
  const restore = await restoreById(args.payload?.restoreId);
  if (!restore || Number(restore.issue_id) !== prepared.issueId) fail('RESTORE_NOT_FOUND');
  if (restore.state === 'RUNNING') fail('ALREADY_RESTORING');
  if (restore.state === 'COMPLETE') return { success: true, restore };
  if (Number(restore.baseline_version) !== prepared.baselineVersion) fail('STALE_BASELINE');
  const approval = await approvalById(restore.approval_id);
  if (!approval || approval.decision !== 'REJECT' ||
      String(approval.actor_account_id ?? approval.account_id) !== prepared.actor.accountId) fail('NOT_ELIGIBLE');
  // A retry may only continue the same failed restoration against its original
  // baseline; new intervening edits require a new approval through submit.
  const failedFields = new Set((restore.detail ?? []).filter(d => d.outcome === 'failed').map(d => d.fieldId));
  if (prepared.diff.fields.some(d => !failedFields.has(d.fieldId))) fail('NEW_EVIDENCE_REQUIRES_APPROVAL');
  return applyApproval({ issue: prepared.issue, actor: prepared.actor,
    approval: { ...approval, content_hash: prepared.contentHash }, prepared });
}); }
