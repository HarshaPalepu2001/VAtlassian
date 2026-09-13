/**
 * RECALL: sending a drifted work item back to be reviewed.
 *
 * ─── THE RULE ────────────────────────────────────────────────────────────────
 *
 * An approved version that has since been edited is not approved any more. The
 * app already knew that — va_item_state went to DRIFTED and the queue listed it —
 * but the work item itself carried on sitting wherever it was, usually well
 * past the review gate, with nothing stopping it moving further. BS-11 was
 * DRIFTED and In Progress, and every transition out of In Progress was
 * unguarded, because the gate is configured on the way out of REVIEW.
 *
 * So the state in our database said "this needs a decision" and the state a
 * human could see in Jira said "this is in progress, carry on". Of those two
 * the second is the one people act on.
 *
 * Recall closes it by moving the item back to the status the gate guards. Once
 * it is there, everything else this app already does starts working on it: the
 * gate covers every exit, the panel offers approve and reject, an approval
 * passes through the door that mints a baseline, and a rejection restores.
 * Recall is not a new control — it is what puts the item back within reach of
 * the existing one.
 *
 * ─── ONE TARGET, AND IT COMES FROM THE BASELINE ─────────────────────────────
 *
 * The target status used to be "whichever gate a project admin has configured
 * right now" — read fresh out of va_controlled_transition on every recall. That
 * let an edit to today's configuration silently redirect a RECALL that a
 * baseline signed weeks ago, and there was no way to tell, after the fact,
 * which rule actually sent an item back. The target is now `targetStatusId`,
 * supplied by the caller from the latest ACTIVE baseline's own recorded review
 * status (see lib/baselinePolicy.js) — never from the current configuration,
 * and never from a list of "every status this project treats as review". One
 * baseline, one review status, one place a recall can send an item.
 *
 * ─── WHY THIS FILE HAS NO I/O ────────────────────────────────────────────────
 *
 * Same reason as transitionPlan.js and restore/outcome.js: a module that
 * imports @forge/api cannot be reached by a test outside the Forge runtime.
 * Deciding whether to move somebody's work item is exactly the kind of rule
 * that must be testable, so the decision lives here and the caller performs it.
 */

export const RECALL = {
  /** Move it. `transitionId` names the edge. */
  RECALL: 'RECALL',
  /** Nothing to answer for. */
  NO_DRIFT: 'NO_DRIFT',
  /**
   * It drifted while already sitting in the baseline's review status. Leave it
   * exactly where it is — it is already in front of a reviewer and the gate
   * already covers its exits. Transitioning an item to the status it is
   * already in is at best a no-op and at worst a workflow loop that fires the
   * transitioned trigger forever.
   */
  ALREADY_IN_REVIEW: 'ALREADY_IN_REVIEW',
  /** No review status to aim for — the caller has nothing to recall to. */
  NOT_GATED: 'NOT_GATED',
  /**
   * There is a review status and Jira offers no route to it from here.
   *
   * FAILS HARD AND VISIBLY, and does not fall back to something clever. The
   * item stays where it is, still DRIFTED, still queued, and the caller logs at
   * error level with the workflow that has no way back. Inventing a route —
   * picking the nearest status, or forcing it through an unrelated edge — would
   * move a customer's work item somewhere their workflow never intended.
   */
  NO_ROUTE: 'NO_ROUTE',
  /**
   * Jira currently offers MORE THAN ONE transition that lands on the review
   * status. Picking the first one — or any one — would be routing a customer's
   * work item through an edge nobody named for this purpose. Two same-
   * destination transitions is an ordinary workflow shape (an admin adding a
   * fast-track alongside the normal route), so this is not a defect to log and
   * forget; it is a workflow an automated recall cannot safely resolve on its
   * own, and it is reported so an administrator can either rename one edge out
   * of ambiguity or accept that recall needs a human here.
   */
  AMBIGUOUS_ROUTE: 'AMBIGUOUS_ROUTE',
  /**
   * Exactly one route exists, but it carries a transition screen with fields
   * Jira will demand answers to. A background job has no reviewer to ask, so
   * this is refused BEFORE the attempt rather than after — a failed POST would
   * report exactly the same fact but only after making a request that could
   * partially apply in a workflow with post-functions attached.
   */
  SCREEN_BLOCKED: 'SCREEN_BLOCKED',
  /**
   * The plan was sound — one clean, screen-free route — and Jira refused it
   * anyway: a workflow validator, a permission, a post-function precondition
   * this app cannot see from the transitions list. Distinct from NO_ROUTE
   * (Jira never offered a way) and from SCREEN_BLOCKED (refused before asking),
   * because the fix for each is different and an administrator reading a log
   * needs to know which one they are looking at.
   */
  JIRA_REFUSED: 'JIRA_REFUSED'
};

/**
 * Should this drifted item be moved back to review, and by which transition?
 *
 * @param currentStatusId  where the item is now
 * @param targetStatusId   the ONE status to recall to — the latest ACTIVE
 *                          baseline's own review status. Not a list, and never
 *                          re-derived from today's configuration.
 * @param transitions      what Jira offers from here, as availableTransitions
 *                          shapes them
 * @param driftCount       undecided drift outstanding
 */
export function recallPlan({
  currentStatusId, targetStatusId, transitions, driftCount
}) {
  if (!Number(driftCount ?? 0)) return { action: RECALL.NO_DRIFT };

  const current = String(currentStatusId ?? '');
  const target = String(targetStatusId ?? '');

  if (!target) return { action: RECALL.NOT_GATED };

  // Already there. Not a review-status list lookup any more — the ONE status
  // the baseline names, compared directly. Transitioning an item onto itself
  // would be a no-op at best and a trigger loop at worst.
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

  // A transition screen with required fields cannot be satisfied by a
  // background job — it has no reviewer to ask. Refused here, before any
  // request reaches Jira, rather than discovered from a failed POST.
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
