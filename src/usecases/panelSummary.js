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
import { restoresForIssue } from '../db/restoreStore.js';
import { activeRootsForNode, rootNodeDigests } from '../db/baselineTreeStore.js';
import { isEligible } from '../lib/reviewer.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';
import { baselineDecisionMeaning } from '../lib/approval/challenge.js';
import { baselineDrift } from '../lib/liveDrift.js';
import { controlledFields } from '../db/configStore.js';
import { MATERIALITY } from '../lib/materiality.js';

/**
 * THE COMPACT READ — everything the panel needs to paint immediately.
 *
 * Deliberately narrower than panelAccess.js's snapshot(): one Jira read of the
 * issue's own fields and a handful of indexed, independent SQL
 * reads run in parallel. It must never call snapshot(), readStableTree(),
 * fetchChangelog(), readAllValues(), or ask Jira for editmeta — those are
 * panelEvidence.js's job, loaded lazily. This is presentation only: every
 * approval challenge, submit, retry, transition, and restore worker performs
 * its own fresh authoritative read regardless of what this returns.
 */

/** Narrow issue identity/status read — no editmeta, no full field expansion. */
export async function readIssueSummary({ payload = {}, context }) {
  actorFrom(context);
  const key = payload.issueKey ?? payload.issueId ?? context.extension?.issue?.key ?? context.extension?.issue?.id;
  if (!key) fail('ISSUE_REQUIRED');
  const response = await api.asUser().requestJira(
    // *all, because the summary derives the drift count from the content
    // itself rather than trusting a stored counter (see getSummary). Still ONE
    // request — the boundary panel:getSummary must not cross is the tree, the
    // changelog, editmeta and retained baseline values, none of which this
    // widening touches.
    route`/rest/api/3/issue/${String(key)}?fields=*all`
  );
  if (!response.ok) fail('ISSUE_ACCESS_DENIED');
  const issue = await response.json();
  if (!issue.id || !issue.fields?.project?.id || !issue.fields?.issuetype?.id) fail('ISSUE_UNREADABLE');
  return issue;
}

/** A baseline with incomplete provenance (recorded before Task 4's migration)
 *  cannot authorise a drift decision. Summary must degrade, never throw. */
function safeBaselinePolicy(baseline) {
  if (!baseline) return null;
  try { return baselinePolicy(baseline); } catch { return null; }
}

/**
 * One offered, gated transition described for EVERY viewer — eligible or not.
 *
 * Unlike lib/journey.js's resolveActions() (which narrows to what THIS surface
 * can actually carry out and drops the rest), the panel summary's shared
 * viewer projection shows every controlled edge's role/meaning/scope to every
 * viewer and only toggles `canApprove` — see spec 5.2: "Ineligible viewers see
 * the same control summary and the role that is required, but no enabled
 * decision control."
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
    governingRoots, declared] = await Promise.all([
    availableTransitions(api, issue.key),
    activeBaseline(issueId),
    getReview(issueId),
    latestApproval(issueId),
    pendingApprovalForActor({ issueId, accountId: actor.accountId, fromStatusId }).catch(() => null),
    credentialState(actor.accountId).then(row => row?.state === 'ACTIVE').catch(() => undefined),
    isActiveAdmin(actor.accountId).catch(() => false),
    restoresForIssue(issueId, 1).catch(() => []),
    // Governed-by-coverage, for a work item that is a node inside a parent's
    // tree baseline and therefore has no va_baseline row of its own.
    activeRootsForNode(issueId).catch(() => []),
    // The declared tracked set, so drift can be derived from the content
    // rather than read off a counter. One indexed read, no Jira call.
    controlledFields({ projectId, issueTypeId }).catch(() => [])
  ]);

  // Never offer a transition to the same status, and never offer any once the
  // item is done — same rule panel.js has always applied.
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

  // DRIFT IS DERIVED FROM THE CONTENT, AT THE ISSUE LEVEL.
  //
  // This read `review.drift_count` — a counter written by the collector and
  // zeroed by the decision paths. That made it a second answer to a question
  // the content already settles, and the two came apart: on VJIRA-17 the row
  // said 0 while the item genuinely differed from the digests its signature
  // covers, so the panel rendered a change nobody was allowed to decide.
  //
  // driftedFields() is the same function the collector uses (lib/interception.js),
  // so the summary and the collector cannot reach different verdicts. The drift
  // rows in va_drift remain the durable EVIDENCE — who changed what, when — but
  // they are no longer what decides whether drift exists.
  //
  // baselineDrift() is also what the validator holds a transition on, so the
  // panel can always decide whatever the validator is holding the item for.
  const comparison = await baselineDrift({ baseline, issueId, issueFields: issue.fields, declared,
    readRootDigests: rootNodeDigests });
  const drifted = comparison.changed;
  const driftCount = drifted.length;
  // Materiality comes from the declared rows, which is all this path has —
  // classifying by value would need the retained baseline values, and reading
  // those is exactly what panel:getSummary must not do.
  const materialityOf = new Map((declared ?? []).map(f => [f.field_id, f.materiality]));
  const materialCount = drifted.filter(id => (materialityOf.get(id) ?? MATERIALITY.MAJOR) !== MATERIALITY.COSMETIC).length;
  const pendingDrift = Boolean(baseline) && driftCount > 0;
  const policyIncomplete = pendingDrift && !policy;

  // ELIGIBILITY IS A FACT ABOUT THE VIEWER, NOT ABOUT THE COUNTER.
  //
  // This used to be gated behind `pendingDrift`, so when `drift_count` read 0
  // the `&&` short-circuited and isEligible() was never called. That was fine
  // while the panel rendered the same number — but it does not: the client
  // substitutes the live re-diff for display (IssuePanel.tsx), and on VJIRA-17
  // the two disagreed. The viewer was shown "1 change since approval" and told
  // "only Reviewer can decide them" while holding Reviewer, because the role
  // had never been checked and the message is a fallback.
  //
  // Answering it unconditionally costs one indexed read on an item that has a
  // baseline, and it lets the client pair permission with whichever count it is
  // actually displaying instead of inheriting a verdict about a different one.
  const isOriginalApprover = Boolean(baseline) && baseline?.approved_by === actor.accountId;
  const baselineEligible = baseline && policy
    ? (isOriginalApprover || await isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: policy.requiredRole }))
    : false;

  // Unchanged: what the SERVER is prepared to assert on its own evidence.
  const decidesDrift = pendingDrift && baselineEligible;
  const tier = (anyEligible || decidesDrift) ? 'actor' : 'observer';

  let livingState = 'Waiting on signature';
  if (decidesDrift) {
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
    restoreId: Buffer.from(restores[0].restore_id).toString('hex'),
    state: restores[0].state,
    attempted: Number(restores[0].attempted ?? 0),
    succeeded: Number(restores[0].succeeded ?? 0),
    failed: Number(restores[0].failed ?? 0),
    skipped: Number(restores[0].skipped ?? 0),
    jobId: restores[0].job_id ?? null,
    queuedAt: restores[0].queued_at != null ? Number(restores[0].queued_at) : null,
    heartbeatAt: restores[0].heartbeat_at != null ? Number(restores[0].heartbeat_at) : null,
    totalSteps: Number(restores[0].total_steps ?? 0),
    completedSteps: Number(restores[0].completed_steps ?? 0),
    lastCheckpoint: restores[0].last_checkpoint != null ? Number(restores[0].last_checkpoint) : null,
    lastError: restores[0].last_error ?? null
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
      policyIncomplete: !policy
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
    drift: { count: driftCount, materialCount, decidesDrift, policyIncomplete,
      // Whether this viewer COULD decide drift on this baseline, independent of
      // whether the stored counter currently shows any. The client needs both.
      eligible: baselineEligible,
      canApprove: decidesDrift, canReject: decidesDrift },
    // The review row's own version counter — bumped on every re-observation,
    // independent of baselineVersion — so usePanelEvidence can key its cache
    // on "has the current-record evidence itself moved" rather than only on
    // whether the baseline changed.
    evidenceVersion: review?.version != null ? Number(review.version) : null,
    // THE CONTENT'S OWN IDENTITY, so the panel's heavy evidence read can be
    // keyed on what the item actually says rather than on a row version that
    // only moves when the collector writes. A change the collector has not
    // recorded yet still changes this, which is what makes the panel react to
    // an edit instead of waiting for a trigger to catch up.
    contentHash: comparison.contentHash ?? null,
    restore,
    approval: {
      requiredRole: policy?.requiredRole ?? transitions.find(t => t.requiredRole)?.requiredRole ?? null,
      requiredAssurance: policy?.requiredAssurance ?? transitions.find(t => t.canApprove)?.requiredAssurance ?? null,
      meaning: pendingDrift
        ? (policy ? baselineDecisionMeaning('APPROVE', policy.version) : null)
        : (transitions.find(t => t.canApprove)?.meaning ?? null),
      // Retry is only ever offered against a transition THIS viewer is
      // currently eligible for — retryTransition() re-checks eligibility and
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
