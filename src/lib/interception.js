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

export const OUTCOME = {
  NOT_CONTROLLED: 'NOT_CONTROLLED',
  NO_BASELINE: 'NO_BASELINE',
  NO_CHANGE: 'NO_CHANGE',
  DRIFT_RECORDED: 'DRIFT_RECORDED',
  SELF_REVERTED: 'SELF_REVERTED',
  BUSY: 'BUSY'
};

export function supersedeOnReviewEntry({ prior, currentStatusId, reviewStatusIds, now }) {
  if (!prior || !currentStatusId || !reviewStatusIds?.includes(currentStatusId)) {
    return { superseded: false, review: prior };
  }
  if ([REVIEW_STATE.DRIFTED, REVIEW_STATE.DECIDING, REVIEW_STATE.RESTORING, REVIEW_STATE.LOCKED].includes(prior.state)) {
    return { superseded: false, review: prior };
  }
  return {
    superseded: true,
    review: {
      ...prior,
      baseline_id: null,
      state: REVIEW_STATE.ARCHIVED,
      version: (prior.version || 0) + 1
    }
  };
}

export function observe({ prior, baselineDigests, issueFields, controlledFields, reviewStatusIds, currentStatusId, now }) {
  if (controlledFields.length === 0) return { outcome: OUTCOME.NOT_CONTROLLED, review: prior };
  if (!prior?.baseline_id) return { outcome: OUTCOME.NO_BASELINE, review: prior };
  const isStaleLock = prior.last_checked_at != null && now != null && (Number(now) - Number(prior.last_checked_at) > 60000);
  if ((prior.state === REVIEW_STATE.RESTORING || prior.state === REVIEW_STATE.DECIDING) && !isStaleLock) return { outcome: OUTCOME.BUSY, review: prior };

  let bDigests = baselineDigests;
  if (!bDigests || typeof bDigests !== 'object') {
    try {
      bDigests = typeof prior.field_digests === 'string' ? JSON.parse(prior.field_digests) : (prior.field_digests || {});
    } catch (e) {
      bDigests = {};
    }
  }

  const { contentHash, digests: currentDigests } = project(issueFields, controlledFields);

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
  const baselineReadable = bDigests && Object.keys(bDigests).length > 0;

  let changes = [];
  if (!baselineReadable) {
    changes = controlledFields.map(f => f.field_id);
  } else {
    try {
      changes = changedFields(bDigests, currentDigests, controlledFields.map(f => f.field_id));
    } catch (e) {
      // FAILS TOWARDS DRIFT, for the same reason.
      changes = controlledFields.map(f => f.field_id);
    }
  }

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
export function supersede(args) {
  const result = supersedeOnReviewEntry(args);
  return { ...result, item: result.review };
}
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
  if (!candidateApproval || candidateApproval.state !== 'PENDING') return { allow: false, reason: 'NO_PENDING_APPROVAL' };
  if (candidateApproval.expires_at <= now) return { allow: false, reason: 'APPROVAL_EXPIRED' };
  if (candidateApproval.covers_to_hash !== item.content_hash) return { allow: false, reason: 'CONTENT_CHANGED' };
  return { allow: true, approvalId: candidateApproval.approval_id };
}
