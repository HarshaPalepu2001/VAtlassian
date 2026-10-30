import { controlledAuthenticationMethod } from '../lib/approval/levels.js';
import { ANY_STATUS, isOurGate, isDisabled } from '../lib/gateDrift.js';
import { MODULE_KEY } from '../lib/workflowSource.js';

/**
 * Check that the live transition matches the exact edge claimed by the input.
 *
 * gateDrift.js transitionCovers uses broader wildcard semantics: a wildcard
 * source can cover any transition into the target status, including new bypass
 * routes that gatecheck must flag. The admin picker uses fromStatusId: '*' only
 * for transitions Jira reports as GLOBAL. Require the same transition to remain
 * GLOBAL for wildcard input. For concrete source input, require a matching link
 * on that transition and refuse a GLOBAL transition as a substitute.
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
  // An exact live transition is read from one project and issue type pair
  // (workflowSource.js#readWorkflowForPair takes no wildcard). A wildcard
  // issue type is still a real, supported scope for other tables in
  // db/configStore.js, but a controlled
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
  // one cannot be enforced without risking a a sibling edge matching it. See
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
 * Re-read the exact project/type workflow when saving a controlled transition.
 * Client-supplied transition and status IDs are not authoritative. Require the
 * claimed transition ID and source/destination edge, plus an enabled va-gate
 * validator for this app's runtime identity.
 *
 * Also refuse a role with no current holder or an ACTIVE row already claiming
 * the same edge. These configuration failures would not produce a gatecheck
 * finding later. See adminAlerts.js listGateFindings and MISSING_TRANSITION_ID
 * for the related gap caught here at write time.
 *
 * Use readWorkflowForPair, runtimeAppId and executeQuery from the dependencies
 * supplied by adminRuntime.js adminDependencies.
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
