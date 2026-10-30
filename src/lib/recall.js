/**
 * Plan recall of drifted work items to their baseline's review status so
 * the workflow gate can enforce a new decision.
 *
 * The caller supplies targetStatusId from the active baseline's recorded
 * policy. Never derive it from current configuration or a list of review
 * statuses. Configuration edits must not redirect earlier signed baselines.
 *
 * Keep this planning module free of I/O so tests can run without @forge/api.
 * The caller performs the transition.
 */

export const RECALL = {
  /** Move it. `transitionId` names the edge. */
  RECALL: 'RECALL',
  /** Nothing to answer for. */
  NO_DRIFT: 'NO_DRIFT',
  /**
 * Leave items already in the baseline's review status there. The gate
 * already covers their exits, and transitioning to the same status can loop
 * workflow triggers.
 */
  ALREADY_IN_REVIEW: 'ALREADY_IN_REVIEW',
  /** The baseline has no review status to recall to. */
  NOT_GATED: 'NOT_GATED',
  /**
 * No route reaches the review status. Leave the item drifted and queued,
 * and log the missing route as an error. Do not invent another target or edge.
 */
  NO_ROUTE: 'NO_ROUTE',
  /**
 * More than one available transition reaches the review status. Refuse
 * ambiguous routing and report it for administrator review.
 */
  AMBIGUOUS_ROUTE: 'AMBIGUOUS_ROUTE',
  /**
 * The route requires screen fields that a background job cannot supply.
 * Refuse before attempting a POST that could partially apply post-functions.
 */
  SCREEN_BLOCKED: 'SCREEN_BLOCKED',
  /**
 * Jira refused a single screen-free route, possibly through a validator,
 * permission check or post-function precondition. Report this separately
 * from a missing route or a screen blocked before submission.
 */
  JIRA_REFUSED: 'JIRA_REFUSED'
};

/**
 * Choose whether and how to recall a drifted item.
 *
 * @param currentStatusId  the current status
 * @param targetStatusId   the active baseline's recorded review status
 * @param transitions     availableTransitions output from Jira
 * @param driftCount      outstanding undecided drift
 */
export function recallPlan({
  currentStatusId, targetStatusId, transitions, driftCount
}) {
  if (!Number(driftCount ?? 0)) return { action: RECALL.NO_DRIFT };

  const current = String(currentStatusId ?? '');
  const target = String(targetStatusId ?? '');

  if (!target) return { action: RECALL.NOT_GATED };

  // Compare the baseline's exact review status. Avoid self-transitions that
  // could repeat workflow triggers.
  if (target === current) return { action: RECALL.ALREADY_IN_REVIEW };

  // Filtered to the exact target, and only what Jira currently offers. No
  // first-match routing: every candidate is kept so the caller can tell "none"
  // from "one" from "more than one" apart, and only "exactly one" proceeds.
  const routes = (transitions ?? []).filter(
    (t) => String(t.toStatusId) === target && t.isAvailable !== false
  );

  if (routes.length === 0) return { action: RECALL.NO_ROUTE, target };

  if (routes.length > 1) {
    return {
      action: RECALL.AMBIGUOUS_ROUTE,
      target,
      offered: routes.map((r) => String(r.id))
    };
  }

  const [route] = routes;

  // A background job has no reviewer to supply required screen fields.
  // Refuse before POSTing to Jira.
  if (route.hasScreen) {
    return {
      action: RECALL.SCREEN_BLOCKED,
      target,
      transitionId: String(route.id),
      transitionName: route.name ?? null
    };
  }

  return {
    action: RECALL.RECALL,
    target,
    transitionId: String(route.id),
    transitionName: route.name ?? null
  };
}
