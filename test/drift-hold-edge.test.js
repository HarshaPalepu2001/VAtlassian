/**
 * Resolving which Jira transition the validator is running on, and the live
 * drift verdict the validator shares with the panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEdge } from '../src/lib/approval/runtime.js';
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

test('the signed approval names the transition when the payload does not', async () => {
  const edge = await resolveEdge(edgeDeps({ signed: 70, controlled: ['70'] }),
    { toStatusId: '2', transitionId: null, approvalId: 'ab' });
  assert.equal(edge.transitionId, '70');
  assert.equal(edge.ct, rule);
});

test('one live transition into the status is taken as the edge', async () => {
  const edge = await resolveEdge(edgeDeps({ transitions: [{ id: 60, toStatusId: '2' }, { id: 61, toStatusId: '3' }] }),
    { toStatusId: '2', transitionId: null });
  assert.deepEqual(edge, { transitionId: '60', ct: null, edgeFailure: null });
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
