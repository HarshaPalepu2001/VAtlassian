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
import { isEligible } from '../lib/reviewer.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';
import { baselineDecisionMeaning } from '../lib/approval/challenge.js';

/**
 * THE COMPACT READ — everything the panel needs to paint immediately.
 *
 * Deliberately narrower than panelAccess.js's snapshot(): one Jira read for
 * `project,issuetype,status,summary` and a handful of indexed, independent SQL
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
    route`/rest/api/3/issue/${String(key)}?fields=project,issuetype,status,summary`
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
    blocksOnDrift: gate.block_on_drift === true,
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

  const [available, baseline, review, approval, pendingRow, credentialEnrolled, isAdmin, restores] = await Promise.all([
    availableTransitions(api, issue.key),
    activeBaseline(issueId),
    getReview(issueId),
    latestApproval(issueId),
    pendingApprovalForActor({ issueId, accountId: actor.accountId, fromStatusId }).catch(() => null),
    credentialState(actor.accountId).then(row => row?.state === 'ACTIVE').catch(() => undefined),
    isActiveAdmin(actor.accountId).catch(() => false),
    restoresForIssue(issueId, 1).catch(() => [])
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
  const driftCount = baseline ? Number(review?.drift_count ?? 0) : 0;
  const materialCount = baseline ? Number(review?.drifted_field_count ?? 0) : 0;
  const pendingDrift = Boolean(baseline) && driftCount > 0;
  const policyIncomplete = pendingDrift && !policy;
  const baselineEligible = pendingDrift && policy
    ? await isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: policy.requiredRole })
    : false;
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
    skipped: Number(restores[0].skipped ?? 0)
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
    latestApproval: approval ? {
      decision: approval.decision,
      state: approval.state,
      actorName: approval.printed_name ?? approval.actor_name ?? null,
      decidedAt: approval.decided_at != null ? Number(approval.decided_at) : null,
      transitionId: approval.transition_id ?? null
    } : null,
    drift: { count: driftCount, materialCount, decidesDrift, policyIncomplete,
      canApprove: decidesDrift, canReject: decidesDrift },
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

  if (isAdmin) payload.adminIncidentCount = await adminIncidentCount({ issueId, projectId, issueTypeId });

  return payload;
}); }
