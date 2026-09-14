import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveActions, tierFor, BLOCKER } from '../src/lib/journey.js';

/**
 * THE RULES THAT DECIDE WHAT A SIGNER IS SHOWN.
 *
 * Every case below is drawn from the configuration that produced a real
 * failure on a live instance, not from an invented example — the two Bug rules
 * in project "Jira ALM features":
 *
 *   A. In-Review -> Selected for Development, ESIGNATURE, signed by SDE-1
 *   B. Any status -> Done,                    BIOMETRIC,  signed by SDE-1
 *
 * Standing at In-Review, Jira offers both edges and the same person holds the
 * role on both. That is what made the original bug so hard to see: nothing was
 * unauthorised. The Electronic Signature field, mounted on the "Create
 * Baseline" screen, offered rule B and told the signer "Signing this moves
 * VJIRA-7 to Done" — a true sentence about the wrong transition, shown inside
 * the right dialog.
 *
 * So the assertions that matter here are not about authority. They are about
 * whether the thing being signed is the thing the signer is looking at.
 */

const DONE = '10001';
const SELECTED_FOR_DEV = '10002';

const ruleCreateBaseline = {
  required_role: 'SDE-1',
  required_assurance: 'ESIGNATURE',
  meaning: 'This bug ticket is ready for Dev',
  capture_baseline: true,
  block_on_drift: true,
  from_status_id: '10003',
  to_status_id: SELECTED_FOR_DEV,
  matched_any_status: false
};

const ruleBugDone = {
  required_role: 'SDE-1',
  required_assurance: 'BIOMETRIC',
  meaning: 'Bug Resolved and Baselined',
  capture_baseline: true,
  block_on_drift: true,
  from_status_id: '*',
  to_status_id: DONE,
  matched_any_status: true
};

const createBaseline = { id: '21', name: 'Create Baseline', toStatusId: SELECTED_FOR_DEV, toStatusName: 'Selected for Development' };
const bugDone = { id: '31', name: 'Done', toStatusId: DONE, toStatusName: 'Done' };
/** Jira offers it, we do not control it. The ordinary case for most transitions. */
const backToBacklog = { id: '11', name: 'Backlog', toStatusId: '10000', toStatusName: 'Backlog' };

/** Standing at In-Review with both rules live and the role held on both. */
function atInReview(overrides = {}) {
  return resolveActions({
    offered: [createBaseline, bugDone, backToBacklog],
    gates: [ruleCreateBaseline, ruleBugDone, null],
    eligible: [true, true, false],
    ...overrides
  });
}

test('the electronic signature field is never offered a biometric rule', () => {
  const { actions, blocker } = atInReview({ surface: 'esignature-field' });

  assert.equal(actions.length, 1, 'exactly one edge is signable with an authenticator code here');
  assert.equal(actions[0].transitionId, '21');
  assert.equal(actions[0].toStatusName, 'Selected for Development');
  assert.equal(blocker, null);

  // The regression that matters: the words that appeared in the wrong dialog.
  assert.ok(!actions.some((a) => a.toStatusId === DONE),
    'the Done edge must not reach a surface that cannot perform a device check');
});

test('the biometric field is never offered an authenticator-code rule', () => {
  const { actions, blocker } = atInReview({ surface: 'device-field' });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].transitionId, '31');
  assert.equal(actions[0].requiredAssurance, 'BIOMETRIC');
  assert.equal(blocker, null);
});

test('a rule reachable from any status says so, rather than posing as a step', () => {
  const { actions } = atInReview({ surface: 'device-field' });

  assert.equal(actions[0].anyStatus, true,
    'a standing permission to close from anywhere is a different promise from a step in a sequence');
  assert.equal(actions[0].meaning, 'Bug Resolved and Baselined');
  assert.equal(actions[0].label, 'Sign to move to Done');
});

test('the panel offers every gated edge Jira allows from here', () => {
  // Jira's workflow is the only thing that decides what is possible. If it
  // offers both edges from this status and the signer holds both roles, both
  // are real options and hiding one would be the app overriding the workflow.
  const { actions } = atInReview({ surface: 'panel' });

  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((a) => a.transitionId).sort(), ['21', '31']);
});

test('an ungated transition is not our business and produces no blocker', () => {
  const { actions, blocker, gatedCount } = resolveActions({
    offered: [backToBacklog],
    gates: [null],
    eligible: [false],
    surface: 'panel'
  });

  assert.equal(actions.length, 0);
  assert.equal(gatedCount, 0);
  assert.equal(blocker, null, 'a clean slate is a sentence, not an error');
});

test('holding no role on the only rule names the role rather than the person', () => {
  const { actions, blocker } = resolveActions({
    offered: [createBaseline],
    gates: [ruleCreateBaseline],
    eligible: [false],
    surface: 'esignature-field'
  });

  assert.equal(actions.length, 0);
  assert.equal(blocker, BLOCKER.NOT_ELIGIBLE_FOR_RULE);
});

test('the wrong field on the screen outranks a missing role', () => {
  // Both are true: this person lacks the role AND the screen carries the field
  // that cannot perform the required check. Reporting the role first sends
  // them to their manager; reporting the field sends them to the Jira admin,
  // who is the only one who can actually fix it.
  const { actions, blocker } = resolveActions({
    offered: [bugDone],
    gates: [ruleBugDone],
    eligible: [false],
    surface: 'esignature-field'
  });

  assert.equal(actions.length, 0);
  assert.equal(blocker, BLOCKER.WRONG_FIELD_FOR_RULE);
});

test('a detached validator outranks everything, because nothing downstream is enforced', () => {
  const { actions, blocker } = resolveActions({
    offered: [createBaseline],
    gates: [ruleCreateBaseline],
    eligible: [true],
    enforced: [false],
    surface: 'panel'
  });

  assert.equal(actions.length, 0,
    'a signature the app cannot enforce is worse than no signature at all');
  assert.equal(blocker, BLOCKER.GATE_NOT_ENFORCED);
});

test('an unreadable workflow still shows the button', () => {
  // The opposite of the eligibility rule, and deliberately so. `undefined`
  // means the workflow could not be read, not that it is unprotected. Treating
  // unknown as detached would empty every panel during a Jira outage, and a
  // reviewer could not tell that from "nothing needs signing". gate.js still
  // fails closed at transition time, which is where authority actually lives.
  const { actions, blocker } = resolveActions({
    offered: [createBaseline],
    gates: [ruleCreateBaseline],
    eligible: [true],
    enforced: [undefined],
    surface: 'panel'
  });

  assert.equal(actions.length, 1);
  assert.equal(blocker, null);
});

test('a transition Jira has withdrawn is never offered', () => {
  const { actions, gatedCount } = resolveActions({
    offered: [{ ...createBaseline, isAvailable: false }],
    gates: [ruleCreateBaseline],
    eligible: [true],
    surface: 'panel'
  });

  assert.equal(actions.length, 0);
  assert.equal(gatedCount, 0, 'a signature against a move Jira will refuse is a dead record');
});

test('being asked, not holding a role, is what makes somebody an actor', () => {
  assert.equal(tierFor([]), 'observer');
  assert.equal(tierFor([{ transitionId: '21' }]), 'actor');

  // The case this distinction exists for: somebody who holds SDE-1 but is
  // looking at an item in a status no rule fires from. Showing them decision
  // controls invites a decision the app would then refuse.
  const { actions } = resolveActions({
    offered: [backToBacklog],
    gates: [null],
    eligible: [true],
    surface: 'panel'
  });
  assert.equal(tierFor(actions), 'observer');
});

test('adversarial edge matrix preserves sibling identities and wildcard scope', () => {
  const offered = [
    { id: '41', name: 'Normal approve', toStatusId: '2', toStatusName: 'Done', isAvailable: true },
    { id: '42', name: 'Fast approve', toStatusId: '2', toStatusName: 'Done', isAvailable: true },
    { id: '43', name: 'Close from anywhere', toStatusId: '2', toStatusName: 'Done', isAvailable: true }
  ];
  const gates = [
    { required_role: 'QA', required_assurance: 'ESIGNATURE', matched_any_status: false },
    { required_role: 'QA', required_assurance: 'ESIGNATURE', matched_any_status: false },
    { required_role: 'QA', required_assurance: 'BIOMETRIC', matched_any_status: true }
  ];

  const { actions } = resolveActions({ offered, gates, eligible: [true, true, true], surface: 'panel' });

  assert.deepEqual(actions.map(action => action.transitionId), ['41', '42', '43']);
  assert.deepEqual(actions.map(action => action.anyStatus), [false, false, true]);
  assert.deepEqual(actions.map(action => action.requiredAssurance), ['ESIGNATURE', 'ESIGNATURE', 'BIOMETRIC']);
  assert.equal(new Set(actions.map(action => action.transitionId)).size, 3);
});
