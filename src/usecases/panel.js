import api from '@forge/api';
import { load, respond, actorFrom, fail } from './panelAccess.js';
import { getReview } from '../db/itemStateStore.js';
import { baselineHistory } from '../db/baselineStore.js';
import { buildRecord } from '../lib/record.js';
import { availableTransitions } from '../lib/transitions.js';
import { gatedTransition } from '../db/configStore.js';
import { isEligible } from '../lib/reviewer.js';
import { approvalById, pendingApprovalForActor } from '../db/approvalStore.js';
import { issueControlStatus } from '../db/incidentStore.js';
import { credentialState } from '../db/credentialStore.js';
import { isActiveAdmin } from '../db/adminStore.js';
import { resolveActions, tierFor, BLOCKER } from '../lib/journey.js';

export async function getState(args) { return respond(async () => {
  const state = await load(args);
  const { issue, baseline, actor, projectId, issueTypeId } = state;
  const [history, available, approvalRecord, controls, stranded, credential, isAdmin] = await Promise.all([
    baselineHistory(state.issueId), availableTransitions(api, issue.key),
    baseline?.approval_id ? approvalById(baseline.approval_id) : null,
    issueControlStatus({ issueId: state.issueId, projectId, issueTypeId }).catch(() => ({ unavailable: true, incidents: [], gateFindings: [] })),
    // A recorded approval whose Jira transition did not land. Held in component
    // state by the panel, which does not survive a reload — so without this the
    // reviewer's only route back to approval:retryTransition disappears.
    pendingApprovalForActor({ issueId: state.issueId, accountId: actor.accountId,
      fromStatusId: String(issue.fields.status?.id) }).catch(() => null),
    // Whether this reviewer can sign at all. Unreadable is left `undefined`
    // rather than false: telling an enrolled signer to go and enrol is worse
    // than saying nothing, and the panel's notice keys on `=== false`.
    credentialState(actor.accountId).then(row => row?.state === 'ACTIVE').catch(() => undefined),
    isActiveAdmin(actor.accountId).catch(() => false)
  ]);
  const fromStatusId = String(issue.fields.status?.id ?? '');
  const statusCategory = issue.fields.status?.statusCategory?.key?.toLowerCase();
  const isDone = statusCategory === 'done' || issue.fields.status?.name?.toLowerCase() === 'done';

  // Do not offer transitions if the work item is already completed (Done/Closed),
  // and never offer transitions to the same status the issue is currently in.
  const validTransitions = isDone
    ? []
    : available.filter(t => String(t.toStatusId) !== fromStatusId);

  // Look up all gates in parallel, then check eligibility for confirmed gates
  // in parallel. The original serial for-loop did await gatedTransition() +
  // await isEligible() per transition, costing 2×N sequential round trips.
  // Promise.all fires them all at once; the memo in gatedTransition / getConfig
  // means most will be served from the in-process cache.
  const gateResults = await Promise.all(
    validTransitions.map((transition) =>
      gatedTransition({ projectId, issueTypeId,
        fromStatusId, toStatusId: transition.toStatusId, transitionId: transition.id })
    )
  );
  const eligibilityResults = await Promise.all(
    gateResults.map((gate) =>
      gate ? isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: gate.required_role }) : false
    )
  );

  const { actions, gatedCount, blocker } = resolveActions({
    offered: validTransitions,
    gates: gateResults,
    eligible: eligibilityResults,
    surface: 'panel'
  });
  // A change since approval is its own call to action, and it is not a workflow
  // move. `state.eligible` is authority over THIS item's baseline edge, already
  // resolved by snapshot() — an item can sit for weeks in a status no rule
  // fires out of and still carry a change somebody has to decide.
  const pendingDrift = Boolean(state.baseline) && (state.diff?.changedFieldCount ?? 0) > 0;
  const decidesDrift = pendingDrift && state.eligible === true;
  const tier = tierFor(actions, { decidesDrift });

  // TEMPORARY DIAGNOSTIC — remove once the missing-controls report is closed.
  // Prints both authority lookups side by side: the baseline's own edge (which
  // governs the drift decision) and the gates out of the current status (which
  // govern transition signing). Every value the tier depends on, in one line.
  console.log('panel: diag', JSON.stringify({
    issueKey: issue.key, projectId, issueTypeId, fromStatusId,
    baseline: state.baseline
      ? { version: state.baseline.version, from: String(state.baseline.from_status_id),
          to: String(state.baseline.to_status_id) }
      : null,
    baselineGate: state.gate ? { role: state.gate.required_role, assurance: state.gate.required_assurance,
      matchedType: state.gate.issue_type_id, matchedFrom: state.gate.from_status_id, matchedTo: state.gate.to_status_id } : null,
    eligibleForBaselineGate: state.eligible,
    offered: validTransitions.map(t => ({ id: String(t.id), to: String(t.toStatusId) })),
    transitionGates: gateResults.map(g => g ? g.required_role : null),
    transitionEligibility: eligibilityResults,
    changedFieldCount: state.diff?.changedFieldCount ?? 0,
    pendingDrift, decidesDrift, gatedCount, blocker, actions: actions.length, tier
  }));

  let livingState = "Waiting on signature";
  if (decidesDrift) {
    livingState = "Changes since approval need a decision";
  } else if (pendingDrift) {
    // Something does need a signature here; it is simply not theirs to give.
    // Name the role if ANY rule in play knows it — the baseline's own edge
    // first, then whatever is gated out of the current status. Reading only the
    // first would print the anonymous fallback whenever the baseline's rule has
    // been removed, which is exactly when the reviewer most needs telling who
    // to go to.
    const role = state.gate?.required_role
      ?? gateResults.find(g => g?.required_role)?.required_role;
    livingState = role
      ? `Waiting on a signature from ${role}`
      : "Waiting on a signature from the required role";
  } else if (isDone) {
    livingState = "Work item is completed.";
  } else if (gatedCount === 0) {
    livingState = "Nothing needs a signature at this status";
  } else if (blocker === BLOCKER.NOT_ELIGIBLE_FOR_RULE) {
    const blockedGate = gateResults.find(g => Boolean(g?.required_role));
    livingState = blockedGate?.required_role
      ? `Waiting on a signature from ${blockedGate.required_role}`
      : "Waiting on a signature from the required role";
  }

  const record = buildRecord({ baseline, controlledFields: state.fields, baselineValues: state.baselineValues,
    digests: baseline ? JSON.parse(baseline.field_digests || '{}') : {}, approval: approvalRecord });
  if (record) {
    record.history = (history ?? []).map(h => ({
      version: Number(h.version),
      approvedName: h.approved_name ?? h.approvedName ?? 'Reviewer',
      approvedAt: h.transition_at ?? h.captured_at ?? h.approvedAt ?? null,
      capturedAt: h.captured_at ?? h.capturedAt ?? null,
      assuranceLevel: h.assurance_level ?? h.assuranceLevel ?? null,
      approved_name: h.approved_name ?? h.approvedName,
      transition_at: h.transition_at ?? h.approvedAt,
      assurance_level: h.assurance_level ?? h.assuranceLevel
    }));
  }
  const extractText = (doc) => {
    if (!doc || !doc.content) return '';
    return doc.content.map(c => (c.type === 'paragraph' ? (c.content || []).map(n => n.text).join('') : '')).join('\n').trim();
  };
  const desc = extractText(issue.fields.description);
  const descriptionTruncated = desc.length > 500;
  const descriptionEmpty = desc.length === 0;
  const description = descriptionTruncated ? desc.substring(0, 500) + '…' : desc;

  let groupedDrift = {
    addedNodes: [], removedNodes: [], movedNodes: [], changedFields: []
  };
  let deleteIssueKeys = [];
  let recreateCount = 0;

  if (state.treeDiff && state.treeDiff.changes) {
    const currentNodesById = new Map(state.tree?.nodes?.map(n => [n.logicalNodeId, n]) ?? []);
    for (const change of state.treeDiff.changes) {
      if (change.kind === 'NODE_ADDED') {
        const node = currentNodesById.get(change.logicalNodeId);
        groupedDrift.addedNodes.push(node);
        if (node?.key) {
          deleteIssueKeys.push(node.key);
        }
      } else if (change.kind === 'NODE_REMOVED') {
        groupedDrift.removedNodes.push(change);
        recreateCount++;
      } else if (change.kind === 'NODE_MOVED') {
        groupedDrift.movedNodes.push(change);
      } else if (change.kind === 'FIELD_CHANGED') {
        groupedDrift.changedFields.push(change);
      }
    }
  }

  const base = {
    issue: { id: issue.id, key: issue.key, summary: issue.fields.summary, status: issue.fields.status,
      description, descriptionEmpty, descriptionTruncated, assignee: issue.fields.assignee, reporter: issue.fields.reporter },
    tier,
    state: livingState,
    record,
    baseline: state.baseline ? {
      nodeCount: Number(state.baseline.node_count ?? 1),
      edgeCount: Number(state.baseline.edge_count ?? 0),
      totalFieldCount: Number(state.baseline.total_field_count ?? state.baseline.field_count ?? 0),
      treeHash: state.baseline.tree_hash ?? null
    } : undefined,
    drift: {
      count: state.baseline ? (state.diff?.changedFieldCount ?? state.treeDiff?.changes?.length ?? 0) : 0,
      materialCount: state.baseline ? (state.diff?.materialFieldCount ?? state.treeDiff?.changes?.length ?? 0) : 0,
      evidenceHash: state.evidenceHash,
      ...groupedDrift
    },
    rejection: {
      deleteIssueKeys,
      recreateCount
    },
    approval: { pending: null }
  };

  const payload = tier === 'actor' ? {
    ...base,
    actorName: actor.displayName,
    eligibility: { eligible: true, reason: null },
    drift: {
      ...base.drift,
      fields: state.diff?.fields ?? []
    },
    transitions: actions,
    credentialEnrolled: credential,
    approval: {
      requiredRole: state.gate?.required_role ?? null,
      requiredAssurance: state.gate?.required_assurance ?? actions[0]?.requiredAssurance ?? null,
      pending: pendingApproval(stranded, actions),
      meaning: actions[0]?.meaning ?? 'Approved'
    }
  } : {
    ...base,
    eligibility: { eligible: false, reason: null }
  };

  if (isAdmin) {
    payload.controls = controls;
  }

  return payload;
}); }

/**
 * The stranded approval, only if retrying it could actually work.
 *
 * retryTransition resolves the transition by id and requires its to-status to
 * match the signed row. If Jira is no longer offering that transition the retry
 * is certain to be refused, and a button that cannot succeed is worse than no
 * button — so it is not advertised.
 */
function pendingApproval(row, transitions) {
  if (!row?.approval_id || !row.transition_id) return null;
  const offered = transitions.some(t => t.transitionId === String(row.transition_id)
    && String(t.toStatusId) === String(row.to_status_id));
  if (!offered) return null;
  return { approvalId: Buffer.from(row.approval_id).toString('hex'),
    transitionId: String(row.transition_id), state: row.state, expiresAt: Number(row.expires_at) };
}

/** Rendered on every issue view: exactly one primary-key read, no Jira fan-out. */
export async function getGlanceState({ context }) { return respond(async () => {
  const actor = actorFrom(context);
  const issueId = context.extension?.issue?.id;
  if (!issueId) fail('ISSUE_CONTEXT_REQUIRED');
  const [row, controls, isAdmin] = await Promise.all([
    getReview(Number(issueId)),
    issueControlStatus({ issueId: Number(issueId), projectId: context.extension?.project?.id,
      issueTypeId: context.extension?.issue?.typeId }),
    isActiveAdmin(actor.accountId).catch(() => false)
  ]);
  const result = { state: row?.state ?? 'UNAPPROVED', baselineVersion: row?.baseline_version ?? null,
    driftCount: Number(row?.drift_count ?? 0), materialCount: Number(row?.drifted_field_count ?? 0),
    maxMateriality: row?.max_materiality ?? null };
  if (isAdmin) {
    result.controls = controls;
  }
  return result;
}); }
