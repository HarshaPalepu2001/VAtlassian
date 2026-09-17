/**
 * WHAT THIS PERSON CAN SIGN, FROM WHERE THEY ARE STANDING, ON THIS SURFACE.
 *
 * One question, asked by four surfaces: the issue panel, the worklist, and the
 * two transition-screen fields. Before this module each of them answered it
 * differently, and the differences were bugs rather than variations:
 *
 *   - usecases/panel.js returned EVERY gated edge with an `eligible` flag and
 *     left the client to filter, which the panel then did not do — so the
 *     approval dropdown listed edges the reviewer had no authority over.
 *
 *   - frontend/src/field/ApprovalField.tsx filtered on `eligible` but on
 *     nothing else, so the Electronic Signature field mounted on a "Create
 *     Baseline" screen offered "Bug Done (SDE-1 -> Done)" and told the signer
 *     "Signing this moves VJIRA-7 to Done". Signing the wrong edge from inside
 *     the right dialog is the worst failure this product can have: the
 *     signature is real, the meaning shown was true of a DIFFERENT transition.
 *
 * PURE, AND NO I/O. Every input is fetched by the caller. That is not tidiness
 * — the rules below are the ones worth testing exhaustively, and a rule that
 * can only be exercised by standing up Forge SQL does not get exercised. Same
 * split as lib/record.js and lib/transitionPlan.js.
 *
 * JIRA DECIDES WHAT IS POSSIBLE; THIS DECIDES WHAT IS OFFERED. `offered` comes
 * from Jira's own transitions endpoint, read as the user. This module never
 * widens that set — it only removes from it. If Jira will not let this person
 * make the move, no configuration on our side can put a button in front of
 * them, and an app that showed one would be promising something it cannot
 * deliver.
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
  // Custom UI, mounted from the "Biometric Authentication" field. An
  // administrator puts this field on the screen for a biometric rule, so its
  // presence IS the statement of which rule this screen is for.
  'device-field': ['BIOMETRIC']
});

export const BLOCKER = Object.freeze({
  /**
   * A rule exists for this edge, but our validator is not on the transition in
   * Jira — so Jira will never call gate.js and nothing we record can stop the
   * move. Offering a signature here would collect an attestation the app
   * cannot enforce, which is worse than collecting none.
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
    blocksOnDrift: gate.block_on_drift === true,
    anyStatus: gate.matched_any_status === true,
    label: `Sign to move to ${toName}`
  };
}

/**
 * Narrow Jira's offered transitions to the ones this person can sign here.
 *
 * @param {object}   input
 * @param {Array}    input.offered      From lib/transitions.js availableTransitions(), read AS THE USER.
 * @param {Array}    input.gates        gatedTransition() result per offered entry, or null. Parallel array.
 * @param {Array}    input.eligible     isEligible() result per offered entry. Parallel array.
 * @param {Array}    [input.enforced]   Whether OUR validator is attached to that edge in Jira.
 *                                      Parallel array of boolean|undefined; `undefined` means
 *                                      "could not be checked" and is treated as enforced —
 *                                      see the note on failing open below.
 * @param {string}   input.surface      'panel' | 'queue' | 'esignature-field' | 'device-field'
 *
 * @returns {{actions: Array, blocker: string|null, gatedCount: number}}
 *   `actions` is empty or every entry is fully signable by this person on this
 *   surface — no caller filters again. `blocker` is non-null only when a rule
 *   existed and something specific stopped it being offered.
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

    // FAILING OPEN HERE IS DELIBERATE, AND IS THE OPPOSITE OF THE ELIGIBILITY
    // RULE. `undefined` means the workflow could not be read — a Jira outage,
    // a permission gap, a check that has not run yet. Treating "unknown" as
    // "not enforced" would silently empty the panel for every reviewer during
    // an outage, and they would have no way to tell that from "nothing needs
    // signing". The gate itself still fails closed at transition time, in
    // gate.js, where the authority decision actually lives; this flag only
    // decides whether to DRAW a button.
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
 * Does this person have something to do on this work item right now?
 *
 * Deliberately NOT "does this person hold an approver role". Somebody who
 * holds SDE-1 but is looking at an item in a status no rule fires from has
 * nothing to do, and showing them decision controls invites a decision the
 * app would then refuse. Authority is necessary; being asked is what makes
 * somebody an actor.
 *
 * A SIGNED ITEM THAT HAS DRIFTED IS ALSO BEING ASKED. That decision is not a
 * workflow move and does not need one: approving captures a new baseline from
 * the current values, rejecting restores the approved ones, and both are
 * carried out with the item left exactly where it stands. Its authority comes
 * from the gate on the BASELINE's own edge, which is why panelAccess.js
 * resolves the gate from `baseline.from_status_id -> baseline.to_status_id`
 * when no transition is under review. Counting only transitions here told a
 * reviewer their item had a change needing a decision and then gave them the
 * observer card to make it with.
 *
 * @param {Array}   actions               From resolveActions().
 * @param {boolean} [input.decidesDrift]  This person may decide live drift on this item.
 */
export function tierFor(actions, { decidesDrift = false } = {}) {
  return actions.length > 0 || decidesDrift ? 'actor' : 'observer';
}
