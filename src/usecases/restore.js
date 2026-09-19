import { load, respond, fail } from './panelAccess.js';
import { restoresForIssue, restoreById } from '../db/restoreStore.js';
import { approvalById } from '../db/approvalStore.js';
import { resumable, comparableDigests, approvedDigestsFor } from '../lib/restore/resume.js';
import { clearRefusedRestoreActions } from '../db/restoreTreeStore.js';
import { acquire } from '../db/itemStateStore.js';
import { enqueueRestore } from '../lib/restore/queue.js';
import { markRestoreQueued, markRestoreQueueFailure } from '../db/restoreStore.js';
import { isEligible } from '../lib/reviewer.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';

const idBase64 = value => Buffer.isBuffer(value) ? value.toString('base64') : String(value);

export async function getState(args) { return respond(async () => {
  const prepared = await load(args);
  const rows = await restoresForIssue(prepared.issueId);
  return { restores: rows.map(row => ({ ...row,
    error: row.last_error ?? null,
    progress: { totalSteps: Number(row.total_steps ?? 0), completedSteps: Number(row.completed_steps ?? 0),
      remainingSteps: Math.max(0, Number(row.total_steps ?? 0) - Number(row.completed_steps ?? 0)) }
  })) };
}); }
export async function retry(args) { return respond(async () => {
  const prepared = await load(args);
  const restore = await restoreById(args.payload?.restoreId);
  if (!restore || Number(restore.issue_id) !== prepared.issueId) fail('RESTORE_NOT_FOUND');
  if (restore.state === 'RUNNING' || restore.state === 'RESTORING' || restore.state === 'QUEUING') fail('ALREADY_RESTORING');
  if (restore.state === 'COMPLETE' || restore.state === 'COMPLETE_WITH_REPLACEMENTS') return { success: true, restore };
  if (Number(restore.baseline_version) !== prepared.baselineVersion) fail('STALE_BASELINE');
  if (!prepared.baseline?.baseline_id || !restore.baseline_id
      || !Buffer.from(prepared.baseline.baseline_id).equals(Buffer.from(restore.baseline_id))) fail('STALE_BASELINE');
  const frozen = baselinePolicy(prepared.baseline);
  const eligible = await isEligible({ accountId: prepared.actor.accountId, projectId: prepared.projectId,
    issueTypeId: prepared.issueTypeId, role: frozen.requiredRole });
  if (!eligible) fail('NOT_ELIGIBLE');
  const approval = await approvalById(restore.approval_id);
  if (!approval || approval.decision !== 'REJECT' ||
      String(approval.actor_account_id ?? approval.account_id) !== prepared.actor.accountId) fail('NOT_ELIGIBLE');

  // A retry RESUMES the reviewer's signature; it never re-signs. The signed
  // content_hash is passed through untouched, and the item is only allowed to
  // sit somewhere on the path between the rejected candidate and the approved
  // baseline. Substituting today's hash here — as this used to — made the
  // downstream comparison compare a value with itself and pass unconditionally.
  const check = resumable({
    baselineDigests: comparableDigests(approvedDigestsFor({ baseline: prepared.baseline,
      baselineTree: prepared.baselineTree, issueId: prepared.issueId })),
    candidateDigests: comparableDigests(restore.candidate_digests ?? {}),
    currentDigests: comparableDigests(prepared.digests ?? {})
  });
  if (!check.ok) fail(check.reason);

  // A refusal is settled so that a requeue does not retry it for ever. A
  // reviewer pressing Retry is saying the opposite — that something about the
  // refusal may have changed, usually a field configuration an administrator
  // has just corrected — so those steps are reopened for this attempt.
  await clearRefusedRestoreActions(restore.restore_id).catch(error =>
    console.error('restore: could not reopen refused actions', error));

  const locked = await acquire({ issueId: prepared.issueId, expectedVersion: prepared.review?.version,
    state: 'RESTORING', allowedStates: ['ERROR', 'DRIFTED', 'RESTORING'], now: Date.now() });
  if (!locked?.acquired) fail('ALREADY_DECIDING');
  const restoreId = restore.restore_id;
  const body = { restoreId: idBase64(restoreId), issueId: prepared.issueId,
    baselineId: idBase64(restore.baseline_id), baselineVersion: Number(restore.baseline_version) };
  try {
    const pushed = await enqueueRestore(body);
    if (!pushed?.jobId) throw new Error('Forge did not return a restore job id');
    await markRestoreQueued({ restoreId, jobId: pushed.jobId, now: Date.now(), totalSteps: restore.total_steps });
    return { success: true, state: 'RESTORING', restoreId, jobId: pushed.jobId,
      progress: { totalSteps: Number(restore.total_steps ?? 0), completedSteps: Number(restore.completed_steps ?? 0),
        remainingSteps: Math.max(0, Number(restore.total_steps ?? 0) - Number(restore.completed_steps ?? 0)) } };
  } catch (error) {
    await markRestoreQueueFailure({ restoreId, error: String(error?.message ?? error), now: Date.now() });
    return { success: false, state: 'QUEUING_FAILED', restoreId, error: String(error?.message ?? error) };
  }
}); }
