/**
 * END-TO-END SCENARIOS FOR THE ONE VALIDATOR.
 *
 * Every scenario runs the real validator and the real panel against a
 * simulated Jira site and database (test/helpers/validator-world.js), changes
 * something the way a Jira admin, a VAtlassian admin or a user would, and
 * checks what the validator and the panel now say.
 *
 * The rules under test:
 *   1. A baselined work item whose tracked content no longer matches its
 *      baseline is HELD on every transition the validator is attached to,
 *      until the change is approved or reverted — whatever happened to the
 *      controlled transitions since.
 *   2. Anything the validator holds, the panel can decide.
 *   3. The signature half is unchanged: controlled transitions need a valid,
 *      unspent, eligible signature over the current content.
 *   4. A project disabled in VAtlassian holds nothing for drift.
 */
import { world, DRIFT, doc, WORKFLOW } from './helpers/validator-world.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWorkflow, FINDING, SEVERITY } from '../src/lib/gateDrift.js';

/** An item that went through the controlled Review -> Done transition with a
 *  real signature, and has the baseline that capture leaves behind. */
async function approvedItem({ key = 'T-1', tree = false, w = world(), fields = {} } = {}) {
  w.createIssue({ key, status: '3', fields });
  if (!w.controlledTransitions.some(r => r.transition_id === '31')) w.control({ transitionId: '31' });
  await w.sign(key, '31');
  const moved = await w.transition(key, '31');
  assert.equal(moved.result, true, 'setup: the signed controlled transition must pass: ' + JSON.stringify(moved));
  w.baseline(key, { transitionId: '31', from: '3', to: '4', tree });
  return w;
}

const heldEverywhere = async (w, key) => {
  const verdicts = await w.verdicts(key);
  assert.ok(Object.keys(verdicts).length > 0, 'no transitions to check');
  for (const [id, r] of Object.entries(verdicts)) {
    assert.equal(r.result, false, `transition ${id} should be held`);
    assert.match(r.errorMessage, DRIFT, `transition ${id} should say drift`);
  }
};
const freeEverywhere = async (w, key) => {
  for (const [id, r] of Object.entries(await w.verdicts(key))) {
    assert.equal(r.result, true, `transition ${id} should pass: ${r.errorMessage}`);
  }
};
const heldFor = r => r.result === false && DRIFT.test(r.errorMessage ?? '');

/** Rule 2: the validator and the panel agree, and a hold is always decidable. */
async function agree(w, key) {
  const panel = await w.panel(key, 'reviewer');
  const verdicts = Object.values(await w.verdicts(key));
  const enabled = w.projectConfig.get(1)?.enabled !== false;
  const held = verdicts.some(heldFor);
  assert.equal(held, enabled && panel.drift.count > 0,
    `validator held=${held} but panel drift count=${panel.drift.count} (enabled=${enabled})`);
  if (held) assert.equal(panel.drift.canApprove, true, 'a held item must be decidable on the panel');
  return { panel, held };
}

// ─── A. The drift hold ──────────────────────────────────────────────────────

test('S01 no baseline and no controlled transitions: every transition passes', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '2' });
  await freeEverywhere(w, 'T-1');
});

test('S02 no baseline: editing tracked content holds nothing', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '2' });
  w.edit('T-1', { summary: 'edited' });
  await freeEverywhere(w, 'T-1');
});

test('S03 baselined and untouched: every uncontrolled transition passes', async () => {
  const w = await approvedItem();
  await freeEverywhere(w, 'T-1');
});

test('S04 baselined and summary edited: every transition is held', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited after approval' });
  await heldEverywhere(w, 'T-1');
});

test('S05 an untracked field changing is not drift', async () => {
  const w = await approvedItem();
  w.edit('T-1', { customfield_200: 'anything' });
  await freeEverywhere(w, 'T-1');
});

test('S06 an edit reverted by hand to the exact approved value is not drift', async () => {
  const w = await approvedItem();
  const original = w.issue('T-1').fields.summary;
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
  w.edit('T-1', { summary: original });
  await freeEverywhere(w, 'T-1');
});

test('S07 a rich-text description edit is drift', async () => {
  const w = await approvedItem();
  w.edit('T-1', { description: doc('rewritten') });
  await heldEverywhere(w, 'T-1');
});

test('S08 reordering a multi-value field is not drift', async () => {
  const w = await approvedItem({ fields: { labels: ['a', 'b'] } });
  w.edit('T-1', { labels: ['b', 'a'] });
  await freeEverywhere(w, 'T-1');
});

test('S09 a cosmetic-materiality field is still drift: disturbed is disturbed', async () => {
  const w = await approvedItem();
  w.edit('T-1', { customfield_100: 'y' });
  await heldEverywhere(w, 'T-1');
});

test('S10 a single-select change is drift', async () => {
  const w = await approvedItem();
  w.edit('T-1', { priority: { id: '1', name: 'Highest' } });
  await heldEverywhere(w, 'T-1');
});

test('S11 the hold covers directed and global transitions alike', async () => {
  const w = await approvedItem();
  w.edit('T-1', { labels: ['alpha', 'beta'] });
  for (const id of ['41', '91', '92']) assert.ok(heldFor(await w.transition('T-1', id, { dry: true })), id);
});

test('S12 approving the drift releases the item', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
  w.approveDrift('T-1');
  await freeEverywhere(w, 'T-1');
  assert.equal(await w.moves('T-1', '41'), true);
});

test('S13 a complete revert releases the item', async () => {
  const w = await approvedItem();
  const original = w.issue('T-1').fields.summary;
  w.edit('T-1', { summary: 'edited' });
  w.restoreDrift('T-1', { summary: original });
  await freeEverywhere(w, 'T-1');
});

test('S14 a partial revert keeps the item held', async () => {
  const w = await approvedItem();
  const original = w.issue('T-1').fields.summary;
  w.edit('T-1', { summary: 'edited', priority: { id: '1' } });
  w.restoreDrift('T-1', { summary: original });
  await heldEverywhere(w, 'T-1');
});

test('S15 after an approval, the NEW content is the reference: going back to the old value is drift', async () => {
  const w = await approvedItem();
  const original = w.issue('T-1').fields.summary;
  w.edit('T-1', { summary: 'v2' });
  w.approveDrift('T-1');
  w.edit('T-1', { summary: original });
  await heldEverywhere(w, 'T-1');
});

test('S16 the refusal tells the person where to go', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  const r = await w.transition('T-1', '41');
  assert.match(r.errorMessage, /Approval & Baseline panel/);
});

test('S17 a held move is recorded as a blocked transition in the audit trail', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  await w.transition('T-1', '41');
  const blocked = w.audit.filter(e => e.eventType === 'TRANSITION_BLOCKED');
  assert.ok(blocked.some(e => e.payload.reason === 'UNDECIDED_DRIFT'));
});

// ─── B. Changes on the VAtlassian side ──────────────────────────────────────

test('S18 [asked] controlled transition deleted after the baseline: drift still holds everywhere', async () => {
  const w = await approvedItem();
  w.uncontrol('31');
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
  w.edit('T-1', { status: { id: '3' } });                    // even the edge it was signed on
  assert.ok(heldFor(await w.transition('T-1', '31', { dry: true })));
});

test('S19 [asked] controlled transition deleted, no drift: its edge now asks for no signature', async () => {
  const w = await approvedItem();
  w.uncontrol('31');
  w.edit('T-1', { status: { id: '3' } });
  assert.equal(await w.moves('T-1', '31'), true);
});

test('S20 [asked] controlled transition deleted: the drift is still decidable on the panel', async () => {
  const w = await approvedItem();
  w.uncontrol('31');
  w.edit('T-1', { summary: 'edited' });
  const { panel } = await agree(w, 'T-1');
  assert.equal(panel.drift.canApprove, true);
  assert.equal(panel.approval.requiredRole, 'reviewer', 'the role comes from the baseline itself');
});

test('S21 [asked] controlled transition deleted, drift approved: the item moves freely', async () => {
  const w = await approvedItem();
  w.uncontrol('31');
  w.edit('T-1', { summary: 'edited' });
  w.approveDrift('T-1');
  assert.equal(await w.moves('T-1', '41'), true);
  assert.equal(await w.moves('T-1', '21'), true);
  assert.equal(await w.moves('T-1', '31'), true);
});

test('S22 a retired (inactive) controlled transition behaves like a deleted one', async () => {
  const w = await approvedItem();
  w.controlledTransitions.find(r => r.transition_id === '31').state = 'INACTIVE';
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
  w.approveDrift('T-1');
  w.edit('T-1', { status: { id: '3' } });
  assert.equal(await w.moves('T-1', '31'), true);
});

test('S23 a controlled transition re-added later asks for a signature again', async () => {
  const w = await approvedItem();
  w.uncontrol('31');
  w.control({ transitionId: '31' });
  w.edit('T-1', { status: { id: '3' } });
  const r = await w.transition('T-1', '31');
  assert.equal(r.result, false);
  assert.doesNotMatch(r.errorMessage, DRIFT);
});

test('S24 the rule changes role after the baseline: drift is decided under the baseline\'s role', async () => {
  const w = await approvedItem();
  w.controlledTransitions.find(r => r.transition_id === '31').required_role = 'qa';
  w.edit('T-1', { summary: 'edited' });
  const { panel } = await agree(w, 'T-1');
  assert.equal(panel.approval.requiredRole, 'reviewer');
});

test('S25 a controlled transition on another issue type does not apply', async () => {
  const w = world();
  w.createIssue({ key: 'T-1', status: '3' });
  w.control({ transitionId: '31', issueTypeId: '2' });
  assert.equal(await w.moves('T-1', '31'), true);
});

test('S26 a controlled transition on another project does not apply', async () => {
  const w = world();
  w.createIssue({ key: 'T-1', status: '3' });
  w.control({ transitionId: '31', projectId: 2 });
  assert.equal(await w.moves('T-1', '31'), true);
});

test('S27 a wildcard issue-type rule applies to every type', async () => {
  const w = world();
  w.createIssue({ key: 'T-1', status: '3' });
  w.control({ transitionId: '31', issueTypeId: '*' });
  assert.equal((await w.transition('T-1', '31')).result, false);
});

test('S28 a field tracked only AFTER the baseline was taken is not drift', async () => {
  const w = await approvedItem();
  w.controlledFields.get('1:1').push({ field_id: 'customfield_200', field_kind: 'TEXT', store_values: true, materiality: 'MINOR' });
  w.edit('T-1', { customfield_200: 'changed' });
  await freeEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S29 a field no longer tracked is no longer drift', async () => {
  const w = await approvedItem();
  w.controlledFields.set('1:1', w.controlledFields.get('1:1').filter(f => f.field_id !== 'labels'));
  w.edit('T-1', { labels: ['changed'] });
  await freeEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S30 [decided] reclassifying a tracked field\'s kind reads as drift: the signed value is what counts', async () => {
  // Decided 2026-09-24: the signer approved a value. A change of data type can
  // alter or corrupt what the field holds, so it is surfaced as drift like any
  // other change to the signed content, and decided like any other drift.
  const w = await approvedItem();
  w.controlledFields.get('1:1').find(f => f.field_id === 'customfield_100').field_kind = 'TEXT';
  await heldEverywhere(w, 'T-1');
  const { panel } = await agree(w, 'T-1');
  assert.equal(panel.drift.canApprove, true);
  w.approveDrift('T-1');
  await freeEverywhere(w, 'T-1');
});

test('S31 changing a field\'s materiality is not drift', async () => {
  const w = await approvedItem();
  w.controlledFields.get('1:1').find(f => f.field_id === 'labels').materiality = 'MAJOR';
  await freeEverywhere(w, 'T-1');
});

test('S32 disabled project: a drifted item moves across uncontrolled transitions', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  w.disableProject();
  await freeEverywhere(w, 'T-1');
});

test('S33 disabled project: controlled transitions refuse even with a signature', async () => {
  const w = await approvedItem();
  w.edit('T-1', { status: { id: '3' } });
  await w.sign('T-1', '31');
  w.disableProject();
  const r = await w.transition('T-1', '31');
  assert.equal(r.result, false);
  assert.doesNotMatch(r.errorMessage, DRIFT);
});

test('S34 re-enabling the project brings the hold back', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  w.disableProject();
  await freeEverywhere(w, 'T-1');
  w.enableProject();
  await heldEverywhere(w, 'T-1');
});

test('S35 every reviewer grant revoked: the original approver can still decide the drift', async () => {
  const w = await approvedItem();
  w.eligibility = [];
  w.edit('T-1', { summary: 'edited' });
  const { panel } = await agree(w, 'T-1');
  assert.equal(panel.drift.canApprove, true);
});

test('S36 a restore in progress holds every transition with the restore message', async () => {
  const w = await approvedItem();
  w.itemState.get(Number(w.issue('T-1').id)).state = 'RESTORING';
  for (const r of Object.values(await w.verdicts('T-1'))) {
    assert.equal(r.result, false);
    assert.match(r.errorMessage, /restoring/i);
  }
});

test('S37 a restore lock token holds every transition', async () => {
  const w = await approvedItem();
  w.itemState.get(Number(w.issue('T-1').id)).lock_token = 'tok';
  for (const r of Object.values(await w.verdicts('T-1'))) assert.equal(r.result, false);
});

test('S38 a baseline with no item-state row is still judged by its content', async () => {
  const w = await approvedItem();
  w.itemState.clear();
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
});

test('S39 a stale baseline version on the item-state row does not change the verdict', async () => {
  const w = await approvedItem();
  w.itemState.get(Number(w.issue('T-1').id)).baseline_version = 99;
  await freeEverywhere(w, 'T-1');
});

test('S40 only superseded baselines: nothing to hold against', async () => {
  const w = await approvedItem();
  w.activeBaseline('T-1').state = 'SUPERSEDED';
  w.edit('T-1', { summary: 'edited' });
  await freeEverywhere(w, 'T-1');
});

test('S41 configuration unreadable: refused, and not blamed on drift', async () => {
  const w = await approvedItem();
  w.faults.add('db:config');
  for (const r of Object.values(await w.verdicts('T-1'))) {
    assert.equal(r.result, false);
    assert.doesNotMatch(r.errorMessage, DRIFT);
  }
});

test('S42 baseline unreadable: refused (fail closed)', async () => {
  const w = await approvedItem();
  w.faults.add('db:baseline');
  for (const r of Object.values(await w.verdicts('T-1'))) assert.equal(r.result, false);
});

test('S43 item state unreadable: refused (fail closed)', async () => {
  const w = await approvedItem();
  w.faults.add('db:item');
  for (const r of Object.values(await w.verdicts('T-1'))) assert.equal(r.result, false);
});

test('S44 two items: drift on one never holds the other', async () => {
  const w = await approvedItem({ key: 'T-1' });
  await approvedItem({ key: 'T-2', w });
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
  await freeEverywhere(w, 'T-2');
});

test('S45 an item with drift in a project whose config has no tracked fields at all is not held', async () => {
  const w = await approvedItem();
  w.controlledFields.set('1:1', []);
  w.edit('T-1', { summary: 'edited' });
  await agree(w, 'T-1');
});

test('S46 a wildcard issue-type tracked-field set is used when the type has none', async () => {
  const w = world({ tracked: [] });
  w.controlledFields.set('1:*', [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }]);
  await approvedItem({ w });
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
});

// ─── C. Changes on the Jira side ────────────────────────────────────────────

test('S47 Jira sends no transition id: a single route to the status resolves and passes', async () => {
  const w = await approvedItem();
  assert.equal((await w.transition('T-1', '41', { omitId: true })).result, true);
});

test('S48 no transition id, drift present: held', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  assert.ok(heldFor(await w.transition('T-1', '41', { omitId: true })));
});

test('S49 no transition id and two uncontrolled routes to the same status: passes', async () => {
  const w = await approvedItem();
  w.workflows.get('1:1').push({ id: '42', name: 'Reopen (alt)', from: ['4'], to: '2' });
  assert.equal((await w.transition('T-1', '41', { omitId: true })).result, true);
});

test('S50 no transition id, siblings where one is controlled: refused without a signature', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' });
  w.workflows.get('1:1').push({ id: '33', name: 'Fast approve', from: ['3'], to: '4' });
  w.control({ transitionId: '31' });
  assert.equal((await w.transition('T-1', '33', { omitId: true })).result, false);
});

test('S51 no transition id, siblings, drift present: the drift is what the person is told', async () => {
  const w = await approvedItem();
  w.workflows.get('1:1').push({ id: '42', name: 'Reopen (alt)', from: ['4'], to: '2' });
  w.control({ transitionId: '42' });
  w.edit('T-1', { summary: 'edited' });
  assert.ok(heldFor(await w.transition('T-1', '41', { omitId: true })));
});

test('S52 transition list unreadable, drift present: still told about the drift', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  w.faults.add('jira:transitions');
  assert.ok(heldFor(await w.transition('T-1', '41', { omitId: true })));
});

test('S53 transition list unreadable, no drift: fails closed', async () => {
  const w = await approvedItem();
  w.faults.add('jira:transitions');
  assert.equal((await w.transition('T-1', '41', { omitId: true })).result, false);
});

test('S54 the issue cannot be read: fails closed', async () => {
  const w = await approvedItem();
  w.faults.add('jira:issue');
  assert.equal((await w.transition('T-1', '41')).result, false);
});

test('S55 the status moved under the request: refused', async () => {
  const w = await approvedItem();
  assert.equal((await w.transition('T-1', '41', { fromOverride: '2' })).result, false);
});

test('S56 [decided] an item moved to a project with no VAtlassian tracking follows the destination: nothing is held', async () => {
  // Decided 2026-09-24: a moved item follows the configuration where it now
  // lives (as a codebeamer tracker item does after a move). The move itself is
  // recorded once in the audit trail by the collector (lib/scopeMove.js).
  const w = await approvedItem();
  w.edit('T-1', { project: { id: '2' } });
  w.workflows.set('2:1', WORKFLOW);
  w.edit('T-1', { summary: 'edited after the move' });
  await freeEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S57 [decided] an item moved to a project that tracks the same fields is still held on them', async () => {
  const w = await approvedItem();
  w.edit('T-1', { project: { id: '2' } });
  w.workflows.set('2:1', WORKFLOW);
  w.controlledFields.set('2:1', w.controlledFields.get('1:1'));
  w.projectConfig.set(2, { enabled: true });
  w.edit('T-1', { summary: 'edited after the move' });
  await heldEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S58 a tracked field removed from the issue (value gone) is drift', async () => {
  const w = await approvedItem();
  delete w.issue('T-1').fields.customfield_100;
  await heldEverywhere(w, 'T-1');
});

test('S59 a transition screen that edits tracked content moves once, then the item is held', async () => {
  const w = await approvedItem();
  assert.equal(await w.moves('T-1', '41', { modifiedFields: { summary: 'changed on the screen' } }), true);
  await heldEverywhere(w, 'T-1');
});

test('S60 a six-digit value typed on an ordinary transition screen does not block the move', async () => {
  const w = await approvedItem();
  assert.equal(await w.moves('T-1', '41', { modifiedFields: { customfield_200: '560001' } }), true);
});

test('S61 a 32-hex value on an ordinary transition screen does not block the move', async () => {
  const w = await approvedItem();
  assert.equal(await w.moves('T-1', '41', { modifiedFields: { customfield_200: 'ab'.repeat(16) } }), true);
});

test('S62 a transition added to the workflow after the baseline is held too', async () => {
  const w = await approvedItem();
  w.workflows.get('1:1').push({ id: '51', name: 'Archive', from: '*', to: '5' });
  w.edit('T-1', { summary: 'edited' });
  assert.ok(heldFor(await w.transition('T-1', '51', { dry: true })));
});

test('S63 the workflow is replaced with new transition ids: old rules stop applying, drift still holds', async () => {
  const w = await approvedItem();
  w.workflows.set('1:1', [{ id: '131', name: 'Approve v2', from: ['3'], to: '4' }, { id: '141', name: 'Reopen v2', from: ['4'], to: '2' }]);
  w.edit('T-1', { summary: 'edited' });
  assert.ok(heldFor(await w.transition('T-1', '141', { dry: true })));
  w.approveDrift('T-1');
  assert.equal(await w.moves('T-1', '141'), true);
  assert.equal(await w.moves('T-1', '21').catch(() => 'gone'), 'gone');
});

test('S64 a global transition into the current status passes when clean', async () => {
  const w = await approvedItem();
  w.edit('T-1', { status: { id: '3' } });
  assert.equal(await w.moves('T-1', '92'), true);
});

test('S65 status ids arrive as numbers or strings alike', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  assert.ok(heldFor(await w.transition('T-1', '41', { fromOverride: 4, toOverride: 2, dry: true })));
});

// ─── D. The signature half, unchanged ───────────────────────────────────────

test('S66 a controlled transition without a signature is refused', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  const r = await w.transition('T-1', '31');
  assert.equal(r.result, false);
  assert.match(r.errorMessage, /approval|sign/i);
});

test('S67 a valid signature passes, is spent, and is audited', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  const row = await w.sign('T-1', '31');
  assert.equal(await w.moves('T-1', '31'), true);
  assert.equal(row.state, 'CONSUMED');
  assert.ok(w.audit.some(e => e.eventType === 'SIGNATURE_CONSUMED'));
});

test('S68 a spent signature cannot be used twice', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  w.workflows.get('1:1').push({ id: '43', name: 'Back', from: ['4'], to: '3' });
  await w.sign('T-1', '31');
  assert.equal(await w.moves('T-1', '31'), true);
  assert.equal(await w.moves('T-1', '43'), true);
  assert.equal(await w.moves('T-1', '31'), false);
});

test('S69 an expired signature is refused', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  await w.sign('T-1', '31', { expiresIn: 1 });
  w.now += 10;
  assert.equal(await w.moves('T-1', '31'), false);
});

test('S70 content changed after signing (no baseline yet): refused as changed content', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  await w.sign('T-1', '31');
  w.edit('T-1', { summary: 'after signing' });
  const r = await w.transition('T-1', '31');
  assert.equal(r.result, false);
  assert.doesNotMatch(r.errorMessage, DRIFT);
});

test('S71 a signature for one transition cannot complete its sibling', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' });
  w.workflows.get('1:1').push({ id: '33', name: 'Fast approve', from: ['3'], to: '4' });
  w.control({ transitionId: '31' }); w.control({ transitionId: '33' });
  await w.sign('T-1', '31');
  assert.equal(await w.moves('T-1', '33'), false);
});

test('S72 eligibility revoked after signing: refused', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  await w.sign('T-1', '31');
  w.eligibility = [];
  assert.equal(await w.moves('T-1', '31'), false);
});

test('S73 rule role changed after signing: refused', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  await w.sign('T-1', '31');
  w.controlledTransitions[0].required_role = 'qa';
  assert.equal(await w.moves('T-1', '31'), false);
});

test('S74 no transition id but the signature token on the screen: resolves and passes', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' });
  w.workflows.get('1:1').push({ id: '33', name: 'Fast approve', from: ['3'], to: '4' });
  w.control({ transitionId: '31' });
  const row = await w.sign('T-1', '31');
  const r = await w.transition('T-1', '31', { omitId: true, modifiedFields: { customfield_761: row.approval_id.toString('hex') } });
  assert.equal(r.result, true, r.errorMessage);
});

test('S75 consuming a signature voids the item\'s other pending signatures', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  const other = await w.sign('T-1', '31');
  const used = await w.sign('T-1', '31');
  assert.equal(await w.moves('T-1', '31'), true);
  assert.equal(used.state, 'CONSUMED');
  assert.equal(other.state, 'VOID');
});

test('S76 a raw authenticator code on a CONTROLLED transition screen is still refused', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  await w.sign('T-1', '31');
  const r = await w.transition('T-1', '31', { modifiedFields: { customfield_761: '123456' } });
  assert.equal(r.result, false);
});

test('S77 drift present AND a valid signature on the controlled edge: the drift wins', async () => {
  const w = await approvedItem();
  w.edit('T-1', { status: { id: '3' } });
  await w.sign('T-1', '31');
  w.edit('T-1', { summary: 'edited' });
  const r = await w.transition('T-1', '31');
  assert.ok(heldFor(r));
  assert.ok(w.approvals.some(a => a.state === 'PENDING'), 'a held move must not spend the signature');
});

test('S78 a baselined item re-signed on its controlled edge after approving drift passes', async () => {
  const w = await approvedItem();
  w.edit('T-1', { status: { id: '3' }, summary: 'edited' });
  w.approveDrift('T-1');
  await w.sign('T-1', '31');
  assert.equal(await w.moves('T-1', '31'), true);
});

// ─── E. Tree baselines ──────────────────────────────────────────────────────

test('S79 tree baseline, root untouched: passes', async () => {
  const w = await approvedItem({ tree: true });
  await freeEverywhere(w, 'T-1');
});

test('S80 tree baseline, root edited: held, and the panel agrees', async () => {
  const w = await approvedItem({ tree: true });
  w.edit('T-1', { summary: 'edited' });
  await heldEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S81 tree baseline with unreadable root digests: held, the panel agrees, and approving releases', async () => {
  const w = await approvedItem({ tree: true });
  w.faults.add('db:rootDigests');
  await agree(w, 'T-1');
  w.faults.delete('db:rootDigests');
  await freeEverywhere(w, 'T-1');
});

test('S82 tree baseline, drift approved: released', async () => {
  const w = await approvedItem({ tree: true });
  w.edit('T-1', { summary: 'edited' });
  w.approveDrift('T-1');
  await freeEverywhere(w, 'T-1');
});

// ─── F. Random sequences: the validator and the panel always agree ──────────

function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

for (let seed = 1; seed <= 12; seed++) {
  test(`S${82 + seed} random sequence #${seed}: validator and panel agree after every step`, async () => {
    const random = rng(seed);
    const w = await approvedItem();
    const original = { ...w.issue('T-1').fields };
    const ops = [
      ['edit summary', () => w.edit('T-1', { summary: 's' + Math.floor(random() * 3) })],
      ['edit labels', () => w.edit('T-1', { labels: random() < 0.5 ? ['alpha'] : ['alpha', 'z'] })],
      ['edit untracked', () => w.edit('T-1', { customfield_200: String(random()) })],
      ['revert summary', () => w.edit('T-1', { summary: original.summary })],
      ['revert labels', () => w.edit('T-1', { labels: original.labels })],
      ['approve drift', async () => { if ((await w.panel('T-1')).drift.count > 0) w.approveDrift('T-1'); }],
      ['delete rule', () => w.uncontrol('31')],
      ['add rule', () => { if (!w.controlledTransitions.length) w.control({ transitionId: '31' }); }],
      ['disable project', () => w.disableProject()],
      ['enable project', () => w.enableProject()],
      ['move if free', async () => { const t = w.available('T-1')[Math.floor(random() * w.available('T-1').length)]; if (t) await w.transition('T-1', t.id); }]
    ];
    for (let step = 0; step < 25; step++) {
      const [name, op] = ops[Math.floor(random() * ops.length)];
      await op();
      try { await agree(w, 'T-1'); }
      catch (e) { e.message = `seed ${seed} step ${step} after "${name}": ${e.message}`; throw e; }
    }
  });
}

// ─── G. The Health page check, when Jira's workflow changes ─────────────────

const APP = '1d49ae3f-e976-438c-893c-806c8b249351';
const gate = (extra = {}) => ({ ruleKey: 'forge:expression-validator',
  parameters: { key: `ari:cloud:ecosystem::extension/${APP}/env/static/va-gate`, ...extra } });
/** A validator saved through its setup screen, which recorded its transition id. */
const savedGate = (transitionId, extra = {}) => gate({ config: JSON.stringify({ configuredIn: 'admin', transitionId }), ...extra });
const jiraWorkflow = (validatorsFor = id => [savedGate(id)]) => ({ id: 'wf', name: 'WF', transitions: [
  { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: '1', links: [], validators: [] },
  ...WORKFLOW.map(t => ({ id: t.id, name: t.name, type: t.from === '*' ? 'GLOBAL' : 'DIRECTED', toStatusReference: t.to,
    links: t.from === '*' ? [] : t.from.map(f => ({ fromStatusReference: f })), validators: validatorsFor(t.id) }))
] });
const ctRow = { project_id: 1, issue_type_id: '1', from_status_id: '3', to_status_id: '4' };

test('S95 validator everywhere, one controlled edge: clean', () => {
  assert.deepEqual(diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(), appId: APP }), []);
});

test('S96 validator removed from an uncontrolled transition: critical drift-hold finding', () => {
  const f = diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(id => id === '41' ? [] : [savedGate(id)]), appId: APP });
  assert.equal(f.length, 1);
  assert.equal(f[0].type, FINDING.HOLD_ABSENT);
  assert.equal(f[0].severity, SEVERITY.CRITICAL);
});

test('S97 validator disabled on a global transition: critical drift-hold finding', () => {
  const f = diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(id => id === '91' ? [savedGate(id, { disabled: 'true' })] : [savedGate(id)]), appId: APP });
  assert.deepEqual(f.map(x => [x.type, x.transitionId]), [[FINDING.HOLD_ABSENT, '91']]);
});

test('S98 validator removed from the controlled transition: signature finding, not a duplicate hold finding', () => {
  const f = diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(id => id === '31' ? [] : [savedGate(id)]), appId: APP });
  assert.deepEqual(f.map(x => x.type), [FINDING.GATE_ABSENT]);
});

test('S99 creation is never required to carry the validator', () => {
  const f = diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(), appId: APP });
  assert.ok(!f.some(x => x.transitionId === '1'));
});

test('S100 [asked] every controlled transition deleted while baselines remain: the Health check still watches the hold', async () => {
  // The rows are gone, but baselined items in this project still rely on the
  // validator for their drift hold. A check that only looks where rows exist
  // goes silent exactly when the hold is all that is left.
  const { pairsToCheck } = await import('../src/jobs/gatecheck.js');
  assert.equal(typeof pairsToCheck, 'function', 'gatecheck must derive its pairs from rows AND baselines');
  const pairs = pairsToCheck({ rows: [], baselinePairs: [{ project_id: 1, issue_type_id: '1' }] });
  assert.equal(pairs.length, 1);
  const f = diffWorkflow({ rows: pairs[0].rows, scope: pairs[0], workflow: jiraWorkflow(id => id === '41' ? [] : [savedGate(id)]), appId: APP });
  assert.deepEqual(f.map(x => x.type), [FINDING.HOLD_ABSENT]);
});

// ─── H. A restore that ended in ERROR ───────────────────────────────────────
//
// ERROR is "a restore needs attention", not "a restore is running". Nothing
// clears it while the content matches the baseline (the sweep leaves an
// outstanding review state alone), so it must never freeze an item the panel
// has nothing to offer on.

test('S101 ERROR state with content back at the baseline: uncontrolled transitions pass', async () => {
  const w = await approvedItem();
  w.itemState.get(Number(w.issue('T-1').id)).state = 'ERROR';
  await freeEverywhere(w, 'T-1');
});

test('S102 ERROR state with the content still drifted: held for the drift, and decidable', async () => {
  const w = await approvedItem();
  w.itemState.get(Number(w.issue('T-1').id)).state = 'ERROR';
  w.edit('T-1', { summary: 'still different' });
  await heldEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S103 ERROR state on a CONTROLLED transition is still refused, as before', async () => {
  const w = await approvedItem();
  w.edit('T-1', { status: { id: '3' } });
  await w.sign('T-1', '31');
  w.itemState.get(Number(w.issue('T-1').id)).state = 'ERROR';
  assert.equal(await w.moves('T-1', '31'), false);
});

test('S104 a restore genuinely running still holds every transition', async () => {
  const w = await approvedItem();
  w.itemState.get(Number(w.issue('T-1').id)).state = 'DECIDING';
  for (const r of Object.values(await w.verdicts('T-1'))) assert.equal(r.result, false);
});

// ─── I. People who never opened VAtlassian, and automation ──────────────────
//
// The validator now runs on every transition, for every user and automation
// rule — most of whom never opened the app and never granted it consent to act
// as them. What the drift hold needs to know (the issue, its transitions) the
// app can read as itself.

test('S105 a user without app consent moves a clean baselined item across an uncontrolled transition', async () => {
  const w = await approvedItem();
  w.faults.add('jira:noConsent');
  assert.equal(await w.moves('T-1', '41'), true);
});

test('S106 a user without app consent is still held on a drifted item, with the drift message', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  w.faults.add('jira:noConsent');
  assert.ok(heldFor(await w.transition('T-1', '41')));
});

test('S107 a user without app consent, and Jira sends no transition id: still resolves and passes', async () => {
  const w = await approvedItem();
  w.faults.add('jira:noConsent');
  assert.equal((await w.transition('T-1', '41', { omitId: true })).result, true);
});

test('S108 a user without app consent on an item with no baseline: every uncontrolled transition passes', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '2' });
  w.faults.add('jira:noConsent');
  await freeEverywhere(w, 'T-1');
});

test('S109 a user without app consent cannot slip past a controlled transition', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' }); w.control({ transitionId: '31' });
  w.faults.add('jira:noConsent');
  assert.equal(await w.moves('T-1', '31'), false);
});

test('S110 an item moved to an untracked project: whatever the verdict, the validator and the panel agree', async () => {
  const w = await approvedItem();
  w.edit('T-1', { project: { id: '2' }, summary: 'edited after the move' });
  w.workflows.set('2:1', WORKFLOW);
  w.projectConfig.set(2, { enabled: true });
  await agree(w, 'T-1');
});

test('S111 no app consent, a condition hides the CONTROLLED transition from the app: its unsigned sibling cannot be used to slip through', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' });
  w.workflows.get('1:1').push({ id: '33', name: 'Approve (assignee only)', from: ['3'], to: '4' });
  w.control({ transitionId: '33' });
  w.hiddenFromApp = new Set(['33']);
  w.faults.add('jira:noConsent');
  // Jira sends no transition id; the user is really taking 33.
  assert.equal((await w.transition('T-1', '33', { omitId: true })).result, false);
});

test('S112 no app consent, nothing controlled is hidden: the uncontrolled route still passes', async () => {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' });
  w.control({ transitionId: '31' });
  w.hiddenFromApp = new Set(['32']);
  w.faults.add('jira:noConsent');
  assert.equal((await w.transition('T-1', '92', { omitId: true })).result, true);
});

test('S113 a field tracked after v1 is not drift against v1, and is drift once a baseline that carries it exists', async () => {
  const w = await approvedItem();                                   // v1: customfield_200 not tracked
  w.controlledFields.get('1:1').push({ field_id: 'customfield_200', field_kind: 'TEXT', store_values: true, materiality: 'MINOR' });

  w.edit('T-1', { customfield_200: 'changed while v1 stands' });
  await freeEverywhere(w, 'T-1');                                   // v1 never carried it: no drift
  assert.equal((await agree(w, 'T-1')).panel.drift.count, 0);

  w.edit('T-1', { status: { id: '3' } });                           // next controlled transition captures v2
  await w.sign('T-1', '31');
  assert.equal(await w.moves('T-1', '31'), true);
  w.baseline('T-1');
  assert.equal(w.activeBaseline('T-1').version, 2);
  assert.ok(JSON.parse(w.activeBaseline('T-1').field_digests).customfield_200, 'v2 carries the new field');

  w.edit('T-1', { customfield_200: 'changed after v2' });           // back to business
  await heldEverywhere(w, 'T-1');
  await agree(w, 'T-1');
});

test('S114 a field tracked after v1, alongside a real drift on an old field: only the old field counts', async () => {
  const w = await approvedItem();
  w.controlledFields.get('1:1').push({ field_id: 'customfield_200', field_kind: 'TEXT', store_values: true, materiality: 'MINOR' });
  w.edit('T-1', { customfield_200: 'new field changed', summary: 'old field changed' });
  const { panel } = await agree(w, 'T-1');
  assert.equal(panel.drift.count, 1, 'summary only');
  w.approveDrift('T-1');                                            // approving drift also captures v2 with the new field
  w.edit('T-1', { customfield_200: 'changed after v2' });
  await heldEverywhere(w, 'T-1');
});

// ─── J. The validator told which transition it is on (its setup screen) ─────
//
// Jira's payload never carries the transition id. The validator's setup screen
// knows it and saves it into the validator's configuration, which Jira passes
// back on every call. These scenarios all send NO transition id, as Jira does.

function siblings() {
  const w = world(); w.createIssue({ key: 'T-1', status: '3' });
  w.workflows.get('1:1').push({ id: '33', name: 'Approve (fast track)', from: ['3'], to: '4' });
  w.control({ transitionId: '33' });                                  // 31 and 33 both go Review -> Done; only 33 is controlled
  return w;
}

test('S115 siblings into one status, the UNCONTROLLED one taken: its saved id lets it pass', async () => {
  const w = siblings();
  assert.equal((await w.transition('T-1', '31', { omitId: true, configured: true })).result, true);
});

test('S116 siblings, the CONTROLLED one taken without a signature: refused as unsigned, not as unknown', async () => {
  const w = siblings();
  const r = await w.transition('T-1', '33', { omitId: true, configured: true });
  assert.equal(r.result, false);
  assert.match(r.errorMessage, /approv|sign/i);
});

test('S117 siblings, the controlled one taken with a valid signature: passes and spends it', async () => {
  const w = siblings();
  const row = await w.sign('T-1', '33');
  assert.equal((await w.transition('T-1', '33', { omitId: true, configured: true })).result, true);
  assert.equal(row.state, 'CONSUMED');
});

test('S118 a signature for the controlled sibling cannot be spent through the uncontrolled one', async () => {
  const w = siblings();
  const row = await w.sign('T-1', '33');
  assert.equal((await w.transition('T-1', '31', { omitId: true, configured: true })).result, true);
  assert.equal(row.state, 'PENDING', 'moving through the uncontrolled sibling must not consume it');
});

test('S119 a stale saved id (no such transition any more) falls back to the old resolution', async () => {
  const w = siblings();
  assert.equal((await w.transition('T-1', '31', { omitId: true, configured: '999' })).result, false, 'siblings with a controlled one still fail closed');
  const single = await approvedItem();
  assert.equal((await single.transition('T-1', '41', { omitId: true, configured: '999' })).result, true);
});

test('S120 a saved id naming a transition into a DIFFERENT status is ignored', async () => {
  const w = siblings();
  assert.equal((await w.transition('T-1', '31', { omitId: true, configured: '32' })).result, false);
});

test('S121 validators never re-saved (no id in their configuration) behave exactly as before', async () => {
  const w = siblings();
  assert.equal((await w.transition('T-1', '31', { omitId: true })).result, false);
});

test('S122 drift still comes first when the validator knows its transition', async () => {
  const w = await approvedItem();
  w.edit('T-1', { summary: 'edited' });
  assert.ok(heldFor(await w.transition('T-1', '41', { omitId: true, configured: true })));
});

test('S123 no app consent, the controlled sibling hidden from the app, saved id present: still refused', async () => {
  const w = siblings();
  w.hiddenFromApp = new Set(['33']);
  w.faults.add('jira:noConsent');
  assert.equal((await w.transition('T-1', '33', { omitId: true, configured: true })).result, false);
});

test('S124 Health check: a validator copied onto another transition (wrong saved id) is critical', () => {
  const f = diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(id => [savedGate(id === '92' ? '21' : id)]), appId: APP });
  assert.deepEqual(f.map(x => [x.type, x.transitionId, x.severity]), [[FINDING.GATE_CONFIG_MISMATCH, '92', SEVERITY.CRITICAL]]);
});

test('S125 Health check: validators never re-saved are flagged only where siblings make the id matter', () => {
  const f = diffWorkflow({ rows: [ctRow], workflow: jiraWorkflow(() => [gate()]), appId: APP });
  // 21 (In Progress -> Review) and the global 92 (-> Review) are siblings; 91 -> To Do is too, with nobody else.
  assert.deepEqual(f.map(x => [x.type, x.transitionId]).sort(),
    [[FINDING.GATE_CONFIG_MISSING, '21'], [FINDING.GATE_CONFIG_MISSING, '92']]);
  assert.ok(f.every(x => x.severity === SEVERITY.WARNING));
});

// ─── H. Child baselines (2026-09-24) ────────────────────────────────────────
//
// When a parent is baselined, every child (through `parent`, recursively)
// gets a baseline of its own, over its own project and issue type's fields,
// signed by the parent's approval. A child's drift is held and decided in the
// child; the parent is held only by its own fields. A parent decision covers
// the children, so the parent's panel offers one while any child is waiting.

const SUBTASK_TRACKED = [
  { field_id: 'summary', field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' },
  { field_id: 'labels', field_kind: 'MULTI', store_values: true, materiality: 'MINOR' }
];

/** Parent P-1 (type 1) with subtasks P-2 and P-3 (type 2, their own workflow and fields), captured together. */
function familyWorld({ subtaskTracked = SUBTASK_TRACKED, grandchild = false } = {}) {
  const w = world();
  w.workflows.set('1:2', structuredClone(WORKFLOW));
  w.controlledFields.set('1:2', structuredClone(subtaskTracked));
  w.createIssue({ key: 'P-1', status: '4' });
  w.createIssue({ key: 'P-2', status: '2', issueTypeId: '2', childOf: 'P-1' });
  w.createIssue({ key: 'P-3', status: '2', issueTypeId: '2', childOf: 'P-1' });
  if (grandchild) w.createIssue({ key: 'P-4', status: '2', issueTypeId: '2', childOf: 'P-2' });
  w.control({ transitionId: '31' });
  const captured = w.captureTree('P-1');
  return { w, ...captured };
}

test('S126 a parent capture gives every child its own baseline, over the child\'s own fields', () => {
  const { w, parent, children } = familyWorld();
  assert.deepEqual(children.map(c => c.issue_id), [Number(w.issue('P-2').id), Number(w.issue('P-3').id)]);
  for (const child of children) {
    assert.ok(Buffer.from(child.captured_by_baseline_id).equals(Buffer.from(parent.baseline_id)));
    assert.equal(child.tree_hash, null, 'an ordinary single-issue baseline');
    assert.deepEqual(Object.keys(JSON.parse(child.field_digests)).sort(), ['labels', 'summary']);
  }
});

test('S127 editing a child holds the child only, and the child\'s own panel can decide it', async () => {
  const { w } = familyWorld();
  w.edit('P-2', { summary: 'child edited' });
  await heldEverywhere(w, 'P-2');
  await freeEverywhere(w, 'P-3');
  const { panel } = await agree(w, 'P-2');
  assert.equal(panel.drift.count, 1);
  assert.deepEqual(panel.baseline.capturedBy, { issueKey: 'P-1', version: 1 });
});

test('S128 the parent is not held while a child is drifted, and its panel offers the decision covering it', async () => {
  const { w } = familyWorld();
  w.edit('P-2', { summary: 'child edited' });
  await freeEverywhere(w, 'P-1');
  const { panel } = await agree(w, 'P-1');
  assert.equal(panel.drift.count, 0, 'the parent\'s own fields are unchanged');
  assert.equal(panel.drift.childrenAwaiting, 1);
  assert.equal(panel.drift.canApprove, true);
  assert.equal(panel.drift.canReject, true);
  assert.match(panel.state, /1 child work item has changes awaiting a decision/);
});

test('S129 a field the child\'s type does not track is not the child\'s drift', async () => {
  const { w } = familyWorld();
  w.edit('P-2', { priority: { id: '1', name: 'Highest' } });   // tracked for the parent's type only
  await freeEverywhere(w, 'P-2');
  assert.equal((await w.panel('P-1')).drift.childrenAwaiting, 0);
});

test('S130 the parent\'s own edit holds the parent, not its children', async () => {
  const { w } = familyWorld();
  w.edit('P-1', { summary: 'parent edited' });
  await heldEverywhere(w, 'P-1');
  await freeEverywhere(w, 'P-2');
  await agree(w, 'P-1');
});

test('S131 approving the child in its own panel releases it and clears the parent\'s waiting count', async () => {
  const { w } = familyWorld();
  w.edit('P-2', { summary: 'child edited' });
  const v = w.approveDrift('P-2');
  assert.equal(v.version, 2);
  await freeEverywhere(w, 'P-2');
  assert.equal((await w.panel('P-1')).drift.childrenAwaiting, 0);
});

test('S132 approving the parent re-baselines every drifted child with it', async () => {
  const { w } = familyWorld();
  w.edit('P-2', { summary: 'child edited' });
  w.edit('P-3', { labels: ['beta'] });
  w.approveDrift('P-1');
  await freeEverywhere(w, 'P-2');
  await freeEverywhere(w, 'P-3');
  assert.equal(w.activeBaseline('P-2').version, 2);
  assert.equal((await w.panel('P-1')).drift.childrenAwaiting, 0);
});

test('S133 independent versions: a child at v5 of its own, then its parent\'s capture at v1 of the parent, is not drift', async () => {
  const w = world();
  w.createIssue({ key: 'P-1', status: '4' });
  w.createIssue({ key: 'P-2', status: '2', childOf: 'P-1' });
  w.control({ transitionId: '31' });
  for (let i = 1; i <= 5; i += 1) { w.edit('P-2', { summary: `own ${i}` }); w.baseline('P-2'); }
  assert.equal(w.activeBaseline('P-2').version, 5);
  w.edit('P-2', { summary: 'changed before the parent was signed' });
  const { parent, children } = w.captureTree('P-1');
  assert.equal(parent.version, 1);
  assert.equal(children[0].version, 6, 'the child\'s next version in its own lineage');
  await freeEverywhere(w, 'P-2');
  assert.equal((await w.panel('P-2')).drift.count, 0);
});

test('S134 a child rejected in its own panel returns to ITS latest baseline, not the parent\'s older capture', async () => {
  const { w } = familyWorld();
  w.edit('P-2', { summary: 'B' });
  w.approveDrift('P-2');                       // the child's own v2, after the parent's v1 capture
  w.edit('P-2', { summary: 'C' });
  await heldEverywhere(w, 'P-2');
  w.restoreDrift('P-2', { summary: 'Summary of P-2' });   // the parent capture's value: still not the child's record
  await heldEverywhere(w, 'P-2');
  w.restoreDrift('P-2', { summary: 'B' });
  await freeEverywhere(w, 'P-2');
});

test('S135 a child whose type tracks no fields gets no baseline, and its edits hold nothing', async () => {
  const { w, children } = familyWorld({ subtaskTracked: [] });
  assert.deepEqual(children, []);
  w.edit('P-2', { summary: 'edited' });
  await freeEverywhere(w, 'P-2');
  await freeEverywhere(w, 'P-1');
});

test('S136 grandchildren get their own baselines too, and are held on their own', async () => {
  const { w, children } = familyWorld({ grandchild: true });
  assert.ok(children.some(c => c.issue_id === Number(w.issue('P-4').id)));
  w.edit('P-4', { labels: ['gamma'] });
  await heldEverywhere(w, 'P-4');
  await freeEverywhere(w, 'P-2');
  await freeEverywhere(w, 'P-1');
  assert.equal((await w.panel('P-1')).drift.childrenAwaiting, 1);
});

test('S137 a linked issue is not a child: editing it holds nothing, whatever the parent captured', async () => {
  const { w } = familyWorld();
  w.createIssue({ key: 'L-9', status: '2' });
  w.edit('P-1', { issuelinks: [] });
  w.edit('L-9', { summary: 'linked issue edited' });
  await freeEverywhere(w, 'L-9');
  await freeEverywhere(w, 'P-1');
  assert.equal((await w.panel('P-1')).drift.childrenAwaiting, 0);
});
