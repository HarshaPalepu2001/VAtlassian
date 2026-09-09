import { REVIEW_STATE } from './interception.js';
import { MATERIALITY } from './materiality.js';

/**
 * The rules governing a reviewer's decision.
 *
 * An automatic revert means retaining the contents of a customer's fields, and
 * crossing that boundary has to be an opt-in, per-field extension — not the
 * default, and not silent. This module is where `revertsField` exists, gated on
 * the per-field retention flag, with everything it cannot restore named out
 * loud.
 *
 * Pure. No I/O, no clock, no database. The caller supplies the rows and `now`;
 * this returns what to write. Kept pure for the same reason interception.js is:
 * these rules decide whether a record may proceed, so they
 * have to be testable without a Jira and without a database.
 */

export const DECISION = { APPROVE: 'APPROVE', REJECT: 'REJECT' };

export const REFUSE = {
  NO_BASELINE: 'NO_BASELINE',
  NO_DRIFT: 'NO_DRIFT',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  ALREADY_DECIDING: 'ALREADY_DECIDING',
  NOTHING_RESTORABLE: 'NOTHING_RESTORABLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  STALE_EVIDENCE: 'STALE_EVIDENCE'
};

/** What the reviewer sees when a decision is refused. */
export const REFUSE_MESSAGE = {
  NO_BASELINE:
    'This work item has not been approved yet, so there is nothing to review against.',
  NO_DRIFT:
    'Nothing has changed since this work item was approved.',
  NOT_ELIGIBLE:
    'You are not an eligible reviewer for this work item.',
  ALREADY_DECIDING:
    'Another decision on this work item is already in progress. Reload the panel in a moment.',
  NOTHING_RESTORABLE:
    'None of the changed fields have their contents retained, so nothing can be written back. An administrator can turn retention on for a field in Baseline\'s field settings — but that only helps from the next approval onward, since values are stored when a baseline is captured.',
  AUTH_REQUIRED:
    'This decision has to be confirmed on your device before it can be recorded. Use Face ID, Touch ID or Windows Hello — or your device PIN or password if no biometric is available — and try again.',
  STALE_EVIDENCE:
    'This work item changed while you were reading it. The panel has reloaded with the new changes — please review them before deciding.'
};


export const LOCK_TTL_MS = 60 * 1000;

export function canDecide({ review, baseline, isEligible, authRequired = false, authVerified = false, now = Date.now(), lockTtlMs = LOCK_TTL_MS }) {
  if (!baseline) return { allow: false, reason: REFUSE.NO_BASELINE };
  if (!isEligible) return { allow: false, reason: REFUSE.NOT_ELIGIBLE };
  if (review?.state === REVIEW_STATE.LOCKED) {
    return { allow: false, reason: REFUSE.ALREADY_DECIDING };
  }
  if ([REVIEW_STATE.DECIDING, REVIEW_STATE.RESTORING].includes(review?.state)) {
    const isStale = review?.last_checked_at != null && (now - Number(review.last_checked_at) > lockTtlMs);
    if (!isStale) {
      return { allow: false, reason: REFUSE.ALREADY_DECIDING };
    }
  }

  if (authRequired && !authVerified) {
    return { allow: false, reason: REFUSE.AUTH_REQUIRED };
  }
  return { allow: true };
}

/**
 * Decide what an approve or reject means.
 *
 * @param decision       APPROVE | REJECT
 * @param diff           from lib/diff/index.js
 * @param plan           from lib/restore/planner.js — only needed for REJECT
 * @param evidenceHash   the hash the panel was rendering when the reviewer
 *                       clicked
 *
 * THE STALE-EVIDENCE CHECK IS NOT OPTIONAL. A reviewer reads a diff, somebody
 * edits the item, and the reviewer clicks Approve — approving a version they
 * never saw. The panel sends back the evidence hash it rendered; if the current
 * evidence differs, the decision is refused and the panel reloads.
 */
export function decide({ decision, diff, plan = null, evidenceHash = null }) {
  if (!diff) return { allow: false, reason: REFUSE.NO_BASELINE };

  if (evidenceHash != null && evidenceHash !== diff.evidenceHash) {
    return { allow: false, reason: REFUSE.STALE_EVIDENCE };
  }

  if (diff.changedFieldCount === 0 && decision === DECISION.REJECT) {
    // Formatting changes are still changes to the signed record.
    return { allow: false, reason: REFUSE.NO_DRIFT };
  }

  if (decision === DECISION.APPROVE) {
    return {
      allow: true,
      decision,
      // Approve means RATIFY THE DRIFT: the current state becomes the approved
      // state, and a new baseline is cut from it. It does not mean "ignore" —
      // the drift rows stay, stamped with this decision, so the trail still
      // shows what was changed and who accepted it.
      cutsNewBaseline: true,
      // Every outstanding change is now decided, which is what removes them
      // from the reviewer's queue.
      marksDriftDecided: true,
      appliesTransition: true
    };
  }

  if (decision === DECISION.REJECT) {
    if (!plan) return { allow: false, reason: REFUSE.NOTHING_RESTORABLE };
    const restorable = plan.steps.filter((s) => s.strategy !== 'none');
    if (restorable.length === 0) {
      return { allow: false, reason: REFUSE.NOTHING_RESTORABLE };
    }

    return {
      allow: true,
      decision,
      // No new baseline. The point of a rejection is that the STANDING baseline
      // was right all along and the item is being returned to it — cutting a
      // new one would quietly re-approve the restored state under the
      // reviewer's name, which is not what they did.
      cutsNewBaseline: false,
      marksDriftDecided: true,
      appliesTransition: false,
      restores: true,
      plan
    };
  }

  return { allow: false, reason: REFUSE.NO_DRIFT };
}

/**
 * Where the review row lands after a decision.
 *
 * A rejection returns the item to BASELINED only when the restore fully
 * verified. A partial restore leaves ERROR, on purpose: the item is neither at
 * its approved state nor honestly drifted, and the one thing that must not
 * happen is it quietly re-entering the queue as though nothing went wrong.
 * ERROR is visible in the admin console and says what failed.
 */
export function stateAfter({ decision, restoreState }) {
  if (decision === DECISION.APPROVE) return REVIEW_STATE.BASELINED;
  if (restoreState === 'COMPLETE') return REVIEW_STATE.BASELINED;
  return REVIEW_STATE.ERROR;
}

/**
 * The counters va_item_state carries after a decision.
 *
 * Zeroed on approve and on a complete restore, because every outstanding change
 * has been decided. Left intact on a partial restore so the queue keeps showing
 * an item that still needs attention.
 */
export function countersAfter({ decision, restoreState, diff }) {
  if (decision === DECISION.APPROVE || restoreState === 'COMPLETE') {
    return { driftCount: 0, driftedFieldCount: 0, maxMateriality: null };
  }
  return undecidedCounters(diff);
}

/**
 * The counters for an item that still has drift nobody has decided.
 *
 * `drift_count` is everything that changed; `drifted_field_count` is the subset
 * that a reader would notice, and both the glance view and the reviewer queue
 * read the second one back as `materialCount`. Writing the total into it says
 * more of the drift needs a decision than actually does.
 *
 * Defined once because it is built in more than one place, and the copy in
 * usecases/drift.js had already diverged.
 */
export function undecidedCounters(diff) {
  return {
    driftCount: diff?.changedFieldCount ?? 0,
    driftedFieldCount: diff?.materialFieldCount ?? 0,
    maxMateriality: diff?.maxMateriality ?? null
  };
}

/**
 * The comment Baseline leaves on the work item after a restore.
 *
 * Left at all because the people who made the changes are not the people
 * reading the reviewer's queue, and an item silently reverting under them is
 * both confusing and slightly hostile. The comment names what was put back,
 * what was not, and who decided — so the conversation happens on the work item
 * where it belongs rather than in a support ticket.
 *
 * Returns ADF, because Jira's comment endpoint takes ADF and building it here
 * keeps the wording in one place instead of scattered across resolvers.
 */
export function restoreComment({ actorName, counters, state, detail, baselineVersion }) {
  const lines = [];

  lines.push(
    state === 'COMPLETE'
      ? `${actorName} rejected the changes made since this work item was approved. All ${counters.succeeded} changed field(s) have been returned to their approved values (baseline v${baselineVersion}).`
      : `${actorName} rejected the changes made since this work item was approved. ${counters.succeeded} field(s) were returned to their approved values (baseline v${baselineVersion}); ${counters.failed + counters.irreversible + counters.skipped} could not be.`
  );

  const problems = (detail ?? []).filter((d) => d.outcome !== 'succeeded');
  if (problems.length > 0) {
    lines.push('Not restored:');
    for (const p of problems.slice(0, 10)) {
      lines.push(`• ${p.fieldName} — ${p.reason ?? 'reason not recorded'}`);
    }
  }

  lines.push('If these changes were needed, make them again and they will be reviewed on the next approval.');

  return {
    type: 'doc',
    version: 1,
    content: lines.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }]
    }))
  };
}

/**
 * Should this decision block until the reviewer has actually read something?
 *
 * A deliberately small nudge rather than a gate: if the AI report says the
 * change is material and the reviewer approves within a few seconds of the
 * panel opening, the panel asks them to confirm. It never refuses — a reviewer
 * who already knows what changed should not be lectured by their tools — but a
 * one-click approval of a critical scope change deserves one question.
 */
export function needsConfirmation({ diff, report, dwellMs }) {
  if (diff.maxMateriality !== MATERIALITY.CRITICAL) return false;
  if (report?.verdictHint === 'no_material_change') return false;
  return dwellMs != null && dwellMs < 5000;
}
