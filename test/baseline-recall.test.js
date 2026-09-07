import test from 'node:test';
import assert from 'node:assert/strict';

import { recallPlan, RECALL } from '../src/lib/recall.js';

/**
 * DRIFT PUTS THE ITEM BACK IN FRONT OF A REVIEWER.
 *
 * BS-11 was DRIFTED in our database and "In Progress" on the board, and every
 * transition out of In Progress was unguarded — the gate is configured on the
 * way out of REVIEW. The database knew and the board did not, and the board is
 * the one people act on.
 *
 * These pin the two things that make an automatic transition on somebody's live
 * work item defensible: it happens only when it is warranted, and when the
 * workflow offers no way back it fails visibly instead of improvising.
 */

const REVIEW = '10426';
const IN_PROGRESS = '3';
const DONE = '10019';

const t = (id, toStatusId, extra = {}) => ({
  id, name: `To ${toStatusId}`, toStatusId, isAvailable: true, hasScreen: false, ...extra
});

const base = {
  currentStatusId: IN_PROGRESS,
  reviewStatusIds: [REVIEW],
  gateFromStatusId: REVIEW,
  transitions: [t('31', REVIEW), t('41', DONE)],
  driftCount: 2
};

test('a drifted item past the gate is recalled to the gate\'s review status', () => {
  const plan = recallPlan(base);

  assert.equal(plan.action, RECALL.RECALL);
  assert.equal(plan.target, REVIEW);
  assert.equal(plan.transitionId, '31');
});

test('an item that drifted while already in review is left exactly where it is', () => {
  // It is already in front of a reviewer and the gate already covers its exits.
  // Transitioning it onto itself is a no-op at best and a trigger loop at worst.
  const plan = recallPlan({ ...base, currentStatusId: REVIEW });

  assert.equal(plan.action, RECALL.ALREADY_IN_REVIEW);
  assert.equal(plan.transitionId, undefined);
});

test('any review status counts, not just the gate\'s target', () => {
  // A project may have several. An item sitting in one of the others is still
  // being reviewed; dragging it sideways would be a visible pointless move.
  const plan = recallPlan({
    ...base,
    currentStatusId: '10427',
    reviewStatusIds: [REVIEW, '10427']
  });

  assert.equal(plan.action, RECALL.ALREADY_IN_REVIEW);
});

test('no drift, no movement', () => {
  assert.equal(recallPlan({ ...base, driftCount: 0 }).action, RECALL.NO_DRIFT);
  assert.equal(recallPlan({ ...base, driftCount: null }).action, RECALL.NO_DRIFT);
});

test('an ungated project is never moved', () => {
  // Nothing declared "in review" here, so there is nowhere to send it and no
  // gate that would cover it once it arrived.
  const plan = recallPlan({ ...base, gateFromStatusId: null, reviewStatusIds: [] });

  assert.equal(plan.action, RECALL.NOT_GATED);
});

test('a workflow with no route back fails hard rather than picking a nearby status', () => {
  // THE RULE THAT KEEPS THIS SAFE. Improvising a destination would move a
  // customer's work item somewhere their workflow never intended. The item stays
  // put, still drifted, still queued, and the caller logs at error level.
  const plan = recallPlan({ ...base, transitions: [t('41', DONE)] });

  assert.equal(plan.action, RECALL.NO_ROUTE);
  assert.equal(plan.target, REVIEW);
  assert.equal(plan.transitionId, undefined);
});

test('a transition Jira marks unavailable is not a route', () => {
  const plan = recallPlan({
    ...base,
    transitions: [t('31', REVIEW, { isAvailable: false }), t('41', DONE)]
  });

  assert.equal(plan.action, RECALL.NO_ROUTE);
});

test('a transition screen is reported, not hidden, so a refusal can be explained', () => {
  // A screen with required fields cannot be satisfied by a job with no reviewer
  // to ask. The plan still proposes it — Jira may accept it — but carries the
  // flag so the failure log can name the real cause.
  const plan = recallPlan({ ...base, transitions: [t('31', REVIEW, { hasScreen: true })] });

  assert.equal(plan.action, RECALL.RECALL);
  assert.equal(plan.hasScreen, true);
});

test('an item already sitting in the target status is not transitioned onto itself', () => {
  // Misconfiguration: the gate's from_status is not listed as a review status.
  // Still must not produce a self-transition.
  const plan = recallPlan({
    ...base, currentStatusId: REVIEW, reviewStatusIds: []
  });

  assert.equal(plan.action, RECALL.ALREADY_IN_REVIEW);
});
