import { restoreErrorForViewer } from './viewerProjection.js';
import api, { route } from '@forge/api';
import { actorFrom, fail, respond } from './access.js';
import { availableTransitions } from '../lib/transitions.js';
import { gatedTransition } from '../db/configStore.js';
import { activeBaseline } from '../db/baselineStore.js';
import { getReview } from '../db/itemStateStore.js';
import { latestApproval, pendingApprovalForActor } from '../db/approvalStore.js';
import { adminIncidentCount } from '../db/incidentStore.js';
import { credentialState } from '../db/credentialStore.js';
import { isActiveAdmin } from '../db/adminStore.js';
import { restoresForIssue, restoreReaching } from '../db/restoreStore.js';
import { activeRootsForNode, rootNodeDigests, driftedDescendants, driftedDescendantsOfNode, capturingParent } from '../db/baselineTreeStore.js';
import { driftedAncestor, viewerAncestorDeps } from '../lib/ancestorHold.js';
import { isEligible } from '../lib/reviewer.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';
import { baselineDecisionMeaning } from '../lib/approval/challenge.js';
import { baselineDrift, logLiveDrift } from '../lib/liveDrift.js';
import { linkDecisionsPending } from '../db/linkPendingStore.js';
import { controlledFields } from '../db/configStore.js';
import { fieldsForItem } from '../lib/tree/nodeFields.js';
import { MATERIALITY } from '../lib/materiality.js';
import { canonicaliseIssue } from '../lib/attachmentIdentity.js';

/**
 * Read the panel's initial state using one Jira issue read and independent
 * indexed SQL reads in parallel. This path is narrower than panelAccess.js
 * snapshot() and must not call snapshot(), readStableTree(), fetchChangelog(),
 * readAllValues() or Jira editmeta. panelEvidence.js loads those details lazily.
 *
 * This result is for display. Every approval challenge, submit, retry,
 * transition and restore worker still performs a fresh authoritative read.
 */

/** Read issue identity and status without editmeta or full field expansion. */
export async function readIssueSummary({ payload = {}, context }) {
  actorFrom(context);
  const key = payload.issueKey ?? payload.issueId ?? context.extension?.issue?.key ?? context.extension?.issue?.id;
  if (!key) fail('ISSUE_REQUIRED');
  const response = await api.asUser().requestJira(
    // *all, because the summary derives the drift count from the content
    // itself rather than trusting a stored counter (see getSummary). This remains one
    // request. panel:getSummary must not read the tree, the
    // changelog, editmeta and retained baseline values, none of which this
    // widening touches.
    route`/rest/api/3/issue/${String(key)}?fields=*all`
  );
  if (!response.ok) fail('ISSUE_ACCESS_DENIED');
  const issue = await response.json();
  if (!issue.id || !issue.fields?.project?.id || !issue.fields?.issuetype?.id) fail('ISSUE_UNREADABLE');
  // The drift count below must read a restored file as the approved original,
  // exactly as the validator does, or the two would disagree about drift.
  return canonicaliseIssue(issue);
}

/** A baseline with incomplete provenance (recorded before Task 4's migration)
 *  cannot authorise a drift decision. Summary must degrade, never throw. */
function safeBaselinePolicy(baseline) {
  if (!baseline) return null;
  try { return baselinePolicy(baseline); } catch { return null; }
}

/**
 * Describe an offered controlled transition for every viewer.
 *
 * lib/journey.js resolveActions() filters actions to those the current view can
 * perform. The summary instead shows every controlled edge's role, meaning and
 * scope, and uses canApprove to control access. Spec 5.2 requires ineligible
 * viewers to see the same control summary and required role without an enabled
 * decision control.
 */
function describeTransitionForViewer(transition, gate, eligible) {
  const toName = transition.toStatusName || gate.to_status_id || 'the next status';
  return {
    transitionId: String(transition.id),
    toStatusId: String(transition.toStatusId ?? gate.to_status_id ?? ''),
    toStatusName: transition.toStatusName ?? null,
    name: transition.name ?? null,
    meaning: gate.meaning ?? 'Approved',
    requiredRole: gate.required_role ?? null,
    requiredAssurance: gate.required_assurance ?? null,
    capturesBaseline: gate.capture_baseline === true,
    anyStatus: gate.matched_any_status === true,
    label: `Sign to move to ${toName}`,
    canApprove: eligible === true
  };
}

/**
 * The stranded approval, only if retrying it could actually work.
 *
 * retryTransition resolves the transition by id and requires its to-status to
 * match the signed row. Offering a button certain to fail is worse than no
 * button, so it is advertised only when the viewer-visible transition list
 * still contains it.
 */
export function pendingApprovalSummary(row, transitions) {
  if (!row?.approval_id || !row.transition_id) return null;
  const offered = transitions.some(t => t.transitionId === String(row.transition_id)
    && String(t.toStatusId) === String(row.to_status_id));
  if (!offered) return null;
  return { approvalId: Buffer.from(row.approval_id).toString('hex'),
    transitionId: String(row.transition_id), state: row.state, expiresAt: Number(row.expires_at) };
}

/** The nearest ancestor holding this item, or null. Never throws: the panel degrades, the validator decides. */
async function heldFromAbove(issue, projectId) {
  if (!issue.fields?.parent?.key) return null;
  try {
    const deps = await viewerAncestorDeps();
    if ((await deps.projectConfig(projectId))?.enabled === false) return null;
    return await driftedAncestor(issue, deps, { surface: 'panel-ancestor' });
  } catch (error) {
    console.error('panelSummary: the work items above could not be read', error?.message ?? error);
    return null;
  }
}

export async function getSummary(args) { return respond(async () => {
  const [issue, myself] = await Promise.all([
    readIssueSummary(args),
    api.asUser().requestJira(route`/rest/api/3/myself`).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  const actor = { ...actorFrom(args.context), displayName: myself?.displayName ?? null };
  const issueId = Number(issue.id);
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const fromStatusId = String(issue.fields.status?.id ?? '');
  const statusCategory = issue.fields.status?.statusCategory?.key?.toLowerCase();
  const isDone = statusCategory === 'done' || issue.fields.status?.name?.toLowerCase() === 'done';

  const [available, baseline, review, approval, pendingRow, credentialEnrolled, isAdmin, restores,
    reachedBy, governingRoots, declared] = await Promise.all([
    availableTransitions(api, issue.key),
    activeBaseline(issueId),
    getReview(issueId),
    latestApproval(issueId),
    pendingApprovalForActor({ issueId, accountId: actor.accountId, fromStatusId }).catch(() => null),
    credentialState(actor.accountId).then(row => row?.state === 'ACTIVE').catch(() => undefined),
    isActiveAdmin(actor.accountId).catch(() => false),
    restoresForIssue(issueId, 1).catch(() => []),
    // A parent's restore writes to its children under the parent's signature;
    // the child's own restores never show that.
    restoreReaching(issueId).catch(() => null),
    // Governed-by-coverage, for a work item that is a node inside a parent's
    // tree baseline and therefore has no va_baseline row of its own.
    activeRootsForNode(issueId).catch(() => []),
    // The declared tracked set, so drift can be derived from the content
    // rather than read off a counter. One indexed read, no Jira call.
    fieldsForItem({ issueId, projectId, issueTypeId }, { activeRootsForNode, controlledFields }).catch(() => [])
  ]);

  // Never offer a transition to the same status, and never offer any once the
  // item is done, matching panel.js's existing rule.
  const validTransitions = isDone ? [] : available.filter(t => String(t.toStatusId) !== fromStatusId);
  const gateResults = await Promise.all(
    validTransitions.map(transition => gatedTransition({ projectId, issueTypeId,
      fromStatusId, toStatusId: transition.toStatusId, transitionId: transition.id }))
  );
  const eligibilityResults = await Promise.all(
    gateResults.map(gate => gate ? isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: gate.required_role }) : false)
  );

  const gated = [];
  for (let i = 0; i < validTransitions.length; i++) {
    const gate = gateResults[i];
    if (!gate) continue;
    if (validTransitions[i].isAvailable === false) continue;
    gated.push({ transition: validTransitions[i], gate, eligible: eligibilityResults[i] === true });
  }
  const gatedCount = gated.length;
  const anyEligible = gated.some(g => g.eligible);
  const transitions = gated.map(g => describeTransitionForViewer(g.transition, g.gate, g.eligible));

  const policy = safeBaselinePolicy(baseline);

  // Derive drift from current issue content. Previously review.drift_count
  // could disagree with the signed digests: VJIRA-17 showed zero in storage
  // while the issue had changed, leaving its visible drift undecidable.
  //
  // Use the collector's driftedFields comparison (lib/interception.js) and
  // the validator's baselineDrift check so both agree with the panel.
  // va_drift retains who changed what and when as evidence, but its rows do
  // not determine whether current content differs from the baseline.
  const comparison = await baselineDrift({ baseline, issueId, issueFields: issue.fields, declared,
    readRootDigests: rootNodeDigests });
  const drifted = comparison.changed;
  const driftCount = drifted.length;
  logLiveDrift('panel-summary', { issueKey: issue.key, issueTypeId: issue.fields?.issuetype?.id, comparison });
  // Read materiality from declared rows, the only source available here.
  // classifying by value would need the retained baseline values, and reading
  // those is exactly what panel:getSummary must not do.
  const materialityOf = new Map((declared ?? []).map(f => [f.field_id, f.materiality]));
  const materialCount = drifted.filter(id => (materialityOf.get(id) ?? MATERIALITY.MAJOR) !== MATERIALITY.COSMETIC).length;
  // Children awaiting a decision. Each child a parent's capture reached carries its own
  // baseline and is held and decided in its own right; a parent decision
  // covers them all (re-baselines or restores every child), so it is offered
  // here too while any is drifted. The parent itself is not held by them:
  // `driftCount` stays its own fields. Both reads are single indexed rows.
  //
  // Propagate the flag to every ancestor, not only the tree root: a child captured
  // by its parent counts the drifted items under it in the parent's signed
  // tree (driftedDescendantsOfNode), the same subtree its decision covers.
  //
  // Ancestor hold: an item whose own content is unchanged is still held by
  // the validator while an issue above it has undecided drift
  // (lib/ancestorHold.js). Shown here so the hold names where to decide it;
  // display only, the validator reads for itself.
  const [childrenAwaiting, capturedBy, heldBy] = await Promise.all([
    baseline?.tree_hash ? driftedDescendants(baseline.baseline_id).catch(() => 0)
      : baseline?.captured_by_baseline_id
        ? Promise.resolve().then(() => driftedDescendantsOfNode(baseline.captured_by_baseline_id, issueId)).catch(() => 0)
        : 0,
    baseline?.captured_by_baseline_id ? capturingParent(baseline.captured_by_baseline_id).catch(() => null) : null,
    driftCount > 0 ? null : heldFromAbove(issue, projectId)
  ]);
  // A link approved on the other end, on its way to this record
  // (jobs/linkWorker.js): the panel says so and re-reads until it lands.
  const linkPending = drifted.includes('issuelinks') ? await linkDecisionsPending(issueId).catch(() => []) : [];
  const pendingDrift = Boolean(baseline) && (driftCount > 0 || childrenAwaiting > 0);
  const policyIncomplete = pendingDrift && !policy;

  // Check the viewer's role independently of the drift count. Previously,
  // pendingDrift short-circuited isEligible() when stored drift_count was zero.
  // The client could then display a live re-diff and deny a qualified reviewer.
  // VJIRA-17 showed "1 change since approval" and "only Reviewer can decide
  // them" to a person who held Reviewer but whose role had not been checked.
  // One indexed role read per baselined issue lets the client combine its
  // displayed count with the actual permission result.
  const isOriginalApprover = Boolean(baseline) && baseline?.approved_by === actor.accountId;
  const baselineEligible = baseline && policy
    ? (isOriginalApprover || await isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: policy.requiredRole }))
    : false;

  // Unchanged: what the SERVER is prepared to assert on its own evidence.
  const decidesDrift = pendingDrift && baselineEligible;
  const tier = (anyEligible || decidesDrift) ? 'actor' : 'observer';

  let livingState = 'Waiting on signature';
  if (heldBy) {
    livingState = `Held: ${heldBy.issueKey}, above this work item, has changes awaiting a decision there`;
  } else if (decidesDrift && driftCount === 0) {
    livingState = `${childrenAwaiting === 1 ? '1 child work item has' : `${childrenAwaiting} child work items have`} changes awaiting a decision`;
  } else if (decidesDrift) {
    livingState = 'Changes since approval need a decision';
  } else if (policyIncomplete) {
    livingState = 'A change needs a decision, but the rule that signed this content is incomplete. An administrator has been notified.';
  } else if (pendingDrift) {
    const role = policy?.requiredRole ?? gated.find(g => g.gate.required_role)?.gate.required_role;
    livingState = role ? `Waiting on a signature from ${role}` : 'Waiting on a signature from the required role';
  } else if (isDone) {
    livingState = 'Work item is completed.';
  } else if (gatedCount === 0) {
    livingState = 'Nothing needs a signature at this status';
  } else if (!anyEligible) {
    const blockedGate = gated.find(g => g.gate.required_role);
    livingState = blockedGate?.gate.required_role
      ? `Waiting on a signature from ${blockedGate.gate.required_role}`
      : 'Waiting on a signature from the required role';
  }

  const restore = restores[0] ? {
    // RestoreStatus may need this summary value before its detailed restore
    // rows arrive. Keep the same base64 identifier the retry resolver reads.
    restoreId: Buffer.from(restores[0].restore_id).toString('base64'),
    state: restores[0].state,
    attempted: Number(restores[0].attempted ?? 0),
    succeeded: Number(restores[0].succeeded ?? 0),
    failed: Number(restores[0].failed ?? 0),
    skipped: Number(restores[0].skipped ?? 0),
    jobId: restores[0].job_id ?? null,
    queuedAt: restores[0].queued_at != null ? Number(restores[0].queued_at) : null,
    finishedAt: restores[0].finished_at != null ? Number(restores[0].finished_at) : null,
    baselineVersion: restores[0].baseline_version != null ? Number(restores[0].baseline_version) : null,
    heartbeatAt: restores[0].heartbeat_at != null ? Number(restores[0].heartbeat_at) : null,
    totalSteps: Number(restores[0].total_steps ?? 0),
    completedSteps: Number(restores[0].completed_steps ?? 0),
    lastCheckpoint: restores[0].last_checkpoint != null ? Number(restores[0].last_checkpoint) : null,
    lastError: restoreErrorForViewer(restores[0].last_error)
  } : null;

  const restoredVia = reachedBy ? {
    restoreId: Buffer.from(reachedBy.restore_id).toString('hex'),
    parentIssueId: Number(reachedBy.parent_issue_id),
    parentIssueKey: reachedBy.parent_issue_key ?? null,
    state: reachedBy.state,
    finishedAt: reachedBy.finished_at != null ? Number(reachedBy.finished_at) : null,
    baselineVersion: reachedBy.baseline_version != null ? Number(reachedBy.baseline_version) : null
  } : null;

  const payload = {
    issue: { id: String(issue.id), key: issue.key, summary: issue.fields.summary ?? '', status: issue.fields.status },
    controlled: Boolean(baseline) || gatedCount > 0,
    tier,
    state: livingState,
    actorName: actor.displayName,
    eligibility: { eligible: tier === 'actor', reason: null },
    credentialEnrolled,
    transitions,
    baseline: baseline ? {
      baselineId: Buffer.from(baseline.baseline_id).toString('hex'),
      version: Number(baseline.version),
      approvedName: baseline.approved_name ?? null,
      transitionAt: baseline.transition_at != null ? Number(baseline.transition_at) : null,
      capturedAt: baseline.captured_at != null ? Number(baseline.captured_at) : null,
      assuranceLevel: baseline.assurance_level ?? null,
      fidelity: baseline.fidelity ?? null,
      nodeCount: Number(baseline.node_count ?? 1),
      edgeCount: Number(baseline.edge_count ?? 0),
      totalFieldCount: Number(baseline.total_field_count ?? baseline.field_count ?? 0),
      treeHash: baseline.tree_hash ?? null,
      policyIncomplete: !policy,
      capturedBy: capturedBy ? { issueKey: capturedBy.issueKey, version: capturedBy.version } : null
    } : null,
    // The approval that governs this work item when it has no baseline of its
    // own: it is a node inside a parent's tree baseline. Named here so an
    // auditor can answer "who approved this?" from the record itself rather
    // than having to know which hierarchy it belongs to.
    coveredBy: (baseline ? [] : governingRoots ?? []).map(cover => ({
      rootIssueKey: cover.rootIssueKey ?? null,
      version: cover.version,
      approvedName: cover.approvedName ?? null,
      approvedBy: cover.approvedBy ?? null,
      capturedAt: cover.capturedAt,
      transitionAt: cover.transitionAt,
      assuranceLevel: cover.assuranceLevel ?? null,
      requiredRole: cover.requiredRole ?? null,
      treeHash: cover.treeHash ?? null
    })),
    latestApproval: approval ? {
      decision: approval.decision,
      state: approval.state,
      actorName: approval.printed_name ?? approval.actor_name ?? null,
      decidedAt: approval.decided_at != null ? Number(approval.decided_at) : null,
      transitionId: approval.transition_id ?? null
    } : null,
    drift: { count: driftCount, materialCount, childrenAwaiting, decidesDrift, policyIncomplete, linkPending,
      heldBy: heldBy ? { issueKey: heldBy.issueKey, issueId: heldBy.issueId, depth: heldBy.depth } : null,
      // Whether this viewer COULD decide drift on this baseline, independent of
      // whether the stored counter currently shows any. The client needs both.
      eligible: baselineEligible,
      canApprove: decidesDrift, canReject: decidesDrift },
    // The review row's version increments on every re-observation, separately
    // from baselineVersion, so usePanelEvidence can key its cache
    // on "has the current-record evidence itself moved" rather than only on
    // whether the baseline changed.
    evidenceVersion: review?.version != null ? Number(review.version) : null,
    // Use the content identity so the panel's heavy evidence read can be
    // keyed on what the item actually says rather than on a row version that
    // only moves when the collector writes. A change the collector has not
    // recorded yet still changes this, which is what makes the panel react to
    // an edit instead of waiting for a trigger to catch up.
    contentHash: comparison.contentHash ?? null,
    restore,
    restoredVia,
    approval: {
      requiredRole: policy?.requiredRole ?? transitions.find(t => t.requiredRole)?.requiredRole ?? null,
      requiredAssurance: policy?.requiredAssurance ?? transitions.find(t => t.canApprove)?.requiredAssurance ?? null,
      meaning: pendingDrift
        ? (policy ? baselineDecisionMeaning('APPROVE', policy.version) : null)
        : (transitions.find(t => t.canApprove)?.meaning ?? null),
      // Retry is only ever offered against a transition THIS viewer is
      // currently eligible for. retryTransition() rechecks eligibility and
      // refuses otherwise, so matching against every described transition
      // (eligible or not) would advertise a button certain to fail.
      pending: pendingApprovalSummary(pendingRow, transitions.filter(t => t.canApprove))
    }
  };

  if (isAdmin) {
    try { payload.adminIncidentCount = await adminIncidentCount({ issueId, projectId, issueTypeId }); }
    catch { payload.adminIncidentUnavailable = true; }
  }

  return payload;
}); }
