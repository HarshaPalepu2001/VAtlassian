import { readableIssue, snapshot, actorFrom, load, fail, respond } from './panelAccess.js';
import { acquire, release } from '../db/itemStateStore.js';
import { writeCapturedBaseline } from '../lib/capture.js';
import { markDecided } from '../db/driftStore.js';
import { canDecide, decide } from '../lib/decision.js';
import { planRestore } from '../lib/restore/planner.js';
import { performRestore } from './restoreActions.js';
import { meetsAssurance, effectiveAssurance } from '../lib/approval/levels.js';

export async function getState(args) { return respond(async () => {
  const state = await load(args); return { drift: state.diff, review: state.review };
}); }
export async function getDiff(args) { return respond(async () => ({ diff: (await load(args)).diff })); }

/** Called internally by the sole approval writer; no approval is inserted here. */
export async function prepareApproval({ issue, actor, decision, expectedEvidenceHash, forTransition = false }) {
  const fresh = await readableIssue({ payload: { issueId: issue.id }, context: { accountId: actor.accountId } });
  const prepared = await snapshot({ issue: fresh, actor, requireAuthority: true, expectedEvidenceHash });
  if (prepared.baseline) {
    const permission = canDecide({ review: prepared.review, baseline: prepared.baseline, isEligible: prepared.eligible });
    if (!permission.allow) fail(permission.reason);
    const plan = decision === 'REJECT' ? planRestore({ diff: prepared.diff, baselineValues: prepared.baselineValues,
      controlledFields: prepared.fields, editmeta: prepared.editmeta }) : null;
    const result = decide({ decision, diff: prepared.diff, plan, evidenceHash: expectedEvidenceHash });
    if (!result.allow) fail(result.reason);
    prepared.plan = plan;
  } else if (decision === 'REJECT') fail('NO_BASELINE');
  return prepared;
}

export async function applyApproval({ issue, actor, approval, prepared, resuming = false }) {
  if (!approval?.approval_id || !actor?.accountId ||
      String(approval.actor_account_id ?? approval.account_id) !== actor.accountId ||
      String(approval.issue_id) !== String(issue.id)) fail('APPROVAL_BINDING_MISMATCH');
  // Only the approval owner's audited capability is accepted. Provider evidence
  // hash is deliberately distinct from the reviewed diff evidence hash.
  if (!['VOID', 'CONSUMED'].includes(approval.state)) fail('APPROVAL_NOT_VERIFIED');
  const fresh = await prepareApproval({ issue, actor, decision: approval.decision,
    expectedEvidenceHash: prepared?.evidenceHash });

  // `resuming` is set ONLY by usecases/restore.js after resumable() has proved
  // every tracked field still holds either the signed candidate value or the
  // approved baseline value. It relaxes the content-hash equality — never the
  // eligibility, assurance or baseline-version checks around it.
  if (!resuming && approval.content_hash !== fresh.contentHash) fail('STALE_EVIDENCE');
  if (Number(approval.baseline_version ?? fresh.baselineVersion) !== fresh.baselineVersion) fail('STALE_EVIDENCE');
  if (!meetsAssurance(approval.assurance_level, effectiveAssurance(fresh.gate?.required_assurance))) fail('INSUFFICIENT_ASSURANCE');
  let locked = false;
  if (fresh.review) {
    const result = await acquire({ issueId: fresh.issueId, expectedVersion: fresh.review.version,
      state: approval.decision === 'REJECT' ? 'RESTORING' : 'DECIDING' });
    if (!result.acquired) fail('ALREADY_DECIDING');
    locked = true;
  }
  try {
    // Re-read after the CAS: a concurrent edit must not be silently accepted.
    const checkedIssue = await readableIssue({ payload: { issueId: issue.id }, context: { accountId: actor.accountId } });
    const checked = await snapshot({ issue: checkedIssue, actor, requireAuthority: true,
      expectedEvidenceHash: fresh.evidenceHash });
    if (!resuming && checked.contentHash !== approval.content_hash) fail('STALE_EVIDENCE');
    if (approval.decision === 'REJECT') return await performRestore({ prepared: checked, actor, approval });
    let capture = { captured: false, reason: 'CAPTURE_DISABLED' };
    if (!checked.gate || (checked.gate.capture_baseline !== false && checked.gate.capture_baseline !== 0)) {
      capture = await writeCapturedBaseline({ issueId: checked.issueId, issueKey: checked.issue.key,
        projectId: checked.projectId, issueTypeId: checked.issueTypeId, controlledFields: checked.fields,
        issueFields: checked.issue.fields, editmetaFields: checked.editmeta,
        transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(), capturedAt: Date.now(),
        approver: { accountId: actor.accountId, displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
          approvalId: approval.approval_id, assuranceLevel: approval.assurance_level },
        fromStatusId: approval.from_status_id, toStatusId: approval.to_status_id,
        requiredRole: checked.gate?.required_role, reviewerFieldId: checked.config.reviewerFieldId });
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
    }
    if (checked.baseline) await markDecided({ issueId: checked.issueId,
      baselineVersion: checked.baseline.version, approvalId: approval.approval_id });
    // writeCapturedBaseline publishes the new item state only after durable values.
    return { success: true, capture };
  } catch (error) {
    if (locked) await release({ issueId: fresh.issueId, state: 'ERROR', now: Date.now(), counters: {
      driftCount: fresh.driftCount, driftedFieldCount: fresh.diff?.materialFieldCount ?? 0,
      maxMateriality: fresh.diff?.maxMateriality ?? null } });
    throw error;
  }
}
export async function approveVerified({ approval, context, prepared }) {
  const actor = actorFrom(context);
  const issue = await readableIssue({ payload: { issueId: approval.issue_id }, context });
  return applyApproval({ issue, actor, approval, prepared });
}
export const rejectVerified = approveVerified;
