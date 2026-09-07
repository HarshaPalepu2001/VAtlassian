import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, canDecide, stateAfter, countersAfter, restoreComment, needsConfirmation,
  DECISION, REFUSE
} from '../src/lib/decision.js';
import { REVIEW_STATE } from '../src/lib/interception.js';
import { MATERIALITY } from '../src/lib/materiality.js';
// From ./transitionPlan.js, not ./transitions.js: that module imports
// @forge/api and does not resolve outside the Forge runtime.
import {
  outboundFromReview, chooseTransition, requiredFieldPlan, suggestReviewStatuses
} from '../src/lib/transitionPlan.js';

const baseline = { baseline_id: Buffer.from('b'), version: 2 };
const diff = (over = {}) => ({
  evidenceHash: 'hash-1',
  changedFieldCount: 3,
  materialFieldCount: 2,
  maxMateriality: MATERIALITY.MAJOR,
  fields: [],
  ...over
});

// ─── Who may decide ──────────────────────────────────────────────────────────

test('an ineligible caller is refused', () => {
  const result = canDecide({ review: {}, baseline, isEligible: false });
  assert.equal(result.allow, false);
  assert.equal(result.reason, REFUSE.NOT_ELIGIBLE);
});

test('a decision already in flight is refused, so two reviewers cannot race', () => {
  for (const state of [REVIEW_STATE.DECIDING, REVIEW_STATE.RESTORING]) {
    const result = canDecide({ review: { state }, baseline, isEligible: true });
    assert.equal(result.reason, REFUSE.ALREADY_DECIDING);
  }
});

// Device authentication — Face ID / Touch ID / Windows Hello, falling back to
// the machine PIN or password. The verdict is produced in the browser and
// verified in the resolver; canDecide only sees whether it came back true.
test('a required device authentication that did not succeed is refused', () => {
  const result = canDecide({
    review: {}, baseline, isEligible: true, authRequired: true, authVerified: false
  });
  assert.equal(result.reason, REFUSE.AUTH_REQUIRED);
});

test('a required device authentication that succeeded is allowed through', () => {
  const result = canDecide({
    review: {}, baseline, isEligible: true, authRequired: true, authVerified: true
  });
  assert.equal(result.allow, true);
});

// The check must be INERT, not lenient, while the wiring is absent: an edge
// that does not require authentication must never be refused for lacking it.
test('an edge that does not require authentication is not asked for one', () => {
  const result = canDecide({ review: {}, baseline, isEligible: true });
  assert.equal(result.allow, true);
});

test('an item that was never approved has nothing to decide about', () => {
  const result = canDecide({ review: {}, baseline: null, isEligible: true });
  assert.equal(result.reason, REFUSE.NO_BASELINE);
});

// ─── The stale-evidence guard ────────────────────────────────────────────────

test('STALE EVIDENCE: a decision taken against a version that has since changed is refused', () => {
  // A reviewer reads a diff, somebody edits the item, the reviewer clicks
  // Approve — approving a version they never saw.
  const result = decide({
    decision: DECISION.APPROVE,
    diff: diff({ evidenceHash: 'hash-2' }),
    evidenceHash: 'hash-1'
  });
  assert.equal(result.allow, false);
  assert.equal(result.reason, REFUSE.STALE_EVIDENCE);
});

test('matching evidence passes', () => {
  const result = decide({ decision: DECISION.APPROVE, diff: diff(), evidenceHash: 'hash-1' });
  assert.equal(result.allow, true);
});

// ─── Approve ─────────────────────────────────────────────────────────────────

test('approve RATIFIES the drift: a new baseline is cut from the current state', () => {
  const result = decide({ decision: DECISION.APPROVE, diff: diff() });
  assert.equal(result.cutsNewBaseline, true);
  assert.equal(result.marksDriftDecided, true);
  assert.equal(result.appliesTransition, true);
});

test('approving a cosmetic-only diff is allowed — it clears the queue', () => {
  const result = decide({ decision: DECISION.APPROVE, diff: diff({ materialFieldCount: 0 }) });
  assert.equal(result.allow, true);
});

// ─── Reject ──────────────────────────────────────────────────────────────────

test('reject does NOT cut a new baseline', () => {
  // Cutting one would quietly re-approve the restored state under the
  // reviewer's name, which is not what they did. The point of a rejection is
  // that the STANDING baseline was right all along.
  const plan = { steps: [{ fieldId: 'a', strategy: 'field' }] };
  const result = decide({ decision: DECISION.REJECT, diff: diff(), plan });
  assert.equal(result.allow, true);
  assert.equal(result.cutsNewBaseline, false);
  assert.equal(result.restores, true);
});

test('a reject with nothing restorable is refused rather than silently doing nothing', () => {
  const plan = { steps: [{ fieldId: 'a', strategy: 'none' }] };
  const result = decide({ decision: DECISION.REJECT, diff: diff(), plan });
  assert.equal(result.reason, REFUSE.NOTHING_RESTORABLE);
});

test('rejecting a cosmetic-only diff is refused — there is nothing to put back', () => {
  const result = decide({
    decision: DECISION.REJECT,
    diff: diff({ materialFieldCount: 0 }),
    plan: { steps: [] }
  });
  assert.equal(result.reason, REFUSE.NO_DRIFT);
});

// ─── Where the item lands ────────────────────────────────────────────────────

test('a PARTIAL restore leaves the item in ERROR, never quietly back in the queue', () => {
  // The item is neither at its approved state nor honestly drifted, and the one
  // thing that must not happen is it re-entering the queue as though nothing
  // went wrong.
  assert.equal(stateAfter({ decision: DECISION.REJECT, restoreState: 'PARTIAL' }), REVIEW_STATE.ERROR);
  assert.equal(stateAfter({ decision: DECISION.REJECT, restoreState: 'FAILED' }), REVIEW_STATE.ERROR);
  assert.equal(stateAfter({ decision: DECISION.REJECT, restoreState: 'COMPLETE' }), REVIEW_STATE.BASELINED);
  assert.equal(stateAfter({ decision: DECISION.APPROVE }), REVIEW_STATE.BASELINED);
});

test('counters zero on approve and on a complete restore, and persist on a partial one', () => {
  const d = diff();
  assert.deepEqual(
    countersAfter({ decision: DECISION.APPROVE, diff: d }),
    { driftCount: 0, driftedFieldCount: 0, maxMateriality: null }
  );
  assert.equal(countersAfter({ decision: DECISION.REJECT, restoreState: 'PARTIAL', diff: d }).driftCount, 3);
});

// ─── The comment ─────────────────────────────────────────────────────────────

test('the restore comment names what was NOT put back, not just what was', () => {
  const adf = restoreComment({
    actorName: 'Ana',
    counters: { succeeded: 2, failed: 1, irreversible: 1, skipped: 0 },
    state: 'PARTIAL',
    detail: [
      { fieldName: 'Summary', outcome: 'succeeded' },
      { fieldName: 'Attachment', outcome: 'irreversible', reason: 'cannot be re-uploaded' }
    ],
    baselineVersion: 2
  });

  const text = JSON.stringify(adf);
  assert.match(text, /Ana rejected/);
  assert.match(text, /Not restored/);
  assert.match(text, /Attachment/);
  assert.equal(adf.type, 'doc');
});

test('needsConfirmation nudges only on a critical change approved instantly', () => {
  const critical = diff({ maxMateriality: MATERIALITY.CRITICAL });
  assert.equal(needsConfirmation({ diff: critical, report: {}, dwellMs: 800 }), true);
  assert.equal(needsConfirmation({ diff: critical, report: {}, dwellMs: 60_000 }), false);
  assert.equal(needsConfirmation({ diff: diff(), report: {}, dwellMs: 800 }), false);
});

// ─── Transitions out of review ───────────────────────────────────────────────

const TRANSITIONS = [
  { id: '11', name: 'Back to review', toStatusId: '10001', toStatusName: 'In Review', isAvailable: true, fields: {} },
  { id: '21', name: 'Approve', toStatusId: '10002', toStatusName: 'Ready', isAvailable: true, fields: {} },
  { id: '31', name: 'Ship', toStatusId: '10003', toStatusName: 'Done', isAvailable: true, fields: {} },
  { id: '41', name: 'Blocked', toStatusId: '10004', toStatusName: 'Blocked', isAvailable: false, fields: {} }
];

test('ONLY transitions out of a review status are offered', () => {
  const result = outboundFromReview({
    transitions: TRANSITIONS,
    currentStatusId: '10001',
    reviewStatusIds: ['10001']
  });
  assert.equal(result.inReview, true);
  // Excludes the loop back into review and the unavailable one.
  assert.deepEqual(result.transitions.map((t) => t.id), ['21', '31']);
});

test('an item not in review offers nothing, rather than offering unrelated transitions', () => {
  const result = outboundFromReview({
    transitions: TRANSITIONS,
    currentStatusId: '10002',
    reviewStatusIds: ['10001']
  });
  assert.equal(result.inReview, false);
  assert.deepEqual(result.transitions, []);
});

test('exactly one transition is applied automatically; several need a choice', () => {
  assert.equal(chooseTransition({ transitions: [TRANSITIONS[1]] }).transition.id, '21');
  assert.equal(chooseTransition({ transitions: [TRANSITIONS[1], TRANSITIONS[2]] }).needsChoice, true);
  assert.equal(
    chooseTransition({ transitions: [TRANSITIONS[1], TRANSITIONS[2]], requestedId: '31' }).transition.id,
    '31'
  );
});

test('required fields are filled from the BASELINE, and anything else is asked for', () => {
  // "Whatever is required is provided" has a limit, and the limit is honesty:
  // inventing a value to satisfy a screen would write data nobody approved.
  const transition = {
    id: '21', hasScreen: true,
    fields: {
      resolution: { required: true, name: 'Resolution', schema: { type: 'resolution' } },
      comment: { required: true, name: 'Comment', schema: { type: 'string' } },
      assignee: { required: false, name: 'Assignee', schema: { type: 'user' } }
    }
  };

  const plan = requiredFieldPlan({
    transition,
    baselineValues: { resolution: { id: '10' } },
    currentFields: {}
  });

  assert.deepEqual(plan.prefilled.resolution, { id: '10' });
  assert.deepEqual(plan.askUser.map((f) => f.fieldId), ['comment']);
});

test('a required field already set on the issue is left alone', () => {
  const transition = {
    id: '21', hasScreen: true,
    fields: { resolution: { required: true, name: 'Resolution', schema: { type: 'resolution' } } }
  };
  const plan = requiredFieldPlan({
    transition,
    baselineValues: {},
    currentFields: { resolution: { id: '3' } }
  });
  assert.deepEqual(plan.prefilled, {});
  assert.deepEqual(plan.askUser, []);
});

test('review statuses are suggested by name, never applied automatically', () => {
  const suggested = suggestReviewStatuses([
    { id: '1', name: 'In Review' },
    { id: '2', name: 'QA Sign-off' },
    { id: '3', name: 'In Progress' },
    { id: '4', name: 'Awaiting approval' }
  ]);
  assert.deepEqual(suggested.sort(), ['1', '2', '4']);
});
