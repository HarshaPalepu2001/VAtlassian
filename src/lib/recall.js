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
   * It drifted while already sitting in review. Leave it exactly where it is —
   * it is already in front of a reviewer and the gate already covers its exits.
   * Transitioning an item to the status it is already in is at best a no-op and
   * at worst a workflow loop that fires the transitioned trigger forever.
   */
  ALREADY_IN_REVIEW: 'ALREADY_IN_REVIEW',
  /** No gate on this project/issue type, so there is no review status to go to. */
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
  NO_ROUTE: 'NO_ROUTE'
};

/**
 * Should this drifted item be moved back to review, and by which transition?
 *
 * @param currentStatusId    where the item is now
 * @param reviewStatusIds    every status this project treats as "in review"
 * @param gateFromStatusId   the gate's from_status_id — the status an admin
 *                           declared means "in review". The recall target.
 * @param transitions        what Jira offers from here, as availableTransitions
 *                           shapes them
 * @param driftCount         undecided drift outstanding
 */
export function recallPlan({
  currentStatusId, reviewStatusIds, gateFromStatusId, transitions, driftCount
}) {
  if (!Number(driftCount ?? 0)) return { action: RECALL.NO_DRIFT };

  const current = String(currentStatusId ?? '');
  const reviewIds = (reviewStatusIds ?? []).map(String);

  // Checked against EVERY review status, not just the gate's target. A project
  // may have several, and an item sitting in one of the others is still in
  // front of a reviewer — dragging it sideways into the gate's status would be
  // a visible, pointless move on somebody's board.
  if (reviewIds.includes(current)) {
    return { action: RECALL.ALREADY_IN_REVIEW };
  }

  const target = String(gateFromStatusId ?? '');
  if (!target) return { action: RECALL.NOT_GATED };

  // Already there but the status is not in reviewStatusIds — a misconfiguration
  // rather than a reason to transition an item onto itself.
  if (target === current) return { action: RECALL.ALREADY_IN_REVIEW };

  const route = (transitions ?? []).find(
    (t) => String(t.toStatusId) === target && t.isAvailable !== false
  );
  if (!route) {
    return { action: RECALL.NO_ROUTE, target };
  }

  return {
    action: RECALL.RECALL,
    target,
    transitionId: String(route.id),
    transitionName: route.name ?? null,
    // A transition screen with required fields cannot be satisfied by a
    // background job — it has no reviewer to ask. Reported so the caller can
    // log precisely why a workflow will not accept the recall rather than
    // reporting Jira's generic refusal.
    hasScreen: !!route.hasScreen
  };
}
