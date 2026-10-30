/**
 * Resolve which signing actions a viewer can perform in the current view.
 *
 * The issue panel, worklist and transition-screen fields share these rules.
 * Previously the panel exposed gated transitions without filtering eligibility,
 * and the Electronic Signature field could offer an eligible transition that
 * belonged to a different dialog. A signature must bind the exact transition
 * whose meaning the signer reviewed.
 *
 * Callers fetch all inputs. The rules perform no I/O, so tests can exercise them
 * without Forge SQL. See lib/record.js and lib/transitionPlan.js for the same
 * separation between policy and I/O.
 *
 * The offered set comes from Jira's transitions endpoint, read as the user.
 * This module only removes actions from that set. App configuration cannot
 * authorize a transition Jira refuses to the viewer.
 */

/** Which assurance levels each surface is able to actually carry out. */
const SURFACE_ASSURANCE = Object.freeze({
  // The panel and the worklist run Custom UI in an iframe that can open the
  // WebAuthn ceremony window, so they serve every level.
  panel: null,
  queue: null,
  // UI Kit. Renders declaratively on Atlassian's side with no DOM, no `window`
  // and no `navigator`, so navigator.credentials.get() cannot be called from
  // it at all. A biometric edge on this surface could only ever show a code
  // box, which the server then refuses as INSUFFICIENT_ASSURANCE.
  'esignature-field': ['ESIGNATURE'],
  // Custom UI, mounted from the retired "Biometric Authentication" field
  // before both fields showed one form. Kept for any caller still naming it.
  'device-field': ['BIOMETRIC'],
  // The Custom UI Electronic Signature field supports code entry and the device
  // window. Resolve the exact transition ID through usecases/signing.js before
  // using this table to select its assurance method.
  'signature-field': null
});

export const BLOCKER = Object.freeze({
  /**
 * A rule exists, but Jira does not carry its validator on this transition.
 * Do not offer a signature the app cannot enforce when gate.js will not run.
 */
  GATE_NOT_ENFORCED: 'GATE_NOT_ENFORCED',
  /** The rule needs an assurance this surface cannot perform. */
  WRONG_FIELD_FOR_RULE: 'WRONG_FIELD_FOR_RULE',
  /** The rule is enforceable and on the right surface; this person is not it. */
  NOT_ELIGIBLE_FOR_RULE: 'NOT_ELIGIBLE_FOR_RULE'
});

/**
 * One offered transition, described well enough that nothing downstream has to
 * re-derive anything about it.
 *
 * `label` and `anyStatus` exist so a surface can state the SCOPE of what is
 * being signed. A rule written as "Any status -> Done" is a standing
 * permission to close the item from wherever it happens to be; a rule written
 * as "In-Review -> Selected for Development" is a step in a sequence. Both
 * render as a button, and a reviewer who cannot tell them apart does not know
 * what they just agreed to.
 */
function describeAction(transition, gate) {
  const toName = transition.toStatusName || gate.to_status_id || 'the next status';
  return {
    transitionId: String(transition.id),
    toStatusId: String(transition.toStatusId ?? gate.to_status_id ?? ''),
    toStatusName: transition.toStatusName ?? null,
    name: transition.name ?? null,
    meaning: gate.meaning ?? 'Approved',
    requiredRole: gate.required_role ?? null,
    requiredAssurance: gate.required_assurance ?? null,
    capturesBaseline: gate.capture_baseline === true,
    anyStatus: gate.matched_any_status === true,
    label: `Sign to move to ${toName}`
  };
}

/**
 * Filter Jira's offered transitions to those this person can sign here.
 *
 * @param {object} input
 * @param {Array} input.offered Jira transitions read as the user.
 * @param {Array} input.gates gatedTransition() result or null per offered entry.
 * @param {Array} input.eligible isEligible() result per offered entry.
 * @param {Array} [input.enforced] Validator attachment per offered entry.
 *        undefined means the workflow could not be checked and is treated as
 *        enforced. See the fail-open note below.
 * @param {string} input.surface 'panel' | 'queue' | 'signature-field' |
 *        'esignature-field' | 'device-field'
 *
 * @returns {{actions: Array, blocker: string|null, gatedCount: number}}
 * Every returned action is signable by this viewer in this view; callers need
 * no further filtering. blocker is non-null when an existing rule could not
 * be offered for a specific reason.
 */
export function resolveActions({ offered = [], gates = [], eligible = [], enforced = [], surface = 'panel' } = {}) {
  const allowed = Object.hasOwn(SURFACE_ASSURANCE, surface) ? SURFACE_ASSURANCE[surface] : [];

  // Kept so the caller can tell "no rule applies to this work item at all"
  // (a clean slate, and a plain sentence) apart from "a rule applies but you
  // are not being offered it" (a blocker with a reason).
  let gatedCount = 0;

  // Recorded in narrowing order, so the FIRST cause encountered wins. The
  // order below is deliberate and is the whole reason blockers are ranked:
  // telling somebody they lack a role, when the real problem is that the
  // administrator put the wrong field on the screen, sends them to the wrong
  // person to get it fixed.
  let notEnforced = false;
  let wrongSurface = false;
  let notEligible = false;

  const actions = [];

  for (let i = 0; i < offered.length; i++) {
    const transition = offered[i];
    const gate = gates[i];

    // Jira offers it but we do not control it. Not a blocker and not an error:
    // an ungated transition is simply none of this app's business, and the
    // overwhelming majority of transitions are exactly that.
    if (!gate) continue;

    // Jira says this person cannot perform the move at all. Nothing we know
    // about approvals changes that, and a signature collected against a
    // transition Jira will refuse is a dead record.
    if (transition.isAvailable === false) continue;

    gatedCount += 1;

    // Treat an unread workflow as unknown, not as a missing validator, when
    // rendering actions. Otherwise an outage would remove every reviewer's buttons
    // without explaining why. gate.js still enforces authority and refuses failures
    // when the transition is attempted.
    if (enforced[i] === false) { notEnforced = true; continue; }

    if (allowed && !allowed.includes(gate.required_assurance)) { wrongSurface = true; continue; }

    if (eligible[i] !== true) { notEligible = true; continue; }

    actions.push(describeAction(transition, gate));
  }

  return { actions, gatedCount, blocker: actions.length ? null : firstBlocker() };

  function firstBlocker() {
    if (notEnforced) return BLOCKER.GATE_NOT_ENFORCED;
    if (wrongSurface) return BLOCKER.WRONG_FIELD_FOR_RULE;
    if (notEligible) return BLOCKER.NOT_ELIGIBLE_FOR_RULE;
    // No gate applied to anything Jira offered. There is nothing to explain.
    return null;
  }
}

/**
 * Check whether the viewer has an available action on this item.
 *
 * Holding a role alone is insufficient. A workflow action also needs an
 * applicable transition; otherwise the UI would offer a decision the app refuses.
 *
 * A drift decision does not move the item. Approval captures current values;
 * rejection restores approved values. Authority comes from the baseline's own
 * transition rule. panelAccess.js resolves that rule through
 * baseline.from_status_id and baseline.to_status_id when no transition is under
 * review. Include decidesDrift so eligible reviewers get decision controls even
 * without an offered workflow move.
 *
 * @param {Array} actions From resolveActions().
 * @param {boolean} [input.decidesDrift] Whether this viewer may decide live drift.
 */
export function tierFor(actions, { decidesDrift = false } = {}) {
  return actions.length > 0 || decidesDrift ? 'actor' : 'observer';
}
