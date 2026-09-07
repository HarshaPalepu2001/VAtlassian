import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observe, supersedeOnReviewEntry, OUTCOME, REVIEW_STATE
} from '../src/lib/interception.js';
import { project, FIELD_KIND } from '../src/lib/content.js';

const FIELDS = [
  { field_id: 'summary', field_kind: FIELD_KIND.TEXT, store_values: true },
  { field_id: 'priority', field_kind: FIELD_KIND.SCALAR, store_values: true }
];

function reviewFor(issueFields, extra = {}) {
  const { contentHash, digests } = project(issueFields, FIELDS);
  return {
    issue_id: 1,
    baseline_id: Buffer.from('x'),
    baseline_version: 1,
    content_hash: contentHash,
    field_digests: JSON.stringify(digests),
    state: REVIEW_STATE.BASELINED,
    version: 0,
    ...extra
  };
}

const APPROVED = { summary: 'Ship it', priority: { id: '3' } };

// ─── What does and does not disarm a standing baseline ───────────────────────

test('ONWARD workflow movement does not disarm a baseline', () => {
  // The easy mistake would be to void a baseline the moment the item leaves the
  // status it was approved in. That is fatal here: a reviewed item is SUPPOSED
  // to keep moving through the workflow afterwards, and a baseline that
  // evaporates on the next transition protects nothing.
  const prior = reviewFor(APPROVED);
  const result = supersedeOnReviewEntry({
    prior,
    currentStatusId: '10002',        // In Progress — not a review status
    reviewStatusIds: ['10001'],
    now: 1000
  });
  assert.equal(result.superseded, false);
  assert.equal(result.review.baseline_id, prior.baseline_id);
});

test('re-entering a review status DOES disarm the baseline', () => {
  const prior = reviewFor(APPROVED);
  const result = supersedeOnReviewEntry({
    prior,
    currentStatusId: '10001',
    reviewStatusIds: ['10001'],
    now: 1000
  });
  assert.equal(result.superseded, true);
  assert.equal(result.review.baseline_id, null);
  assert.equal(result.review.state, REVIEW_STATE.ARCHIVED);
});

test('THE ONE EXCEPTION: drift already recorded is not wiped by returning to review', () => {
  // Somebody changed approved content while the approval stood; sending the
  // item back to review must not be a way to make that disappear.
  const prior = reviewFor(APPROVED, { state: REVIEW_STATE.DRIFTED });
  const result = supersedeOnReviewEntry({
    prior,
    currentStatusId: '10001',
    reviewStatusIds: ['10001'],
    now: 1000
  });
  assert.equal(result.superseded, false);
  assert.equal(result.review.state, REVIEW_STATE.DRIFTED);
});

test('an unknown current status changes nothing rather than guessing', () => {
  const prior = reviewFor(APPROVED);
  const result = supersedeOnReviewEntry({
    prior, currentStatusId: null, reviewStatusIds: ['10001'], now: 1000
  });
  assert.equal(result.superseded, false);
});

// ─── observe ─────────────────────────────────────────────────────────────────

test('an unrelated event on unchanged content is NO_CHANGE', () => {
  const prior = reviewFor(APPROVED);
  const result = observe({
    prior,
    baselineDigests: JSON.parse(prior.field_digests),
    issueFields: APPROVED,
    controlledFields: FIELDS,
    reviewStatusIds: ['10001'],
    currentStatusId: '10002',
    now: 2000
  });
  assert.equal(result.outcome, OUTCOME.NO_CHANGE);
});

test('a changed controlled field is recorded as drift, with from/to digests', () => {
  const prior = reviewFor(APPROVED);
  const result = observe({
    prior,
    baselineDigests: JSON.parse(prior.field_digests),
    issueFields: { ...APPROVED, priority: { id: '1' } },
    controlledFields: FIELDS,
    reviewStatusIds: ['10001'],
    currentStatusId: '10002',
    now: 2000
  });

  assert.equal(result.outcome, OUTCOME.DRIFT_RECORDED);
  assert.deepEqual(result.changedFields, ['priority']);
  assert.ok(result.fromDigests.priority);
  assert.ok(result.toDigests.priority);
  assert.notEqual(result.fromDigests.priority, result.toDigests.priority);
  assert.equal(result.review.state, REVIEW_STATE.DRIFTED);
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BS-21 REPRODUCTION.
 *
 * Production, 21:18:36Z: `updated: drift BS-21 inserted:302 driftCount:604`, on
 * a work item nobody had edited, listing 302 customfield_* ids that are not on
 * that issue's screen. Same shape on BS-11 from the reconcile sweep.
 *
 * The item's own fields were untouched. What moved was the TRACKED SET: the
 * baseline had been captured when the project tracked everything Jira had, and
 * the comparison now runs over the fields actually in scope for the issue. Every
 * key that existed only in the baseline came back as a changed field.
 *
 * That is what put the "this work item changed while you were reading it"
 * banner in front of a reviewer who was looking at an unchanged item, because
 * the evidence hash is computed over the same set arithmetic.
 * ─────────────────────────────────────────────────────────────────────────────
 */
test('narrowing the tracked set does not invent drift on an untouched item', () => {
  // Baselined when `legacy` was tracked. Nothing about the item has changed.
  const wideFields = [
    ...FIELDS,
    { field_id: 'legacy', field_kind: FIELD_KIND.SCALAR, store_values: false }
  ];
  const { digests: wideDigests } = project(APPROVED, wideFields);

  const prior = {
    issue_id: 1,
    baseline_id: Buffer.from('x'),
    baseline_version: 1,
    field_digests: JSON.stringify(wideDigests),
    state: REVIEW_STATE.BASELINED,
    version: 0
  };

  const result = observe({
    prior,
    baselineDigests: wideDigests,
    issueFields: APPROVED,          // IDENTICAL to what was approved
    controlledFields: FIELDS,       // `legacy` is no longer in scope
    reviewStatusIds: ['10001'],
    currentStatusId: '10002',
    now: 2000
  });

  assert.equal(result.outcome, OUTCOME.NO_CHANGE);
  assert.deepEqual(result.changedFields ?? [], []);
});

test('a real edit is still caught when the tracked set has also narrowed', () => {
  // The guard above must not become a way for a genuine change to pass through
  // simply because the scope moved at the same time.
  const wideFields = [
    ...FIELDS,
    { field_id: 'legacy', field_kind: FIELD_KIND.SCALAR, store_values: false }
  ];
  const { digests: wideDigests } = project(APPROVED, wideFields);

  const prior = {
    issue_id: 1,
    baseline_id: Buffer.from('x'),
    baseline_version: 1,
    field_digests: JSON.stringify(wideDigests),
    state: REVIEW_STATE.BASELINED,
    version: 0
  };

  const result = observe({
    prior,
    baselineDigests: wideDigests,
    issueFields: { ...APPROVED, priority: { id: '1' } },
    controlledFields: FIELDS,
    reviewStatusIds: ['10001'],
    currentStatusId: '10002',
    now: 2000
  });

  assert.equal(result.outcome, OUTCOME.DRIFT_RECORDED);
  assert.deepEqual(result.changedFields, ['priority']);
});

test('editing a field back to its approved value returns the item to BASELINED', () => {
  // Somebody reverting their own edit is not drift a reviewer needs to act on.
  // The drift rows already written stay — the change happened — but the item
  // leaves the queue.
  const baseline = project(APPROVED, FIELDS);
  const drifted = reviewFor({ ...APPROVED, priority: { id: '1' } }, { state: REVIEW_STATE.DRIFTED });

  const result = observe({
    prior: drifted,
    baselineDigests: baseline.digests,
    issueFields: APPROVED,
    controlledFields: FIELDS,
    reviewStatusIds: ['10001'],
    currentStatusId: '10002',
    now: 3000
  });

  assert.equal(result.outcome, OUTCOME.SELF_REVERTED);
  assert.equal(result.review.state, REVIEW_STATE.BASELINED);
});

test('a decision or restore in flight blocks observation entirely', () => {
  // Without this, a restore records its OWN writes as fresh drift and the
  // reviewer's reversion lands back in their queue.
  for (const state of [REVIEW_STATE.RESTORING, REVIEW_STATE.DECIDING]) {
    const result = observe({
      prior: reviewFor(APPROVED, { state }),
      baselineDigests: {},
      issueFields: { ...APPROVED, summary: 'changed' },
      controlledFields: FIELDS,
      now: 4000
    });
    assert.equal(result.outcome, OUTCOME.BUSY);
  }
});

test('an item that has never been approved is edited freely — no drift, ever', () => {
  const result = observe({
    prior: { issue_id: 1, baseline_id: null, state: REVIEW_STATE.ARCHIVED, version: 0 },
    baselineDigests: null,
    issueFields: { summary: 'anything' },
    controlledFields: FIELDS,
    now: 5000
  });
  assert.equal(result.outcome, OUTCOME.NO_BASELINE);
});

test('no controlled fields means the app has nothing to say', () => {
  const result = observe({
    prior: reviewFor(APPROVED),
    baselineDigests: {},
    issueFields: APPROVED,
    controlledFields: [],
    now: 6000
  });
  assert.equal(result.outcome, OUTCOME.NOT_CONTROLLED);
});

test('a corrupt digest map degrades to over-reporting once rather than throwing', () => {
  const prior = reviewFor(APPROVED, { field_digests: 'not json' });
  const result = observe({
    prior,
    baselineDigests: {},
    issueFields: { ...APPROVED, summary: 'new' },
    controlledFields: FIELDS,
    now: 7000
  });
  assert.equal(result.outcome, OUTCOME.DRIFT_RECORDED);
  // Reports every field as changed, then self-corrects on the next observation.
  assert.deepEqual(result.changedFields.sort(), ['priority', 'summary']);
});
