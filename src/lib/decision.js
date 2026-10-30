import { REVIEW_STATE, lockLeaseMs } from './interception.js';
import { MATERIALITY } from './materiality.js';

/**
 * Define reviewer-decision rules without I/O.
 *
 * Automatic revert needs retained raw values. revertsField requires explicit
 * per-field retention and names every field it cannot restore. The caller
 * supplies rows and now; these functions return the required writes so tests
 * can exercise the rules without Jira or a database.
 */

export const DECISION = { APPROVE: 'APPROVE', REJECT: 'REJECT', MIXED: 'MIXED' };

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
    'None of the changed fields have their contents retained, so nothing can be written back. An administrator can turn retention on for a field in Baseline\'s field settings. This applies from the next approval onward because capture stores the values.',
  AUTH_REQUIRED:
    'This decision has to be confirmed on your device before it can be recorded. Use Face ID, Touch ID or Windows Hello. If no biometric is available, use your device PIN or password, then try again.',
  STALE_EVIDENCE:
    'This work item changed while you were reading it. The panel has reloaded with the new changes. Review them before deciding.'
};


export { LOCK_TTL_MS, RESTORE_LEASE_MS, lockLeaseMs } from './interception.js';

export function canDecide({ review, baseline, isEligible, authRequired = false, authVerified = false, now = Date.now(), lockTtlMs = lockLeaseMs(review?.state) }) {
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
 * Determine the effects of approval or rejection.
 *
 * @param decision APPROVE | REJECT.
 * @param diff From lib/diff/index.js.
 * @param plan From lib/restore/planner.js, required only for REJECT.
 * @param evidenceHash Hash displayed when the reviewer clicked.
 *
 * Refuse the decision and reload when current evidence differs from the hash
 * the reviewer saw. Otherwise an edit made during review could receive a
 * signature without review.
 */
export function decide({ decision, diff, plan = null, evidenceHash = null, approvedCount = null }) {
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
      // Approval ratifies current content and captures a new baseline. Retain drift
      // rows with this decision so the audit trail records the changes and acceptance.
      cutsNewBaseline: true,
      // Every outstanding change is now decided, which is what removes them
      // from the reviewer's queue.
      marksDriftDecided: true,
      appliesTransition: true
    };
  }

  if (decision === DECISION.MIXED) {
    // A per-field decision (lib/approval/mixedDecision.js). Rejected fields are
    // restored and the resulting state is then published as the next baseline.
    // When EVERY field is rejected the item simply returns to the standing
    // baseline, exactly as a whole-set reject does, so no new version is cut.
    // The restore plan is scoped by the mixed module, not passed here.
    if (diff.changedFieldCount === 0) return { allow: false, reason: REFUSE.NO_DRIFT };
    return { allow: true, decision, cutsNewBaseline: approvedCount == null ? true : approvedCount > 0,
      marksDriftDecided: true, appliesTransition: false, restores: true };
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
      // Rejection restores the existing baseline. Do not capture a new one that
      // would incorrectly attribute a fresh approval to the rejecting reviewer.
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
 * Choose review state after a decision.
 *
 * If restore finishes and verification identifies remaining field differences,
 * return DRIFTED. The panel can list those fields and offer another restore or
 * decision. The gate reports UNDECIDED_DRIFT.
 *
 * If a batch could not run, verification could not read the issue or restore
 * stopped midway, return ERROR. The current state is unknown and needs an
 * operational retry, not a review decision. ERROR blocks controlled transitions
 * with RESTORE_IN_PROGRESS or ITEM_BUSY; uncontrolled transitions still depend
 * on drift.
 *
 * COMPLETE_WITH_REPLACEMENTS counts as success. Previously omitting it sent
 * correctly verified recreated work items to ERROR.
 */
export function stateAfter({ decision, restoreState, unmatchedCount = 0 }) {
  if (decision === DECISION.APPROVE) return REVIEW_STATE.BASELINED;
  if (restoreState === 'COMPLETE' || restoreState === 'COMPLETE_WITH_REPLACEMENTS') return REVIEW_STATE.BASELINED;
  if (restoreState === 'PARTIAL' && Number(unmatchedCount) > 0) return REVIEW_STATE.DRIFTED;
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
 * Build the Jira comment after restore. Name what was restored, what was not
 * and who decided, so the people who edited the issue can understand the change.
 * Return ADF as required by Jira's comment endpoint.
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
      lines.push(`• ${p.fieldName}: ${p.reason ?? 'reason not recorded'}`);
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
 * Ask for confirmation after an unusually fast approval of a material change.
 * The panel prompts when the AI report marks the change material and approval
 * follows within a few seconds. It does not refuse the decision.
 */
export function needsConfirmation({ diff, report, dwellMs }) {
  if (diff.maxMateriality !== MATERIALITY.CRITICAL) return false;
  if (report?.verdictHint === 'no_material_change') return false;
  return dwellMs != null && dwellMs < 5000;
}
