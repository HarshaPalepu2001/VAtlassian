import { load, respond, fail } from './panelAccess.js';
import { restoresForIssue, restoreById } from '../db/restoreStore.js';
import { approvalById } from '../db/approvalStore.js';
import { applyApproval } from './drift.js';
import { resumable } from '../lib/restore/resume.js';

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

  // A retry RESUMES the reviewer's signature; it never re-signs. The signed
  // content_hash is passed through untouched, and the item is only allowed to
  // sit somewhere on the path between the rejected candidate and the approved
  // baseline. Substituting today's hash here — as this used to — made the
  // downstream comparison compare a value with itself and pass unconditionally.
  const baselineDigests = typeof prepared.baseline?.field_digests === 'string'
    ? JSON.parse(prepared.baseline.field_digests)
    : (prepared.baseline?.field_digests ?? {});
  const check = resumable({
    baselineDigests,
    candidateDigests: restore.candidate_digests ?? {},
    currentDigests: prepared.digests ?? {}
  });
  if (!check.ok) fail(check.reason);

  // `resuming` is the only place this flag is ever set, and only after
  // resumable() above has proved the item is still on the signed path.
  return applyApproval({ issue: prepared.issue, actor: prepared.actor, approval, prepared, resuming: true });
}); }
