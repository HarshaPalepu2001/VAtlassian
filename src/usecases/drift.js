import { readableIssue, snapshot, actorFrom, load, fail, respond } from './panelAccess.js';
import { acquire, release } from '../db/itemStateStore.js';
import { writeCapturedBaseline } from '../lib/capture.js';
import { CAUSE } from '../lib/evidence/versionEvidence.js';
import { markDecided } from '../db/driftStore.js';
import { canDecide, decide, undecidedCounters } from '../lib/decision.js';
import { planRestore } from '../lib/restore/planner.js';
import { planTreeRestore } from '../lib/tree/restorePlan.js';
import { mixedPrepared } from '../lib/approval/mixedDecision.js';
import { performRestore, queueRestore } from './restoreActions.js';
import { meetsAssurance, effectiveAssurance } from '../lib/approval/levels.js';
import { activeBaseline } from '../db/baselineStore.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';
import { isEligible } from '../lib/reviewer.js';
import { baselineDecisionMeaning } from '../lib/approval/challenge.js';
import { enqueueVaultJobs } from '../lib/vaultQueue.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
import api, { route } from '@forge/api';
import { linkDecisionJobs } from '../lib/approval/linkPropagation.js';
import { enqueueLinkDecisions } from '../lib/linkQueue.js';
import { markLinkDecisionsPending, clearLinkDecisionPending } from '../db/linkPendingStore.js';
import { prepareApprovalLinkPolicy } from '../lib/approval/linkPolicy.js';
import { baselineLinkPolicy, hydrateLinkPolicyIssue } from '../lib/linkPolicy.js';

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

/**
 * The comment a rejection leaves on the work item. It is posted BEFORE the
 * restore runs. A tree restore is only queued then and may still finish
 * PARTIAL or FAILED. Report that it started rather than claiming completion.
 * The outcome is on the panel and in the ledger.
 */
export function rejectionComment(actorName) {
  const text = `Electronic signature review rejected by ${actorName}. The approved content is being restored; `
    + 'the VAtlassian panel on this work item shows the result.';
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

export async function releaseFailedApproval({ locked, issueId, diff, driftCount, error, release, now = Date.now() }) {
  if (!locked || error?.retainRestoreLock) return;
  await release({ issueId, state: 'ERROR', now,
    counters: { ...undecidedCounters(diff), driftCount } });
}

/** Called internally by the sole approval writer; no approval is inserted here. */
export async function prepareApproval({ issue, actor, decision, expectedEvidenceHash, forTransition = false, transition = null, allowBusy = false, decisions, linkPolicy, now = Date.now() }) {
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
    // Drift decisions do not require a review status. The item is
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
    // A per-field decision is planned against the server's own reading of the
    // drift: exact coverage, restorability and the restore plan for the rejected
    // fields only (lib/approval/mixedDecision.js). The browser's list is never used.
    const mixed = decision === 'MIXED' ? mixedPrepared({ decisions, prepared }) : null;
    const result = decide({
      decision,
      diff: decisionDiff,
      plan,
      evidenceHash: expectedEvidenceHash,
      approvedCount: mixed?.approvedIds.length ?? null
    });
    if (!result.allow) fail(result.reason);
    prepared.plan = plan;
    if (mixed) prepared.mixed = mixed;
  } else if (decision === 'REJECT' || decision === 'MIXED') fail('NO_BASELINE');
  return prepareApprovalLinkPolicy(prepared, { decision, linkPolicy });
}

/**
 * The links this item's standing record held before this approval: [] when it
 * had no record, null when they cannot be read (which decides nothing about
 * the other ends). A tree keeps them on its root node; the snapshot has read
 * that tree already, so this costs no read.
 */
function linksBefore(checked) {
  if (!checked.baseline) return [];
  if (checked.baseline.tree_hash) {
    const root = (checked.baselineTree?.nodes ?? []).find(node => node.parentLogicalNodeId == null);
    const links = root ? checked.baselineTree.values?.[root.logicalNodeId]?.issuelinks : undefined;
    return Array.isArray(links) ? links : null;
  }
  return Array.isArray(checked.baselineValues?.issuelinks) ? checked.baselineValues.issuelinks : null;
}

/**
 * Apply one decision per link change (lib/approval/linkPropagation.js). A link this
 * approval accepted or dropped is also recorded on the issue at its other end,
 * by jobs/linkWorker.js, off this approval's time budget. Queued, never
 * awaited to completion; a queue failure is audited and never fails the
 * decision, whose own baseline is already durable.
 */
async function queueLinkDecisions({ checked, approval, actor }) {
  const before = linksBefore(checked);
  const after = checked.issue?.fields?.issuelinks ?? [];
  if (!Array.isArray(before)) return;
  const hydrated = await hydrateLinkPolicyIssue({ ...checked.issue, fields: { ...checked.issue.fields,
    issuelinks: [...before, ...after] } }, checked.linkPolicy);
  const links = hydrated.fields.issuelinks;
  const jobs = linkDecisionJobs({
    issue: { ...checked.issue, id: checked.issueId, key: checked.issue.key }, linkPolicy: checked.linkPolicy,
    tracksLinks: (checked.fields ?? []).some(field => field.field_id === 'issuelinks'),
    before: links.slice(0, before.length),
    after: links.slice(before.length),
    approval: { approvalId: Buffer.from(approval.approval_id).toString('base64'), accountId: actor.accountId,
      displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
      assuranceLevel: approval.assurance_level, signerRole: approval.signer_role ?? null }
  });
  if (!jobs.length) return;
  // Marked before queueing, so the other issue explains itself from the first
  // moment (db/linkPendingStore.js). Best effort: the marker only explains.
  await markLinkDecisionsPending(jobs, Date.now()).catch(error =>
    console.error('applyApproval: could not mark link decisions pending', error));
  let failed;
  try {
    ({ failed } = await enqueueLinkDecisions(jobs));
  } catch (error) {
    failed = jobs.map(body => ({ body, error }));
  }
  for (const { body, error } of failed) {
    await clearLinkDecisionPending({ issueId: body.otherIssueId, decidedOnIssueId: body.issueId }).catch(() => {});
    console.error('applyApproval: could not queue a link decision', error);
    await tryAppend({ actorAccountId: actor.accountId, issueId: body?.otherIssueId,
      eventType: EVENT.LINK_DECISION_NOT_RECORDED,
      payload: { reason: 'QUEUE_FAILED', decidedOn: checked.issue.key, error: String(error?.message ?? error) } }).catch(() => {});
  }
}

/**
 * Hands each new baseline's attachments to the vault worker (jobs/vaultWorker.js)
 * through the queue so copying does not consume the approval time budget. One job
 * for the captured item and one for every child its capture baselined: a
 * child's files are restored from the vault like anyone else's, so they must
 * be in it. Each job carries the files that baseline recorded, so the vault
 * holds the set that was signed. Vaulting is defence in depth, not the record:
 * the baseline row already is. A queue failure is audited and never fails the
 * decision that captured the baseline.
 */
async function queueVaulting({ capture, checked, actor }) {
  const hex = id => Buffer.isBuffer(id) ? id.toString('hex') : String(id ?? '');
  const jobs = [
    { baselineId: hex(capture.baselineId), issueId: checked.issueId, issueKey: checked.issue.key,
      projectId: checked.projectId, attachments: capture.attachments },
    ...(capture.children ?? []).filter(child => child.issueKey && child.projectId).map(child => ({
      baselineId: hex(child.baselineId), issueId: child.issueId, issueKey: child.issueKey,
      projectId: child.projectId, attachments: child.attachments }))
  ];
  let failed;
  try {
    ({ failed } = await enqueueVaultJobs(jobs.map(job => ({ ...job,
      attachments: Array.isArray(job.attachments) ? job.attachments : undefined }))));
  } catch (error) {
    failed = jobs.map(body => ({ body, error }));
  }
  for (const { body, error } of failed) {
    console.error('applyApproval: could not queue attachment vaulting', error);
    await tryAppend({ actorAccountId: actor.accountId, issueId: body?.issueId, eventType: EVENT.VAULT_QUEUE_FAILED,
      payload: { baselineId: body?.baselineId, error: String(error?.message ?? error) } }).catch(() => {});
  }
}

/**
 * Captures and publishes the next tree baseline from the item's CURRENT state,
 * under the policy the standing baseline recorded. Shared by an approval that
 * ratifies drift and by a per-field decision, which captures only after its
 * rejected fields are verified back at their approved values. `readTree` lets
 * the restore worker, which has no user session, read as the app.
 */
export async function captureDriftBaseline({ checked, approval, actor, cause, readTree = null, expectedTreeHash = null }) {
  const { writeCapturedTreeBaseline } = await import('../lib/capture.js');
  const { readStableTree } = await import('../lib/tree/stableRead.js');
  const { planTreeCapture } = await import('../lib/tree/capturePlan.js');
  const { writeTreeCapture, publishTreeBaseline } = await import('../db/baselineTreeStore.js');
  const { tryAppend } = await import('../db/store.js');
  const { executeQuery } = await import('../lib/db.js');
  const { createTreeReader } = await import('../lib/tree/jira.js');
  const { testManagementExclusion } = await import('../testmgmt/treeExclusion.js');
  const forge = await import('@forge/api');
  return writeCapturedTreeBaseline({
    rootIssue: checked.issue,
    policy: checked.gate,
    approval: {
      accountId: actor.accountId,
      displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
      approvalId: approval.approval_id,
      assuranceLevel: approval.assurance_level,
      content_hash: approval.content_hash,
      linkPolicy: baselineLinkPolicy(approval),
    },
    controlledFields: checked.fields, ruleScope: checked.ruleScope, cause, expectedTreeHash,
    linkPolicyFor: approval.decision === 'MIXED' ? checked.linkPolicyFor : null,
    transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(),
    deps: {
      readTree: readTree ?? createTreeReader({ api: forge.default, route: forge.route, exclude: testManagementExclusion }).read,
      readStableTree,
      planTreeCapture,
      writeTreeCapture,
      publishTreeBaseline,
      tryAppend,
      executeQuery
    }
  });
}

/** Vault copy and other-end link records for a baseline just published. */
export async function publishBaselineSideEffects({ capture, checked, approval, actor }) {
  await queueVaulting({ capture, checked, actor });
  await queueLinkDecisions({ checked, approval, actor }).catch(error =>
    console.error('applyApproval: link decisions not queued', error));
}

/**
 * A per-field decision, applied under the lock applyApproval holds.
 *
 * Every field approved: the live state is the new baseline, captured now.
 * Any field rejected: the rejected fields are restored first, by the queue
 * worker, which verifies them and ONLY THEN captures the next baseline
 * (jobs/restoreWorker.js). Capturing here would re-approve a value the
 * reviewer explicitly rejected. No baseline exists until that worker succeeds.
 */
async function applyMixedDecision({ checked, approval, actor }) {
  const counts = { approved: checked.mixed.approvedIds.length, rejected: checked.mixed.rejectedIds.length };
  if (counts.rejected > 0) {
    const queued = await queueRestore({ prepared: checked, actor, approval, mixed: checked.mixed });
    return { ...queued, mixed: counts };
  }
  const capture = await captureDriftBaseline({ checked, approval, actor, cause: CAUSE.MIXED_DECISION });
  if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
  await publishBaselineSideEffects({ capture, checked, approval, actor });
  await markDecided({ issueId: checked.issueId, baselineVersion: checked.baseline.version, approvalId: approval.approval_id });
  return { success: true, capture, baselinePublished: true, mixed: counts };
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
  // A per-field decision re-derives its plan from the map the reviewer SIGNED
  // (the approval row), never from anything the caller passes now.
  const decisions = approval.decision === 'MIXED' ? JSON.parse(approval.decision_map) : undefined;
  let fresh = await prepareApproval({ issue, actor, decision: approval.decision, decisions,
    expectedEvidenceHash: resuming ? undefined : prepared?.evidenceHash, forTransition, transition, allowBusy: resuming,
    linkPolicy: baselineLinkPolicy(approval) });
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
  // approved baseline value. It relaxes content-hash equality while preserving the
  // eligibility, assurance and baseline-version checks around it.
  if (!resuming && approval.content_hash !== fresh.contentHash) fail('STALE_EVIDENCE');
  let locked = false;
  if (fresh.review) {
    const allowedStates = resuming ? ['DECIDING', 'ERROR', 'LOCKED'] : ['BASELINED', 'DRIFTED', 'ERROR'];
    const attempts = resuming ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await acquire({ issueId: fresh.issueId, expectedVersion: fresh.review.version,
        state: approval.decision === 'REJECT' || fresh.mixed?.rejectedIds.length ? 'RESTORING' : 'DECIDING',
        allowedStates, now: Date.now() });
      if (result.acquired) { locked = true; break; }
      if (!resuming || attempt === attempts - 1) fail('ALREADY_DECIDING');
      // A collector or an older observer may have advanced the CAS token
      // between the snapshot and this acquire. Re-read and retry once, but
      // keep the state allow-list so a live restore is never taken over.
      fresh = await prepareApproval({ issue, actor, decision: approval.decision, decisions,
        expectedEvidenceHash: undefined, forTransition, transition, allowBusy: true, linkPolicy: baselineLinkPolicy(approval) });
      assertPolicy(fresh);
    }
    if (!locked) fail(fresh.review?.state === 'RESTORING' ? 'RESTORE_IN_PROGRESS' : 'ALREADY_DECIDING');
  }
  try {
    // Re-read after the CAS: a concurrent edit must not be silently accepted.
    const checked = await prepareApproval({ issue, actor, decision: approval.decision, decisions,
      expectedEvidenceHash: fresh.evidenceHash, forTransition, transition, allowBusy: true, linkPolicy: baselineLinkPolicy(approval) });
    if (!resuming && checked.contentHash !== approval.content_hash) fail('STALE_EVIDENCE');
    if (approval.decision === 'MIXED') {
      if (checked.mixed?.mapHash !== approval.decision_map_hash || checked.mixed.planHash !== fresh.mixed?.planHash) fail('STALE_EVIDENCE');
      return await applyMixedDecision({ checked, approval, actor });
    }
    if (approval.decision === 'REJECT') {
      if (checked.baseline && checked.issue.fields.status?.id && String(checked.issue.fields.status.id) !== checked.baseline.from_status_id) {
        await api.asUser().requestJira(route`/rest/api/3/issue/${checked.issue.key}/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: rejectionComment(actor.displayName) })
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
    // A workflow transition approved here is the item's own transition; an
    // approval bound to its baseline is a drift decision.
    const cause = forTransition ? CAUSE.OWN_TRANSITION : CAUSE.DRIFT_DECISION;
    const capturesBaseline = [true, 1, '1'].includes(checked.gate?.capture_baseline);
    if (!transition || capturesBaseline) {
      if (capturesBaseline) {
        capture = await captureDriftBaseline({ checked, approval, actor, cause });
      } else {
        capture = await writeCapturedBaseline({ issueId: checked.issueId, issueKey: checked.issue.key,
          projectId: checked.projectId, issueTypeId: checked.issueTypeId, controlledFields: checked.fields,
          ruleScope: checked.ruleScope, cause, issueFields: checked.issue.fields, editmetaFields: checked.editmeta,
          transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(), capturedAt: Date.now(),
          approver: { accountId: actor.accountId, displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
            approvalId: approval.approval_id, assuranceLevel: approval.assurance_level, contentHash: approval.content_hash,
            linkPolicy: baselineLinkPolicy(approval) },
          // A standalone ratification does not select a new workflow policy.
          // Preserve the policy edge so the next review can resolve its authority;
          // the approval itself still records the actual, unchanged Jira status.
          transitionId: transition ? approval.transition_id : checked.baseline?.transition_id ?? null,
          fromStatusId: transition ? approval.from_status_id : checked.baseline?.from_status_id ?? checked.gate?.from_status_id ?? approval.from_status_id,
          toStatusId: transition ? approval.to_status_id : checked.baseline?.to_status_id ?? checked.gate?.to_status_id ?? approval.to_status_id,
          requiredRole: checked.gate?.required_role, requiredAssurance: checked.gate?.required_assurance,
          reviewerFieldId: checked.config.reviewerFieldId });
      }
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
      await publishBaselineSideEffects({ capture, checked, approval, actor });
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
