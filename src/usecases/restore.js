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
/** Restore states with a worker (or the synchronous path) still acting on the item. */
const IN_FLIGHT = new Set(['RUNNING', 'RESTORING', 'QUEUING', 'VERIFYING']);

export async function getState(args) { return respond(async () => {
  const prepared = await load(args);
  const rows = await restoresForIssue(prepared.issueId);
  // Each restore was started by a reject decision; its signed name is who
  // triggered it, as the baseline record shows it.
  const approvals = new Map(await Promise.all([...new Set(rows.map(row => row.approval_id).filter(Boolean))]
    .map(async id => [id, await approvalById(id).catch(() => null)])));
  const at = value => value != null ? Number(value) : null;
  return { restores: rows.map(row => {
    const approval = approvals.get(row.approval_id);
    return { ...row,
      error: row.last_error ?? null,
      progress: { totalSteps: Number(row.total_steps ?? 0), completedSteps: Number(row.completed_steps ?? 0),
        remainingSteps: Math.max(0, Number(row.total_steps ?? 0) - Number(row.completed_steps ?? 0)) },
      actorName: approval?.printed_name ?? approval?.actor_name ?? null,
      // retry() below resumes the rejecter's own signature, so only they may.
      canRetry: Boolean(prepared.actor?.accountId) && row.actor_account_id === prepared.actor.accountId,
      startedAt: at(row.started_at),
      finishedAt: at(row.finished_at),
      baselineVersion: at(row.baseline_version)
    };
  }) };
}); }
export async function retry(args) { return respond(async () => {
  const prepared = await load(args);
  const restore = await restoreById(args.payload?.restoreId);
  if (!restore || Number(restore.issue_id) !== prepared.issueId) fail('RESTORE_NOT_FOUND');
  if (IN_FLIGHT.has(restore.state)) fail('ALREADY_RESTORING');
  // The lock below admits a RESTORING item, because a restore whose own queue
  // push failed may still hold it. It must not admit one held by a DIFFERENT
  // restore that is still writing, or the two would run over each other.
  const sameRestore = row => Buffer.from(row.restore_id ?? []).equals(Buffer.from(restore.restore_id ?? []));
  if ((await restoresForIssue(prepared.issueId)).some(row => !sameRestore(row) && IN_FLIGHT.has(row.state))) {
    fail('ALREADY_RESTORING');
  }
  if (restore.state === 'COMPLETE' || restore.state === 'COMPLETE_WITH_REPLACEMENTS') return { success: true, restore };
  if (Number(restore.baseline_version) !== prepared.baselineVersion) fail('STALE_BASELINE');
  if (!prepared.baseline?.baseline_id || !restore.baseline_id
      || !Buffer.from(prepared.baseline.baseline_id).equals(Buffer.from(restore.baseline_id))) fail('STALE_BASELINE');
  const frozen = baselinePolicy(prepared.baseline);
  const eligible = await isEligible({ accountId: prepared.actor.accountId, projectId: prepared.projectId,
    issueTypeId: prepared.issueTypeId, role: frozen.requiredRole });
  if (!eligible) fail('NOT_ELIGIBLE');
  const approval = await approvalById(restore.approval_id);
  // A per-field decision's restore is resumed by the same signature: its target
  // and the fields it approved are frozen in the restore's own detail, which the
  // worker reads (jobs/restoreWorker.js), so nothing about the retry changes.
  if (!approval || !['REJECT', 'MIXED'].includes(approval.decision) ||
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

  const locked = await acquire({ issueId: prepared.issueId, expectedVersion: prepared.review?.version,
    state: 'RESTORING', allowedStates: ['ERROR', 'DRIFTED', 'RESTORING'], now: Date.now() });
  if (!locked?.acquired) fail('ALREADY_DECIDING');

  // A refusal is settled so that a requeue does not retry it for ever. A
  // reviewer pressing Retry is saying the opposite — that something about the
  // refusal may have changed, usually a field configuration an administrator
  // has just corrected — so those steps are reopened for this attempt, once
  // this retry holds the lock and no other restore can be reading them.
  await clearRefusedRestoreActions(restore.restore_id).catch(error =>
    console.error('restore: could not reopen refused actions', error));
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
    await (release)({ issueId: prepared.issueId, state: 'ERROR', now: Date.now() })
      .catch(failure => console.error('restore: could not release the lock after a queue failure', failure));
    return { success: false, state: 'QUEUING_FAILED', restoreId, error: String(error?.message ?? error) };
  }
}); }
