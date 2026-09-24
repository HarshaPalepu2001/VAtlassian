import { readableIssue, snapshot, actorFrom, load, fail, respond } from './panelAccess.js';
import { acquire, release } from '../db/itemStateStore.js';
import { writeCapturedBaseline } from '../lib/capture.js';
import { markDecided } from '../db/driftStore.js';
import { canDecide, decide, undecidedCounters } from '../lib/decision.js';
import { planRestore } from '../lib/restore/planner.js';
import { planTreeRestore } from '../lib/tree/restorePlan.js';
import { performRestore } from './restoreActions.js';
import { meetsAssurance, effectiveAssurance } from '../lib/approval/levels.js';
import { activeBaseline } from '../db/baselineStore.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';
import { isEligible } from '../lib/reviewer.js';
import { baselineDecisionMeaning } from '../lib/approval/challenge.js';
import { enqueueVault } from '../lib/vaultQueue.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
import api, { route } from '@forge/api';

export async function getState(args) { return respond(async () => {
  const state = await load(args); return { drift: state.diff, review: state.review };
}); }
export async function getDiff(args) { return respond(async () => ({ diff: (await load(args)).diff })); }

const RESTORE_TIMEOUT_MS = 24000;
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.reason = 'RESTORE_IN_PROGRESS';
      // Promise.race cannot cancel the restore. It may still be mutating Jira,
      // so callers must keep the compare-and-swap lock until it reaches its own
      // terminal release path.
      err.retainRestoreLock = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function releaseFailedApproval({ locked, issueId, diff, driftCount, error, release, now = Date.now() }) {
  if (!locked || error?.retainRestoreLock) return;
  await release({ issueId, state: 'ERROR', now,
    counters: { ...undecidedCounters(diff), driftCount } });
}

/** Called internally by the sole approval writer; no approval is inserted here. */
export async function prepareApproval({ issue, actor, decision, expectedEvidenceHash, forTransition = false, transition = null, allowBusy = false, now = Date.now() }) {
  const fresh = await readableIssue({ payload: { issueId: issue.id }, context: { accountId: actor.accountId } });
  const active = await activeBaseline(Number(fresh.id));
  // A workflow transition is authorised by the controlled transition it runs,
  // even when an earlier pass through the workflow left an active baseline.
  // Only a baseline-owned drift decision replays the baseline's frozen policy
  // and review status; applying that to a new transition would swap its
  // configured meaning for the drift meaning and refuse it as POLICY_CHANGED.
  const workflowTransition = forTransition && transition != null;
  const immutable = active && !workflowTransition ? baselinePolicy(active) : null;
  const approvalPolicy = immutable ? {
    transition_id: immutable.transitionId,
    from_status_id: immutable.reviewStatusId,
    to_status_id: immutable.destinationStatusId,
    required_role: immutable.requiredRole,
    required_assurance: immutable.requiredAssurance,
    meaning: baselineDecisionMeaning(decision, immutable.version),
    capture_baseline: true
  } : null;
  const prepared = await snapshot({ issue: fresh, actor, requireAuthority: true, expectedEvidenceHash,
    transition, authorityPolicy: approvalPolicy });
  if (immutable) {
    if (!prepared.baseline || !Buffer.from(prepared.baseline.baseline_id).equals(Buffer.from(immutable.baselineId))
        || Number(prepared.baseline.version) !== immutable.version) fail('STALE_EVIDENCE');
    // NO REVIEW-STATUS CHECK. Drift outlives review status — the item is
    // wherever the workflow has since taken it, and approving its current
    // content is a statement about that content, not about where it sits.
    // See usecases/approval.js's drift branch for the whole reasoning; the
    // guard that used to be here refused APPROVE on any item that had moved
    // past the status its baseline was captured leaving.
    const eligible = await isEligible({ accountId: actor.accountId, projectId: prepared.projectId,
      issueTypeId: prepared.issueTypeId, role: immutable.requiredRole });
    if (!eligible) fail('NOT_ELIGIBLE');
    prepared.eligible = true;
    prepared.baselinePolicy = immutable;
    prepared.approvalPolicy = approvalPolicy;
    prepared.gate = approvalPolicy;
  }
  if (prepared.baseline) {
    const permission = canDecide({ review: prepared.review, baseline: prepared.baseline, isEligible: prepared.eligible, now });
    // A restore retry has already authenticated the original rejection and
    // proved that the current values are still on the signed-candidate to
    // baseline path. It must be allowed to recover a legacy DECIDING lock;
    // ordinary approvals/rejections remain fail-closed on busy state.
    if (!permission.allow && !(allowBusy && permission.reason === 'ALREADY_DECIDING')) fail(permission.reason);
    const plan = decision === 'REJECT'
      ? prepared.baselineTree && prepared.currentTree
        ? planTreeRestore({ baselineTree: prepared.baselineTree, currentTree: prepared.currentTree,
            controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor })
        : planRestore({ diff: prepared.diff, baselineValues: prepared.baselineValues,
            controlledFields: prepared.fields, editmeta: prepared.restoreEditmeta ?? prepared.editmeta })
      : null;
    // Tree approvals and rejections use the same aggregate evidence domain.
    // Their restore plan is structural and never falls back to the legacy
    // field-only planner. The count is the grouped review's: the parent's own
    // fields, its structure, and every child that drifted against its own
    // baseline, which is everything this decision covers.
    const decisionDiff = prepared.treeHash
      ? {
          changedFieldCount: prepared.reviewDiff?.changedFieldCount ?? prepared.treeDiff?.changes?.length
            ?? prepared.diff?.changedFieldCount ?? 0,
          evidenceHash: prepared.treeHash
        }
      : prepared.diff;
    const result = decide({
      decision,
      diff: decisionDiff,
      plan,
      evidenceHash: expectedEvidenceHash
    });
    if (!result.allow) fail(result.reason);
    prepared.plan = plan;
  } else if (decision === 'REJECT') fail('NO_BASELINE');
  return prepared;
}

/**
 * Hands the new baseline's attachments to the vault worker (jobs/vaultWorker.js)
 * — queued, so the copying never spends this approval's time budget. Vaulting
 * is defence in depth, not the record: the baseline row already is. A queue
 * failure is audited and never fails the decision that captured the baseline.
 */
async function queueVaulting({ capture, checked, actor }) {
  const baselineId = Buffer.isBuffer(capture.baselineId) ? capture.baselineId.toString('hex') : String(capture.baselineId ?? '');
  try {
    await enqueueVault({ baselineId, issueId: checked.issueId, issueKey: checked.issue.key, projectId: checked.projectId });
  } catch (error) {
    console.error('applyApproval: could not queue attachment vaulting', error);
    await tryAppend({ actorAccountId: actor.accountId, issueId: checked.issueId, eventType: EVENT.VAULT_QUEUE_FAILED,
      payload: { baselineId, error: String(error?.message ?? error) } }).catch(() => {});
  }
}

export async function applyApproval({ issue, actor, approval, prepared, resuming = false, policy = null, workflowTransition = null }) {
  if (!approval?.approval_id || !actor?.accountId ||
      String(approval.actor_account_id ?? approval.account_id) !== actor.accountId ||
      String(approval.issue_id) !== String(issue.id)) fail('APPROVAL_BINDING_MISMATCH');
  // Only the approval owner's audited capability is accepted. Provider evidence
  // hash is deliberately distinct from the reviewed diff evidence hash.
  if (!['VOID', 'CONSUMED'].includes(approval.state)) fail('APPROVAL_NOT_VERIFIED');
  const transition = approval.transition_id ? { id: approval.transition_id, toStatusId: approval.to_status_id } : null;
  // A drift decision also carries the baseline's transition id, so the id alone
  // cannot tell the two intents apart. Workflow approvals are recorded without
  // a baseline binding; use that when the caller does not say explicitly.
  const forTransition = transition != null && (workflowTransition ?? approval.baseline_id == null);
  let fresh = await prepareApproval({ issue, actor, decision: approval.decision,
    expectedEvidenceHash: resuming ? undefined : prepared?.evidenceHash, forTransition, transition, allowBusy: resuming });
  const assertPolicy = current => {
    const authoritative = current.approvalPolicy ?? current.gate;
    if (policy && ['required_role', 'required_assurance', 'meaning', 'capture_baseline']
      .some(key => String(policy[key]) !== String(authoritative?.[key]))) fail('POLICY_CHANGED');
    if (Number(approval.baseline_version ?? current.baselineVersion) !== current.baselineVersion) fail('STALE_EVIDENCE');
    if (!meetsAssurance(approval.assurance_level, effectiveAssurance(authoritative?.required_assurance))) fail('INSUFFICIENT_ASSURANCE');
  };
  assertPolicy(fresh);

  // `resuming` is set ONLY by usecases/restore.js after resumable() has proved
  // every tracked field still holds either the signed candidate value or the
  // approved baseline value. It relaxes the content-hash equality — never the
  // eligibility, assurance or baseline-version checks around it.
  if (!resuming && approval.content_hash !== fresh.contentHash) fail('STALE_EVIDENCE');
  let locked = false;
  if (fresh.review) {
    const allowedStates = resuming ? ['DECIDING', 'ERROR', 'LOCKED'] : ['BASELINED', 'DRIFTED', 'ERROR'];
    const attempts = resuming ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await acquire({ issueId: fresh.issueId, expectedVersion: fresh.review.version,
        state: approval.decision === 'REJECT' ? 'RESTORING' : 'DECIDING', allowedStates, now: Date.now() });
      if (result.acquired) { locked = true; break; }
      if (!resuming || attempt === attempts - 1) fail('ALREADY_DECIDING');
      // A collector or an older observer may have advanced the CAS token
      // between the snapshot and this acquire. Re-read and retry once, but
      // keep the state allow-list so a live restore is never taken over.
      fresh = await prepareApproval({ issue, actor, decision: approval.decision,
        expectedEvidenceHash: undefined, forTransition, transition, allowBusy: true });
      assertPolicy(fresh);
    }
    if (!locked) fail(fresh.review?.state === 'RESTORING' ? 'RESTORE_IN_PROGRESS' : 'ALREADY_DECIDING');
  }
  try {
    // Re-read after the CAS: a concurrent edit must not be silently accepted.
    const checked = await prepareApproval({ issue, actor, decision: approval.decision,
      expectedEvidenceHash: fresh.evidenceHash, forTransition, transition, allowBusy: true });
    if (!resuming && checked.contentHash !== approval.content_hash) fail('STALE_EVIDENCE');
    if (approval.decision === 'REJECT') {
      if (checked.baseline && checked.issue.fields.status?.id && String(checked.issue.fields.status.id) !== checked.baseline.from_status_id) {
        
        
        const commentBody = `Electronic signature review rejected by ${actor.displayName}. The baseline content has been automatically restored.`;
        await api.asUser().requestJira(route`/rest/api/3/issue/${checked.issue.key}/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: commentBody }] }]
            }
          })
        }).catch(e => console.error('Failed to post comment', e));
      }
      console.log('Starting withTimeout performRestore');
      return await withTimeout(
        performRestore({ prepared: checked, actor, approval }),
        RESTORE_TIMEOUT_MS,
        'Restore is still running. Refresh the panel for its outcome.'
      );
    }
    let capture = { captured: false, reason: 'CAPTURE_DISABLED' };
    const capturesBaseline = [true, 1, '1'].includes(checked.gate?.capture_baseline);
    if (!transition || capturesBaseline) {
      if (capturesBaseline) {
        const { writeCapturedTreeBaseline } = await import('../lib/capture.js');
        const { readStableTree } = await import('../lib/tree/stableRead.js');
        const { planTreeCapture } = await import('../lib/tree/capturePlan.js');
        const { writeTreeCapture, publishTreeBaseline } = await import('../db/baselineTreeStore.js');
        const { tryAppend } = await import('../db/store.js');
        const { executeQuery } = await import('../lib/db.js');
        const { createTreeReader } = await import('../lib/tree/jira.js');
        const api = await import('@forge/api');
        
        capture = await writeCapturedTreeBaseline({
          rootIssue: checked.issue,
          policy: checked.gate,
          approval: {
            accountId: actor.accountId,
            displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
            approvalId: approval.approval_id,
            assuranceLevel: approval.assurance_level,
            content_hash: approval.content_hash,
          },
          controlledFields: checked.fields,
          transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(),
          deps: {
            readTree: createTreeReader({ api: api.default, route: api.route }).read,
            readStableTree,
            planTreeCapture,
            writeTreeCapture,
            publishTreeBaseline,
            tryAppend,
            executeQuery
          }
        });
      } else {
        capture = await writeCapturedBaseline({ issueId: checked.issueId, issueKey: checked.issue.key,
          projectId: checked.projectId, issueTypeId: checked.issueTypeId, controlledFields: checked.fields,
          issueFields: checked.issue.fields, editmetaFields: checked.editmeta,
          transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(), capturedAt: Date.now(),
          approver: { accountId: actor.accountId, displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
            approvalId: approval.approval_id, assuranceLevel: approval.assurance_level, contentHash: approval.content_hash },
          // A standalone ratification does not select a new workflow policy.
          // Preserve the policy edge so the next review can resolve its authority;
          // the approval itself still records the actual, unchanged Jira status.
          transitionId: transition ? approval.transition_id : checked.baseline?.transition_id ?? null,
          fromStatusId: transition ? approval.from_status_id : checked.baseline?.from_status_id ?? checked.gate?.from_status_id ?? approval.from_status_id,
          toStatusId: transition ? approval.to_status_id : checked.baseline?.to_status_id ?? checked.gate?.to_status_id ?? approval.to_status_id,
          requiredRole: checked.gate?.required_role, reviewerFieldId: checked.config.reviewerFieldId });
      }
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
      await queueVaulting({ capture, checked, actor });
    }
    if (checked.baseline && capture.captured) {
      await markDecided({ issueId: checked.issueId,
        baselineVersion: checked.baseline.version, approvalId: approval.approval_id });
    }
    if (locked && !capture.captured) await release({ issueId: checked.issueId,
      state: checked.diff?.changedFieldCount > 0 ? 'DRIFTED' : 'BASELINED', now: Date.now(),
      counters: undecidedCounters(checked.diff) });
    // writeCapturedBaseline publishes the new item state only after durable values.
    return { success: true, capture, baselinePublished: capture.captured === true };
  } catch (error) {
    // `driftCount` here is the snapshot's, which also counts undecided drift
    // rows the current diff no longer shows. A timeout is different: the
    // underlying restore remains live, so changing the lock would admit a
    // concurrent restore before the first one reaches its own finally block.
    await releaseFailedApproval({ locked, issueId: fresh.issueId, diff: fresh.diff,
      driftCount: fresh.driftCount, error, release });
    throw error;
  }
}
export async function approveVerified({ approval, context, prepared }) {
  const actor = actorFrom(context);
  const issue = await readableIssue({ payload: { issueId: approval.issue_id }, context });
  return applyApproval({ issue, actor, approval, prepared });
}
export const rejectVerified = approveVerified;
