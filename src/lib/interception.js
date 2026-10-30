import { project, changedFields, GENESIS_CONTENT } from './content.js';

export const REVIEW_STATE = {
  UNAPPROVED: 'UNAPPROVED',
  LOCKED: 'LOCKED',
  DECIDING: 'DECIDING',
  RESTORING: 'RESTORING',
  BASELINED: 'BASELINED',
  ERROR: 'ERROR',
  DRIFTED: 'DRIFTED',
  ARCHIVED: 'ARCHIVED'
};

/**
 * Maximum operation-lock age without a heartbeat, shared by readers of
 * DECIDING and RESTORING rows.
 *
 * A decision runs within one resolver call, so one minute suffices. A queued
 * restore can wait for delivery and spend up to its 600-second worker timeout
 * on a batch. jobs/restoreWorker.js heartbeats between batches. Applying the
 * one-minute limit there let collectors and another reviewer act during restore.
 */
export const LOCK_TTL_MS = 60 * 1000;
export const RESTORE_LEASE_MS = 11 * 60 * 1000;
export function lockLeaseMs(state) {
  return state === REVIEW_STATE.RESTORING ? RESTORE_LEASE_MS : LOCK_TTL_MS;
}
/** A DECIDING/RESTORING row whose last heartbeat is older than its lease. Null is never stale. */
export function isStaleLock(review, now) {
  return review?.last_checked_at != null && now != null
    && Number(now) - Number(review.last_checked_at) > lockLeaseMs(review.state);
}

export const OUTCOME = {
  NOT_CONTROLLED: 'NOT_CONTROLLED',
  NO_BASELINE: 'NO_BASELINE',
  NO_CHANGE: 'NO_CHANGE',
  DRIFT_RECORDED: 'DRIFT_RECORDED',
  SELF_REVERTED: 'SELF_REVERTED',
  BUSY: 'BUSY'
};

/**
 * Compare tracked-field digests to derive drift instead of trusting a counter.
 *
 * Collectors wrote va_item_state counters and decision paths cleared them.
 * A missed update could leave the stored count at zero while live fields
 * differed, as on VJIRA-17. observe() and the panel summary now share this
 * comparison so their drift counts agree.
 *
 * Unreadable baseline digests report all scoped fields as changed. Missing
 * digests do not establish that the current content matches the approval.
 */
export function driftedFields({ baselineDigests, issueFields, controlledFields, linkPolicy, issue }) {
  const fields = controlledFields ?? [];
  const ids = fields.map((f) => f.field_id);
  const { contentHash, digests } = project(issueFields, fields, { linkPolicy, issue });

  let bDigests = baselineDigests;
  if (typeof bDigests === 'string') {
    try { bDigests = JSON.parse(bDigests); } catch { bDigests = null; }
  }
  if (!bDigests || typeof bDigests !== 'object' || Object.keys(bDigests).length === 0) {
    return { changed: ids, contentHash, digests, baselineReadable: false };
  }

  try {
    return { changed: changedFields(bDigests, digests, ids), contentHash, digests, baselineReadable: true };
  } catch {
    // Report drift when the baseline is unreadable.
    return { changed: ids, contentHash, digests, baselineReadable: false };
  }
}

export function observe({ prior, baselineDigests, issueFields, controlledFields, now, linkPolicy, issue }) {
  if (controlledFields.length === 0) return { outcome: OUTCOME.NOT_CONTROLLED, review: prior };
  if (!prior?.baseline_id) return { outcome: OUTCOME.NO_BASELINE, review: prior };
  if ((prior.state === REVIEW_STATE.RESTORING || prior.state === REVIEW_STATE.DECIDING) && !isStaleLock(prior, now)) return { outcome: OUTCOME.BUSY, review: prior };

  let bDigests = baselineDigests;
  if (!bDigests || typeof bDigests !== 'object') {
    try {
      bDigests = typeof prior.field_digests === 'string' ? JSON.parse(prior.field_digests) : (prior.field_digests || {});
    } catch (e) {
      bDigests = {};
    }
  }

  const { contentHash, digests: currentDigests } = project(issueFields, controlledFields, { linkPolicy, issue });

  // Use one scoped comparison for both change detection and changed-field names.
  // The earlier key-count check treated a 302-key baseline and four-field current
  // scope as drift even when scoped values matched.
  //
  // An empty or invalid baseline digest map is different: the approved state is
  // unknown. A scoped comparison would find no keys and falsely report clean.
  // Report every field instead until a successful capture repairs the baseline.
  // Share driftedFields() with the panel summary so both counts agree.
  const changes = driftedFields({ baselineDigests: bDigests, issueFields, controlledFields, linkPolicy, issue }).changed;

  if (changes.length === 0) {
    // Returning values by hand does not erase the outstanding review decision.
    return { outcome: OUTCOME.NO_CHANGE, review: { ...prior, last_checked_at: now } };
  }

  return {
    outcome: OUTCOME.DRIFT_RECORDED,
    changedFields: changes,
    fromDigests: bDigests,
    toDigests: currentDigests,
    review: { ...prior, state: REVIEW_STATE.DRIFTED, content_hash: contentHash,
      field_digests: JSON.stringify(currentDigests), last_checked_at: now, last_drift_at: now }
  };
}

export const ITEM_STATE = REVIEW_STATE;
export const SIGN_MODE = { SIGN_CURRENT: 'SIGN_CURRENT', APPROVE_DELTA: 'APPROVE_DELTA', GATE_TRANSITION: 'GATE_TRANSITION', DECLINE: 'DECLINE' };
export function coverage({ item, mode }) {
  const from = item?.baseline_hash ?? GENESIS_CONTENT;
  const to = item?.content_hash;
  if (!to) throw new Error('cannot compute coverage for an unobserved item');
  if (mode === SIGN_MODE.APPROVE_DELTA && from === GENESIS_CONTENT) return { valid: false, reason: 'NO_BASELINE_TO_COMPARE' };
  if (from === to) return { valid: false, reason: 'NOTHING_TO_SIGN' };
  return { valid: true, covers_from_hash: from, covers_to_hash: to, sign_mode: mode };
}
export function applyApproval({ item, coversToHash, baselineStatusId = null, now }) {
  return { ...item, baseline_hash: coversToHash, baseline_status_id: baselineStatusId,
    state: item.content_hash === coversToHash ? REVIEW_STATE.BASELINED : REVIEW_STATE.DRIFTED, last_checked_at: now };
}
export const applySignature = applyApproval;
export function gateDecision({ item, candidateApproval, now }) {
  if (!item) return { allow: false, reason: 'NOT_CONFIGURED', detail: 'ITEM_NEVER_OBSERVED' };
  if (item.state === REVIEW_STATE.LOCKED) return { allow: false, reason: 'RECORD_LOCKED' };
  if (!candidateApproval || candidateApproval.state !== 'PENDING') return { allow: false, reason: 'NO_PENDING_SIGNATURE' };
  if (candidateApproval.expires_at <= now) return { allow: false, reason: 'SIGNATURE_EXPIRED' };
  if (candidateApproval.covers_to_hash !== item.content_hash) return { allow: false, reason: 'CONTENT_CHANGED' };
  return { allow: true, approvalId: candidateApproval.approval_id };
}
