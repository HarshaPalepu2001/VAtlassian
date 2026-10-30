/**
 * Resolve the signing context for the exact transition screen.
 *
 * Forge supplies issueTransition.id. Previously both signing fields,
 * va-approval-field and va-device-approval-field, fell back to panel:getState,
 * which returned all controlled transitions from the current status. A dropdown
 * could then offer a different edge, including biometric approval that UI Kit
 * could not perform, with the wrong meaning statement.
 *
 * Both fields now use the Custom UI form with surface: 'signature-field' for
 * all assurance levels. The transition ID selects one candidate before
 * lib/journey.js resolveActions() evaluates its rule.
 */
import api from '@forge/api';
import { load, respond, actorFrom, fail } from './panelAccess.js';
import { availableTransitions } from '../lib/transitions.js';
import { gatedTransition } from '../db/configStore.js';
import { isEligible } from '../lib/reviewer.js';
import { resolveActions } from '../lib/journey.js';
import { extractDescription } from './panelEvidence.js';
import { baselineDrift, logLiveDrift } from '../lib/liveDrift.js';
import { rootNodeDigests } from '../db/baselineTreeStore.js';
import { driftedAncestor, viewerAncestorDeps } from '../lib/ancestorHold.js';

function issueForSigning(issue) {
  return {
    id: String(issue.id),
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    statusName: issue.fields?.status?.name ?? '',
    issueTypeName: issue.fields?.issuetype?.name ?? '',
    assignee: issue.fields?.assignee ?? null,
    reporter: issue.fields?.reporter ?? null,
    ...extractDescription(issue.fields?.description)
  };
}

export function createSigningUsecases(deps = {}) {
  const loadFn = deps.load ?? load;
  const availableFn = deps.availableTransitions ?? (async (issueKey) => availableTransitions(deps.api ?? api, issueKey));
  const gateFn = deps.gatedTransition ?? gatedTransition;
  const eligibleFn = deps.isEligible ?? isEligible;
  const resolveFn = deps.resolveActions ?? resolveActions;
  const driftFn = deps.baselineDrift ?? baselineDrift;
  const rootDigestsFn = deps.rootNodeDigests ?? rootNodeDigests;
  const ancestorFn = deps.driftedAncestor ?? (async issue => driftedAncestor(issue, await viewerAncestorDeps(),
    { surface: 'signing-form-ancestor' }));

  async function signingContext(args = {}) {
    return respond(async () => {
      const state = await loadFn(args);
      const { issue, actor, projectId, issueTypeId } = state;
      const surface = args?.payload?.surface;
      // The validator judges the work item before it judges the edge. Mirror
      // that ordering here so a drifted item never offers a signature that the
      // validator is certain to refuse. This is the same live baseline
      // comparison used by the validator, not a stored counter or client flag.
      const comparison = state.baseline
        ? await driftFn({ baseline: state.baseline, issueId: state.issueId, issueFields: issue.fields,
            declared: state.fields, readRootDigests: rootDigestsFn })
        : { changed: [], contentHash: null };
      const driftCount = Array.isArray(comparison?.changed) ? comparison.changed.length : Number.NaN;
      const driftBlocked = state.config?.enabled !== false
        && (!Number.isSafeInteger(driftCount) || driftCount > 0);
      const drift = { evidenceHash: state.evidenceHash, count: driftCount, blocked: driftBlocked };
      if (driftBlocked) {
        logLiveDrift('signing-form', { issueKey: issue?.key, issueTypeId, comparison });
        return {
          actions: [], blocker: 'UNDECIDED_DRIFT', gatedCount: 0,
          requiredRole: state.gate?.required_role ?? null,
          issue: issueForSigning(issue), actorName: actor?.displayName ?? null, drift
        };
      }
      // Held from above (lib/ancestorHold.js): the validator refuses this item
      // while an issue above it has undecided drift, so no signature is
      // offered. An ancestor that cannot be read blocks too, as it does there.
      if (state.config?.enabled !== false && issue.fields?.parent?.key) {
        const above = await ancestorFn(issue).catch(() => ({ issueKey: null }));
        if (above) {
          return {
            actions: [], blocker: 'ANCESTOR_DRIFT', heldBy: above.issueKey ?? null, gatedCount: 0,
            requiredRole: state.gate?.required_role ?? null,
            issue: issueForSigning(issue), actorName: actor?.displayName ?? null,
            drift: { ...drift, blocked: true, heldBy: above.issueKey ?? null }
          };
        }
      }
      // Require the exact transition ID for this field's screen. Forge's
      // issue-transition custom field context carries the destination
      // transition id (Jira's `issueTransition.id`), and this surface exists
      // only on that screen. The panel and worklist consider every offered
      // transition, while this field resolves exactly one. A field
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
        issue: issueForSigning(issue),
        actorName: actor?.displayName ?? null,
        drift
      };
    });
  }

  return { signingContext };
}

export async function signingContext(args, deps) {
  return createSigningUsecases(deps).signingContext(args);
}
