import test from 'node:test';
import assert from 'node:assert/strict';
import { canDecide, REFUSE, LOCK_TTL_MS, RESTORE_LEASE_MS, lockLeaseMs } from '../src/lib/decision.js';
import { REVIEW_STATE, observe, OUTCOME } from '../src/lib/interception.js';
import { createApprovalUsecases } from '../src/usecases/approval.js';

const baseline = {
  baseline_id: Buffer.alloc(16, 1),
  version: 1,
  content_hash: 'c'.repeat(64),
  field_digests: JSON.stringify({ summary: 's'.repeat(64) })
};

test('an active DECIDING or RESTORING lock (< 60s) refuses decisions', () => {
  const now = 100000;
  for (const state of [REVIEW_STATE.DECIDING, REVIEW_STATE.RESTORING]) {
    const activeRecent = canDecide({
      review: { state, last_checked_at: now - 10000 },
      baseline,
      isEligible: true,
      now
    });
    assert.equal(activeRecent.allow, false);
    assert.equal(activeRecent.reason, REFUSE.ALREADY_DECIDING);

    const activeDefault = canDecide({
      review: { state },
      baseline,
      isEligible: true,
      now
    });
    assert.equal(activeDefault.allow, false);
    assert.equal(activeDefault.reason, REFUSE.ALREADY_DECIDING);
  }
});

test('a stale DECIDING or RESTORING lock (past its lease) allows decisions to proceed', () => {
  const now = 10_000_000;
  for (const state of [REVIEW_STATE.DECIDING, REVIEW_STATE.RESTORING]) {
    const staleResult = canDecide({
      review: { state, last_checked_at: now - (lockLeaseMs(state) + 1000) },
      baseline,
      isEligible: true,
      now
    });
    assert.equal(staleResult.allow, true);
  }
});

test('a RESTORING lock outlives the decision TTL: a queued restore is not abandoned after a minute', () => {
  // The queued worker may wait for delivery and runs up to 600 s per batch.
  // Treating it as abandoned at 60 s let a collector overwrite RESTORING with
  // DRIFTED, and a second reviewer decide, while it was still writing.
  const now = 10_000_000;
  const restoring = { state: REVIEW_STATE.RESTORING, last_checked_at: now - (LOCK_TTL_MS + 1000) };
  assert.ok(RESTORE_LEASE_MS > 600_000, 'the lease covers a whole worker invocation');
  assert.equal(canDecide({ review: restoring, baseline, isEligible: true, now }).allow, false);
  const observed = observe({ prior: { issue_id: 1, baseline_id: 'b'.repeat(16), ...restoring,
    field_digests: JSON.stringify({ summary: 'digest1' }) }, baselineDigests: { summary: 'digest1' },
  issueFields: { summary: 'x' }, controlledFields: [{ field_id: 'summary', field_kind: 'TEXT' }], now });
  assert.equal(observed.outcome, OUTCOME.BUSY);
  assert.equal(canDecide({ review: { ...restoring, state: REVIEW_STATE.DECIDING }, baseline, isEligible: true, now }).allow, true,
    'a DECIDING lock keeps its one-minute lease');
});

test('a durable record lock does not expire as an operation lease', () => {
  const now = 100000;
  const result = canDecide({
    review: { state: REVIEW_STATE.LOCKED, last_checked_at: now - (LOCK_TTL_MS + 1000) },
    baseline,
    isEligible: true,
    now
  });

  assert.equal(result.allow, false);
  assert.equal(result.reason, REFUSE.ALREADY_DECIDING);
});

test('observe() does not return BUSY when lock is stale', () => {
  const now = 100000;
  const result = observe({
    prior: {
      issue_id: 1,
      baseline_id: 'b'.repeat(16),
      state: REVIEW_STATE.RESTORING,
      last_checked_at: now - (RESTORE_LEASE_MS + 1000),
      field_digests: JSON.stringify({ summary: 'digest1' })
    },
    baselineDigests: { summary: 'digest1' },
    issueFields: { summary: 'digest1' },
    controlledFields: [{ field_id: 'summary', field_kind: 'TEXT' }],
    now
  });
  assert.notEqual(result.outcome, OUTCOME.BUSY);
});

test('approval.challenge() returns structured failure without throwing uncaught when blocked', async () => {
  const deps = {
    now: () => Date.now(),
    writeChallenge: async () => Buffer.alloc(16),
    getChallenge: async () => null,
    markChallengeConsumed: async () => true,
    issue: async () => ({ id: 1, issueId: 1, issueKey: 'TEST-1', projectId: 1, issueTypeId: '1', statusId: '1' }),
    actor: async () => ({ accountId: 'user-1', displayName: 'User One' }),
    prepare: async () => {
      const err = new Error('ALREADY_DECIDING');
      err.reason = 'ALREADY_DECIDING';
      throw err;
    }
  };

  const api = createApprovalUsecases(deps);
  const result = await api.challenge({
    context: { accountId: 'user-1' },
    payload: { decision: 'REJECT' }
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'ALREADY_DECIDING');
  assert.match(result.error, /another decision.*already in progress/i);
});

test('approval.challenge() succeeds when prepareApproval passes', async () => {
  const challengeId = Buffer.alloc(16, 9);
  const deps = {
    now: () => 100000,
    writeChallenge: async () => challengeId,
    getChallenge: async () => null,
    markChallengeConsumed: async () => true,
    issue: async () => ({ id: 1, issueId: 1, issueKey: 'TEST-1', projectId: 1, issueTypeId: '1', statusId: '1' }),
    actor: async () => ({ accountId: 'user-1', displayName: 'User One' }),
    transition: async () => null,
    edge: async () => ({
      required_role: 'approver',
      required_assurance: 'NATIVE_TRANSITION',
      meaning: 'I approve this work item',
      capture_baseline: true,
      block_on_drift: true
    }),
    eligible: async () => true,
    prepare: async () => ({
      contentHash: 'hash1',
      evidenceHash: 'ev1'
    })
  };

  const api = createApprovalUsecases(deps);
  const result = await api.challenge({
    context: { accountId: 'user-1' },
    payload: { decision: 'APPROVE' }
  });

  assert.equal(result.success, true);
  assert.equal(result.challengeId, challengeId.toString('hex'));
});
