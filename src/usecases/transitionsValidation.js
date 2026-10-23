import { controlledAuthenticationMethod } from '../lib/approval/levels.js';
import { ANY_STATUS, isOurGate, isDisabled } from '../lib/gateDrift.js';
import { MODULE_KEY } from '../lib/workflowSource.js';

/**
 * Does this live transition still run EXACTLY the edge the input claims?
 *
 * Deliberately stricter than gateDrift.js#transitionCovers, which asks a
 * different question — "does some wildcard controlled row still cover this
 * transition" — and answers yes for ANY transition into the target status
 * once a row's from-status is the wildcard, by design (a wildcard row is
 * meant to catch new transitions gatecheck should flag as bypass paths).
 *
 * Here the wildcard means something narrower and exact: adminDirectory.js's
 * picker only ever emits `fromStatusId: '*'` for a transition Jira itself
 * reports as GLOBAL (see listWorkflowTransitions). So an input claiming '*'
 * must still find that SAME transition GLOBAL, not merely reachable from
 * this destination by some other route — and an input naming a concrete
 * status must still find it among that transition's own links, never a
 * GLOBAL transition standing in for it.
 */
function matchesLiveTransition(t, { fromStatusId, toStatusId }) {
  if (!t || t.type === 'INITIAL') return false;
  if (String(t.toStatusReference) !== toStatusId) return false;
  if (fromStatusId === ANY_STATUS) return t.type === 'GLOBAL';
  if (t.type === 'GLOBAL') return false;
  return (t.links ?? []).some((link) => String(link.fromStatusReference) === fromStatusId);
}

export function transitionInput(payload = {}) {
  const { projectId, issueTypeId, fromStatusId, toStatusId, requiredRole, meaning } = payload;
  // An exact live transition is read from ONE project + ONE issue type pair
  // (workflowSource.js#readWorkflowForPair takes no wildcard). A wildcard
  // issue type is still a real, supported scope for OTHER tables — see
  // db/configStore.js's "ISSUE TYPE TAKES THE WILDCARD TOO" — but a controlled
  // transition can no longer be saved against one, because there would be no
  // single live workflow left to verify it against.
  if (!/^\d+$/.test(String(projectId ?? '')) || Number(projectId) <= 0 ||
      !/^\d+$/.test(String(issueTypeId ?? ''))) {
    throw new Error('An exact project and work item type are required.');
  }
  if (!/^(\d+|\*)$/.test(String(fromStatusId ?? '')) || !/^\d+$/.test(String(toStatusId ?? ''))) {
    throw new Error('A valid status edge is required.');
  }
  if (![requiredRole, meaning].every(s => typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 32)) {
    throw new Error('Role and meaning must be nonempty text of at most 32 characters, without surrounding spaces.');
  }
  const requiredAssurance = payload.requiredAssurance ?? payload.required_assurance;
  controlledAuthenticationMethod(requiredAssurance); // throws for anything other than ESIGNATURE or BIOMETRIC
  const flags = {};
  for (const [camel, snake, fallback] of [['captureBaseline', 'capture_baseline', true],
    ['requireDecision', 'require_decision', false]]) {
    const value = payload[camel] ?? payload[snake] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`${camel} must be a boolean.`);
    flags[camel] = value;
  }
  const rejectToStatusId = payload.rejectToStatusId || null;
  if (rejectToStatusId !== null && !/^\d+$/.test(String(rejectToStatusId))) throw new Error('Invalid rejection status id.');
  // The exact Jira transition, not a guess at one. Two workflow transitions can
  // share a destination status, and a rule saved without picking the precise
  // one cannot be enforced without risking a sibling edge borrowing it — see
  // gatedTransition() in db/configStore.js.
  if (!/^\d+$/.test(String(payload.transitionId ?? ''))) throw new Error('An exact Jira transition is required.');
  const transitionId = String(payload.transitionId);
  return { projectId: String(projectId), issueTypeId: String(issueTypeId), fromStatusId: String(fromStatusId),
    toStatusId: String(toStatusId), requiredRole, meaning, rejectToStatusId, transitionId, requiredAssurance, ...flags };
}

/**
 * Refuses a role nobody currently holds for this project and work item type,
 * so nothing is ever required of a role granted to no one. Shared by
 * controlled transitions and test-management sign-off chains.
 */
export async function requireRoleHolder(deps, { role, issueTypeId, projectId }) {
  const holder = await deps.executeQuery(
    `SELECT 1 FROM va_eligibility
      WHERE state = 'ACTIVE' AND role = ? AND (issue_type_id = ? OR issue_type_id = '*')
        AND (project_id = ? OR project_id IS NULL) LIMIT 1`,
    [role, issueTypeId, projectId]
  );
  if (!holder.result) throw new Error('Could not verify eligible holders for this role.');
  if (!(holder.data ?? []).length) {
    throw new Error(`No one currently holds the "${role}" role for this scope. Grant it before requiring it.`);
  }
}

/**
 * Revalidate a controlled transition against Jira's live workflow at save
 * time, rather than trusting whatever the admin picker read earlier.
 *
 * No client-supplied transition, destination, or source status is
 * authoritative — see the plan's global constraints. This re-reads the exact
 * pair, finds the transition the input claims by id, and refuses unless that
 * transition still runs the exact from/to edge the input claims AND still
 * carries an enabled va-gate validator for this app's own identity. It also
 * refuses a role nobody currently holds, and a second ACTIVE row already
 * claiming the identical exact edge — both silent-configuration-gap failure
 * modes with no gatecheck signature to catch them later (see
 * adminAlerts.js#listGateFindings's MISSING_TRANSITION_ID finding for the
 * sibling gap this closes at write time instead of after the fact).
 *
 * `deps` carries `readWorkflowForPair`, `runtimeAppId`, and `executeQuery` —
 * the same contracts every other admin usecase in this file's directory
 * already receives through adminRuntime.js#adminDependencies.
 */
export async function verifyControlledTransition(input, deps, { excludeCtId = null } = {}) {
  const workflow = await deps.readWorkflowForPair({ projectId: input.projectId, issueTypeId: input.issueTypeId });
  if (!workflow) {
    throw new Error('Could not read the live Jira workflow for this project and work item type. Try again.');
  }
  const candidate = (workflow.transitions ?? []).find((t) => String(t.id) === input.transitionId);
  const live = candidate && matchesLiveTransition(candidate, { fromStatusId: input.fromStatusId, toStatusId: input.toStatusId })
    ? candidate
    : null;
  if (!live) {
    throw new Error('This transition no longer runs the selected edge in the current Jira workflow. Reselect it.');
  }
  const appId = deps.runtimeAppId();
  const ours = (live.validators ?? []).filter((v) => isOurGate(v, { appId, moduleKey: MODULE_KEY }));
  if (ours.length === 0 || ours.every(isDisabled)) {
    throw new Error(`Attach and enable the "${MODULE_KEY}" signature validator on this transition in Jira before controlling it.`);
  }

  await requireRoleHolder(deps, { role: input.requiredRole, issueTypeId: input.issueTypeId, projectId: input.projectId });

  const conflictParams = [input.projectId, input.issueTypeId, input.transitionId, input.fromStatusId];
  let conflictSql = `SELECT 1 FROM va_controlled_transition
      WHERE state = 'ACTIVE' AND project_id = ? AND issue_type_id = ? AND transition_id = ? AND from_status_id = ?`;
  if (excludeCtId) {
    conflictSql += ' AND ct_id != FROM_BASE64(?)';
    conflictParams.push(excludeCtId);
  }
  const conflict = await deps.executeQuery(conflictSql, conflictParams);
  if (!conflict.result) throw new Error('Could not verify existing controlled transitions.');
  if ((conflict.data ?? []).length) {
    throw new Error('An active controlled transition already governs this exact edge.');
  }

  return live;
}
