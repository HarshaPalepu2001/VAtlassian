/**
 * Resolving which Jira transition the validator is running on, and the live
 * drift verdict the validator shares with the panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEdge, readAsUserOrApp, hidesControlledTransition } from '../src/lib/approval/runtime.js';
import { baselineDrift } from '../src/lib/liveDrift.js';
import { project, FIELD_KIND } from '../src/lib/content.js';
import { scopeFromIssue } from '../src/lib/trackedFields.js';

const rule = { required_role: 'reviewer' };
const edgeDeps = ({ transitions = [], controlled = [], signed = null, throws = false } = {}) => ({
  gated: async id => (controlled.includes(id) ? rule : null),
  signedTransitionId: async () => signed,
  transitions: async () => { if (throws) throw new Error('down'); return transitions; }
});

test('an exact transition id is used as given', async () => {
  const edge = await resolveEdge(edgeDeps({ controlled: ['50'] }), { toStatusId: '2', transitionId: 50 });
  assert.deepEqual(edge, { transitionId: '50', ct: rule, edgeFailure: null });
});

test('an uncontrolled exact transition resolves with no rule and no failure', async () => {
  const edge = await resolveEdge(edgeDeps(), { toStatusId: '2', transitionId: '51' });
  assert.deepEqual(edge, { transitionId: '51', ct: null, edgeFailure: null });
});

test('a receipt alone cannot name an unavailable executing transition', async () => {
  const edge = await resolveEdge(edgeDeps({ signed: 70, controlled: ['70'] }),
    { toStatusId: '2', transitionId: null, approvalId: 'ab' });
  assert.deepEqual(edge, { transitionId: null, ct: null, edgeFailure: 'NOT_CONFIGURED' });
});

test('one live transition into the status is taken as the edge', async () => {
  const edge = await resolveEdge(edgeDeps({ transitions: [{ id: 60, toStatusId: '2' }, { id: 61, toStatusId: '3' }] }),
    { toStatusId: '2', transitionId: null });
  assert.deepEqual(edge, { transitionId: '60', ct: null, edgeFailure: null });
});

// ─── Users who never granted the app consent ────────────────────────────────

const noConsent = () => Object.assign(new Error('Authentication required'),
  { name: 'NeedsAuthenticationError', code: 'NEEDS_AUTHENTICATION_ERR' });
const listError = status => new Error(`transitions: could not read transitions for T-1 (status ${status})`);
const reads = ({ user, app = async () => 'app' }) => {
  const calls = [];
  return { calls, asUser: async () => { calls.push('user'); return user(); },
    asApp: async () => { calls.push('app'); return app(); } };
};

test('a readable user read is used as is; the app is never asked', async () => {
  const r = reads({ user: () => ({ ok: true, status: 200 }) });
  assert.deepEqual(await readAsUserOrApp(r.asUser, r.asApp), { ok: true, status: 200 });
  assert.deepEqual(r.calls, ['user']);
});

test('no consent, 401 or 403 as the user: the same read comes from the app', async () => {
  for (const user of [() => { throw noConsent(); }, () => ({ ok: false, status: 401 }), () => ({ ok: false, status: 403 }),
    () => { throw listError(401); }, () => { throw listError(403); }]) {
    const r = reads({ user });
    assert.equal(await readAsUserOrApp(r.asUser, r.asApp), 'app');
    assert.deepEqual(r.calls, ['user', 'app']);
  }
});

test('any other failure is not a consent problem and never falls back', async () => {
  for (const status of [404, 500, 503]) {
    const r = reads({ user: () => ({ ok: false, status }) });
    assert.equal((await readAsUserOrApp(r.asUser, r.asApp)).status, status);
    assert.deepEqual(r.calls, ['user']);
    const t = reads({ user: () => { throw listError(status); } });
    await assert.rejects(readAsUserOrApp(t.asUser, t.asApp), /status \d+/);
    assert.deepEqual(t.calls, ['user']);
  }
});

test('an app read that also fails is reported, and the edge fails closed', async () => {
  const r = reads({ user: () => { throw noConsent(); }, app: () => { throw listError(503); } });
  const edge = await resolveEdge({ ...edgeDeps(), transitions: () => readAsUserOrApp(r.asUser, r.asApp) },
    { toStatusId: '2', transitionId: null });
  assert.equal(edge.edgeFailure, 'SERVICE_UNAVAILABLE');
});

test('without consent the live transition list is read as the app and resolves the edge', async () => {
  const r = reads({ user: () => { throw noConsent(); },
    app: () => [{ id: '60', toStatusId: '2' }, { id: '61', toStatusId: '3' }] });
  const edge = await resolveEdge({ ...edgeDeps({ controlled: ['60'] }), transitions: () => readAsUserOrApp(r.asUser, r.asApp) },
    { toStatusId: '2', transitionId: null });
  assert.deepEqual(edge, { transitionId: '60', ct: rule, edgeFailure: null });
});

const move = { issueTypeId: '1', fromStatusId: '1', toStatusId: '2' };
const ruleFor = (transition_id, over = {}) => ({ transition_id, issue_type_id: '1', from_status_id: '1', to_status_id: '2',
  state: 'ACTIVE', ...over });

test('an app-read list is trusted only when every rule that could match this move is visible to the app', () => {
  const visible = [{ id: '60', toStatusId: '2', isAvailable: true }];
  assert.equal(hidesControlledTransition([], visible, move), false);
  assert.equal(hidesControlledTransition([ruleFor('60')], visible, move), false);
  // A controlled transition a workflow condition hides from the app.
  assert.equal(hidesControlledTransition([ruleFor('62')], visible, move), true);
  assert.equal(hidesControlledTransition([ruleFor('62', { from_status_id: '*', to_status_id: '*', issue_type_id: '*' })],
    visible, move), true);
  // Seen but unavailable to the app may still be available to the user.
  assert.equal(hidesControlledTransition([ruleFor('60')], [{ ...visible[0], isAvailable: false }], move), true);
  // Rules that cannot match this move are irrelevant.
  for (const over of [{ state: 'INACTIVE' }, { issue_type_id: '9' }, { from_status_id: '9' }, { to_status_id: '9' }]) {
    assert.equal(hidesControlledTransition([ruleFor('62', over)], visible, move), false);
  }
  // A list that may be truncated, or cannot be read, is not proof.
  assert.equal(hidesControlledTransition(Array.from({ length: 200 }, () => ruleFor('60')), visible, move), true);
  assert.equal(hidesControlledTransition(null, visible, move), true);
});

test('uncontrolled siblings are no failure: only the drift hold applies to any of them', async () => {
  const edge = await resolveEdge(edgeDeps({ transitions: [{ id: 60, toStatusId: '2' }, { id: 62, toStatusId: '2' }] }),
    { toStatusId: '2', transitionId: null });
  assert.deepEqual(edge, { transitionId: null, ct: null, edgeFailure: null });
});

test('siblings where one is controlled fail closed', async () => {
  const edge = await resolveEdge(edgeDeps({ transitions: [{ id: 60, toStatusId: '2' }, { id: 62, toStatusId: '2' }],
    controlled: ['62'] }), { toStatusId: '2', transitionId: null });
  assert.equal(edge.edgeFailure, 'SERVICE_UNAVAILABLE');
});

test('no live transition, or an unreadable list, is reported rather than thrown', async () => {
  assert.equal((await resolveEdge(edgeDeps(), { toStatusId: '2', transitionId: null })).edgeFailure, 'NOT_CONFIGURED');
  assert.equal((await resolveEdge(edgeDeps({ throws: true }), { toStatusId: '2', transitionId: null })).edgeFailure,
    'SERVICE_UNAVAILABLE');
});

// ─── The live drift verdict ─────────────────────────────────────────────────

const declared = [{ field_id: 'summary', field_kind: FIELD_KIND.TEXT, store_values: true, materiality: 'MAJOR' }];
const fields = { summary: 'Approved text', description: null, issuetype: { id: '1' } };
const digestsOf = issueFields => project(issueFields, scopeFromIssue({ declared, issueFields }).fields).digests;

test('no baseline, no drift', async () => {
  assert.deepEqual((await baselineDrift({ baseline: null, issueFields: fields, declared })).changed, []);
});

test('content matching the baseline is not drift; an edit is', async () => {
  const baseline = { field_digests: digestsOf(fields) };
  assert.deepEqual((await baselineDrift({ baseline, issueFields: fields, declared })).changed, []);
  const edited = { ...fields, summary: 'Edited after approval' };
  assert.deepEqual((await baselineDrift({ baseline, issueFields: edited, declared })).changed, ['summary']);
});

test('a tree baseline is compared against its root node digests', async () => {
  const baseline = { tree_hash: 'h', baseline_id: 'b', field_digests: '{}' };
  const result = await baselineDrift({ baseline, issueId: 10, issueFields: fields, declared,
    readRootDigests: async (id, issueId) => (id === 'b' && issueId === 10 ? digestsOf(fields) : null) });
  assert.deepEqual(result.changed, []);
});

test('unreadable root digests fail towards drift, never towards clean', async () => {
  const baseline = { tree_hash: 'h', baseline_id: 'b', field_digests: '{}' };
  const result = await baselineDrift({ baseline, issueId: 10, issueFields: fields, declared,
    readRootDigests: async () => { throw new Error('db down'); } });
  assert.ok(result.changed.length > 0);
});

// ─── The transition id saved by the validator's setup screen ────────────────

test('a saved transition id picks the right sibling', async () => {
  const deps = edgeDeps({ transitions: [{ id: 31, toStatusId: '4' }, { id: 33, toStatusId: '4' }], controlled: ['33'] });
  assert.deepEqual(await resolveEdge(deps, { toStatusId: '4', transitionId: null, configuredTransitionId: '31' }),
    { transitionId: '31', ct: null, edgeFailure: null });
  assert.deepEqual(await resolveEdge(deps, { toStatusId: '4', transitionId: null, configuredTransitionId: '33' }),
    { transitionId: '33', ct: rule, edgeFailure: null });
});

test('a saved id that is not an available transition into this status is ignored', async () => {
  const deps = edgeDeps({ transitions: [{ id: 31, toStatusId: '4' }, { id: 33, toStatusId: '4' }, { id: 32, toStatusId: '2' }], controlled: ['33'] });
  for (const stale of ['999', '32']) {
    assert.equal((await resolveEdge(deps, { toStatusId: '4', transitionId: null, configuredTransitionId: stale })).edgeFailure,
      'SERVICE_UNAVAILABLE', stale);
  }
});

test('an id in the payload still wins over a saved one', async () => {
  const deps = edgeDeps({ transitions: [{ id: 31, toStatusId: '4' }, { id: 33, toStatusId: '4' }] });
  assert.equal((await resolveEdge(deps, { toStatusId: '4', transitionId: '33', configuredTransitionId: '31' })).transitionId, '33');
});
