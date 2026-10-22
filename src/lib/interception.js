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
 * HOW LONG AN OPERATION LOCK IS TRUSTED WITHOUT A HEARTBEAT. The one
 * definition; every reader of a DECIDING or RESTORING row asks this.
 *
 * A decision runs inside one resolver call, so a minute is generous. A restore
 * does not: it is queued, waits for delivery, and its worker may spend up to
 * its 600 s timeout on one batch (jobs/restoreWorker.js heartbeats the row
 * between batches). A minute there declared a running restore abandoned, and
 * the collectors and a second reviewer then acted underneath it.
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
 * WHICH TRACKED FIELDS NO LONGER MATCH THE SIGNATURE — the whole definition of
 * drift, as one pure function.
 *
 * DRIFT IS DERIVED, NOT COUNTED. It used to be a number on va_item_state that
 * the collector wrote and the decision paths zeroed, which made it a second
 * answer to a question the content already settles — and on VJIRA-17 the two
 * disagreed permanently: the row said 0 while the live comparison said one
 * field had moved, so the panel showed a change it would not let anyone decide.
 * A stored counter can be missed, double-cleared or left stale by any path that
 * forgets to update it. A comparison cannot.
 *
 * So this is the single implementation, and observe() and the panel summary
 * both call it. They cannot disagree about what drift is, because there is only
 * one place that decides.
 *
 * A BASELINE THAT CANNOT BE READ REPORTS EVERYTHING, for the reason spelled out
 * in observe() below: an absence of digests is not evidence of a match, and
 * concluding "clean" from it would report a corrupt baseline as an approved one.
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
    // FAILS TOWARDS DRIFT, for the same reason as an unreadable baseline.
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

  // ── ONE COMPARISON, USED FOR BOTH DECISIONS ────────────────────────────────
  //
  // "Has anything changed?" and "what changed?" are now the same question asked
  // once, and they cannot disagree.
  //
  // They used to be two. The no-change fast path required the key COUNTS to
  // match — `Object.keys(currentDigests).length === Object.keys(bDigests).length`
  // — so a baseline carrying 302 keys compared against a projection over 4 fell
  // straight through it, whatever the values were. The item was then recorded as
  // DRIFTED on the strength of a set difference alone, which is how an untouched
  // work item acquired 302 drift rows.
  //
  // Deriving the answer from the scoped field list closes that: if no field in
  // scope moved, there is no change, regardless of how the tracked set has been
  // reshaped since the baseline was taken.
  // A BASELINE WE CANNOT READ IS NOT A BASELINE THAT MATCHES.
  //
  // This is the one case that must NOT get the treatment above. An empty or
  // unparseable digest map means the approved state is unknown — and because
  // the scoped comparison only considers keys the baseline carries, it would
  // find nothing to compare and conclude "nothing changed". Concluding that
  // from an ABSENCE OF EVIDENCE is the one answer this function must never
  // give: it would report a corrupt baseline as a clean one.
  //
  // Over-report instead. The reviewer sees every field once, and the next
  // successful capture self-corrects.
  // driftedFields() is the single definition, shared with the panel summary so
  // the two can never disagree about what counts as drift.
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
