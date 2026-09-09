import { readableIssue, snapshot, actorFrom, load, fail, respond } from './panelAccess.js';
import { acquire, release } from '../db/itemStateStore.js';
import { writeCapturedBaseline } from '../lib/capture.js';
import { markDecided } from '../db/driftStore.js';
import { canDecide, decide, undecidedCounters } from '../lib/decision.js';
import { planRestore } from '../lib/restore/planner.js';
import { performRestore } from './restoreActions.js';
import { meetsAssurance, effectiveAssurance } from '../lib/approval/levels.js';

export async function getState(args) { return respond(async () => {
  const state = await load(args); return { drift: state.diff, review: state.review };
}); }
export async function getDiff(args) { return respond(async () => ({ diff: (await load(args)).diff })); }

const RESTORE_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const err = new Error(message); err.reason = 'SERVICE_UNAVAILABLE'; reject(err); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Called internally by the sole approval writer; no approval is inserted here. */
export async function prepareApproval({ issue, actor, decision, expectedEvidenceHash, forTransition = false, transition = null, allowBusy = false, now = Date.now() }) {
  const fresh = await readableIssue({ payload: { issueId: issue.id }, context: { accountId: actor.accountId } });
  const prepared = await snapshot({ issue: fresh, actor, requireAuthority: true, expectedEvidenceHash, transition });
  if (prepared.baseline) {
    const permission = canDecide({ review: prepared.review, baseline: prepared.baseline, isEligible: prepared.eligible, now });
    // A restore retry has already authenticated the original rejection and
    // proved that the current values are still on the signed-candidate to
    // baseline path. It must be allowed to recover a legacy DECIDING lock;
    // ordinary approvals/rejections remain fail-closed on busy state.
    if (!permission.allow && !(allowBusy && permission.reason === 'ALREADY_DECIDING')) fail(permission.reason);
    const plan = decision === 'REJECT' ? planRestore({ diff: prepared.diff, baselineValues: prepared.baselineValues,
      controlledFields: prepared.fields, editmeta: prepared.restoreEditmeta ?? prepared.editmeta }) : null;
    const result = decide({ decision, diff: prepared.diff, plan, evidenceHash: expectedEvidenceHash });
    if (!result.allow) fail(result.reason);
    prepared.plan = plan;
  } else if (decision === 'REJECT') fail('NO_BASELINE');
  return prepared;
}

export async function applyApproval({ issue, actor, approval, prepared, resuming = false, policy = null }) {
  if (!approval?.approval_id || !actor?.accountId ||
      String(approval.actor_account_id ?? approval.account_id) !== actor.accountId ||
      String(approval.issue_id) !== String(issue.id)) fail('APPROVAL_BINDING_MISMATCH');
  // Only the approval owner's audited capability is accepted. Provider evidence
  // hash is deliberately distinct from the reviewed diff evidence hash.
  if (!['VOID', 'CONSUMED'].includes(approval.state)) fail('APPROVAL_NOT_VERIFIED');
  const transition = approval.transition_id ? { id: approval.transition_id, toStatusId: approval.to_status_id } : null;
  let fresh = await prepareApproval({ issue, actor, decision: approval.decision,
    expectedEvidenceHash: resuming ? undefined : prepared?.evidenceHash, transition, allowBusy: resuming });
  const assertPolicy = current => {
    if (policy && ['required_role', 'required_assurance', 'meaning', 'capture_baseline', 'block_on_drift']
      .some(key => String(policy[key]) !== String(current.gate?.[key]))) fail('POLICY_CHANGED');
    if (Number(approval.baseline_version ?? current.baselineVersion) !== current.baselineVersion) fail('STALE_EVIDENCE');
    if (!meetsAssurance(approval.assurance_level, effectiveAssurance(current.gate?.required_assurance))) fail('INSUFFICIENT_ASSURANCE');
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
        expectedEvidenceHash: undefined, transition, allowBusy: true });
      assertPolicy(fresh);
    }
    if (!locked) fail(fresh.review?.state === 'RESTORING' ? 'RESTORE_IN_PROGRESS' : 'ALREADY_DECIDING');
  }
  try {
    // Re-read after the CAS: a concurrent edit must not be silently accepted.
    const checkedIssue = await readableIssue({ payload: { issueId: issue.id }, context: { accountId: actor.accountId } });
    const checked = await snapshot({ issue: checkedIssue, actor, requireAuthority: true,
      expectedEvidenceHash: fresh.evidenceHash, transition });
    if (!resuming && checked.contentHash !== approval.content_hash) fail('STALE_EVIDENCE');
    if (approval.decision === 'REJECT') {
      return await withTimeout(
        performRestore({ prepared: checked, actor, approval }),
        RESTORE_TIMEOUT_MS,
        'Restore timed out waiting for Jira. Please retry.'
      );
    }
    let capture = { captured: false, reason: 'CAPTURE_DISABLED' };
    if (!transition || [true, 1, '1'].includes(checked.gate?.capture_baseline)) {
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
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
    }
    if (checked.baseline && capture.captured) await markDecided({ issueId: checked.issueId,
      baselineVersion: checked.baseline.version, approvalId: approval.approval_id });
    if (locked && !capture.captured) await release({ issueId: checked.issueId,
      state: checked.diff?.changedFieldCount > 0 ? 'DRIFTED' : 'BASELINED', now: Date.now(),
      counters: undecidedCounters(checked.diff) });
    // writeCapturedBaseline publishes the new item state only after durable values.
    return { success: true, capture };
  } catch (error) {
    if (locked) await release({ issueId: fresh.issueId, state: 'ERROR', now: Date.now(),
      // `driftCount` here is the snapshot's, which also counts undecided drift
      // rows the current diff no longer shows.
      counters: { ...undecidedCounters(fresh.diff), driftCount: fresh.driftCount } });
    throw error;
  }
}
export async function approveVerified({ approval, context, prepared }) {
  const actor = actorFrom(context);
  const issue = await readableIssue({ payload: { issueId: approval.issue_id }, context });
  return applyApproval({ issue, actor, approval, prepared });
}
export const rejectVerified = approveVerified;
