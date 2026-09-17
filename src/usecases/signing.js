/**
 * SIGNING CONTEXT — resolving what may be signed from a transition screen.
 *
 * Forge's issue-transition custom field context carries the destination
 * transition id (`issueTransition.id`). Both signing fields (va-approval-field for UI Kit, and
 * va-device-approval-field for Custom UI) previously fell back to panel:getState,
 * which returned every gated transition leaving the current status. On an issue
 * with two controlled outbound edges, the field offered a dropdown — and if an
 * edge required a biometric device check that UI Kit cannot perform, it offered
 * to sign the wrong transition with a meaning statement that belonged to that
 * other edge. Attesting to the wrong meaning is a critical compliance failure.
 *
 * THE FIELD'S IDENTITY IS THE DISAMBIGUATOR. An administrator places whichever
 * field matches the rule's required assurance on that transition's screen.
 * Resolving with surface: 'esignature-field' or 'device-field' narrows the
 * candidates using lib/journey.js's resolveActions().
 */
import api from '@forge/api';
import { load, respond, actorFrom, fail } from './panelAccess.js';
import { availableTransitions } from '../lib/transitions.js';
import { gatedTransition } from '../db/configStore.js';
import { isEligible } from '../lib/reviewer.js';
import { resolveActions } from '../lib/journey.js';
import { extractDescription } from './panelEvidence.js';

export function createSigningUsecases(deps = {}) {
  const loadFn = deps.load ?? load;
  const availableFn = deps.availableTransitions ?? (async (issueKey) => availableTransitions(deps.api ?? api, issueKey));
  const gateFn = deps.gatedTransition ?? gatedTransition;
  const eligibleFn = deps.isEligible ?? isEligible;
  const resolveFn = deps.resolveActions ?? resolveActions;

  async function signingContext(args = {}) {
    return respond(async () => {
      const state = await loadFn(args);
      const { issue, actor, projectId, issueTypeId } = state;
      const surface = args?.payload?.surface;
      // THE FIELD MUST NAME THE EXACT TRANSITION IT SITS ON. Forge's
      // issue-transition custom field context carries the destination
      // transition id (Jira's `issueTransition.id`), and this surface exists
      // only on that screen — so unlike the panel or worklist, which weigh
      // every offered transition, this one resolves exactly one. A field
      // that cannot say which transition it is for cannot be trusted to
      // narrow to the one policy the signer is actually looking at, and two
      // sibling transitions to the same destination status must never be
      // able to borrow each other's policy or receipt.
      const transitionId = args?.payload?.transitionId;
      if (transitionId == null || transitionId === '') fail('TRANSITION_ID_REQUIRED');
      const transitionIdStr = String(transitionId);
      const fromStatusId = String(issue.fields?.status?.id ?? '');
      const statusCategory = issue.fields?.status?.statusCategory?.key?.toLowerCase();
      const isDone = statusCategory === 'done' || issue.fields?.status?.name?.toLowerCase() === 'done';

      const available = await availableFn(issue.key);
      const validTransitions = isDone
        ? []
        : available.filter((t) => String(t.toStatusId) !== fromStatusId && String(t.id) === transitionIdStr);

      const gateResults = await Promise.all(
        validTransitions.map((t) =>
          gateFn({
            projectId,
            issueTypeId,
            fromStatusId,
            toStatusId: t.toStatusId,
            transitionId: transitionIdStr
          })
        )
      );

      const eligibilityResults = await Promise.all(
        gateResults.map((gate) =>
          gate
            ? eligibleFn({
                accountId: actor.accountId,
                projectId,
                issueTypeId,
                role: gate.required_role
              })
            : false
        )
      );

      const { actions, blocker, gatedCount } = resolveFn({
        offered: validTransitions,
        gates: gateResults,
        eligible: eligibilityResults,
        surface
      });

      const blockedGate = blocker === 'NOT_ELIGIBLE_FOR_RULE'
        ? gateResults.find((g, i) => g && eligibilityResults[i] !== true)
        : null;

      return {
        actions,
        blocker,
        gatedCount,
        requiredRole: blockedGate?.required_role ?? null,
        issue: {
          id: String(issue.id),
          key: issue.key,
          summary: issue.fields?.summary ?? '',
          statusName: issue.fields?.status?.name ?? '',
          issueTypeName: issue.fields?.issuetype?.name ?? '',
          assignee: issue.fields?.assignee ?? null,
          reporter: issue.fields?.reporter ?? null,
          ...extractDescription(issue.fields?.description)
        },
        actorName: actor?.displayName ?? null,
        drift: { evidenceHash: state.evidenceHash }
      };
    });
  }

  return { signingContext };
}

export async function signingContext(args, deps) {
  return createSigningUsecases(deps).signingContext(args);
}
