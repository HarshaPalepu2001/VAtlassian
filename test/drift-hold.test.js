/**
 * Outstanding drift always holds a work item still.
 *
 * There is no per-rule switch: drift is a compliance state of the item, not an
 * option on an edge. The validator fails CLOSED — a drift count it cannot read
 * blocks the move, and so does any count above zero, whatever the rule says.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../src/gate.js';
import { makeApproval } from '../src/lib/approval/record.js';

async function gateFixture({ driftCount, ct, snapshot: extra = {}, pendingRow, transitionId = '50',
  policyForApproval } = {}) {
  const binding = { accountId: 'actor', issueId: 10, fromStatusId: '1', toStatusId: '2',
    contentHash: 'a'.repeat(64), decision: 'APPROVE', transitionId: '50' };
  // ESIGNATURE, because effectiveAssurance() floors every edge there; a
  // NATIVE_TRANSITION proof is refused before drift is ever considered.
  const proof = { ok: true, level: 'ESIGNATURE', providerId: 'totp',
    evidence: { method: 'SESSION_AND_TOTP', verifiedAt: 100, binding } };
  const row = { ...makeApproval({ ...binding, issueKey: 'T-10', projectId: 1, issueTypeId: '1',
    actorName: 'Actor', meaning: 'Approve', signerRole: 'reviewer', proof, transitionId: '50', now: 100 }),
  state: 'PENDING' };
  const calls = { pending: 0, consume: 0, contentHash: 0 };
  const snapshot = { issueId: 10, projectId: 1, issueTypeId: '1',
    contentHash: () => { calls.contentHash += 1; return binding.contentHash; },
    item: { state: 'BASELINED' }, driftCount, ct, ...extra };
  const deps = { now: () => 200, log: () => {}, load: async () => snapshot,
    pending: async () => { calls.pending += 1; return pendingRow === undefined ? row : pendingRow; },
    eligible: async () => true, consume: async () => { calls.consume += 1; return { consumed: true }; },
    voidOthers: async () => {}, audit: async () => {}, policyForApproval };
  return { gate: createGate(deps), calls, row, payload: { issue: { key: 'T-10' },
    transition: { id: transitionId, from: { id: '1' }, to: { id: '2' } } } };
}

const policy = extra => ({ required_assurance: 'ESIGNATURE', required_role: 'reviewer',
  meaning: 'Approve', ...extra });

test('outstanding drift blocks a controlled transition', async () => {
  const f = await gateFixture({ driftCount: 2, ct: policy() });
  const result = await f.gate(f.payload);
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /changed since it was approved/i);
});

test('drift blocks whatever a legacy block_on_drift value says', async () => {
  // The column survives in the database, so old rows may still carry 0. It is
  // never read: a stored "do not block" must not let drifted content through.
  for (const legacy of [0, false, '0', 1, true, undefined]) {
    const f = await gateFixture({ driftCount: 2, ct: policy({ block_on_drift: legacy }) });
    assert.equal((await f.gate(f.payload)).result, false, String(legacy));
  }
});

test('an item with no drift is not blocked by the drift rule', async () => {
  const f = await gateFixture({ driftCount: 0, ct: policy() });
  assert.equal((await f.gate(f.payload)).result, true);
});

test('an unreadable drift count blocks', async () => {
  for (const driftCount of [NaN, undefined, null]) {
    const f = await gateFixture({ driftCount, ct: policy() });
    assert.equal((await f.gate(f.payload)).result, false, String(driftCount));
  }
});

// ─── One validator, attached to every transition ────────────────────────────
//
// The Jira-side setup is a single validator on every transition. It holds a
// drifted item on all of them, and asks for a signature only where VAtlassian
// controls the edge.

test('outstanding drift blocks a transition VAtlassian does not control', async () => {
  const f = await gateFixture({ driftCount: 1, ct: null });
  const result = await f.gate(f.payload);
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /changed since it was approved/i);
});

test('an uncontrolled transition with no drift passes without touching an approval', async () => {
  const f = await gateFixture({ driftCount: 0, ct: null, pendingRow: null });
  assert.equal((await f.gate(f.payload)).result, true);
  assert.equal(f.calls.consume, 0);
  assert.equal(f.calls.contentHash, 0, 'the approval content hash is only paid for on a signature check');
});

test('an unsigned approval lying around does not block an uncontrolled transition, nor is it spent', async () => {
  const f = await gateFixture({ driftCount: 0, ct: null });
  assert.equal((await f.gate(f.payload)).result, true);
  assert.equal(f.calls.consume, 0);
});

test('an approval bound to a baseline is checked in full even where no controlled row exists', async () => {
  const f = await gateFixture({ driftCount: 0, ct: null, policyForApproval: async () => null });
  f.row.baseline_id = Buffer.alloc(16, 1);
  const result = await f.gate(f.payload);
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /not been configured/i);
});

test('drift is refused for its drift before anything about the edge is judged', async () => {
  // The edge could not be resolved AND the item has drifted: the person must be
  // told about the drift, which is the thing they can act on.
  const f = await gateFixture({ driftCount: 3, ct: null, transitionId: null,
    snapshot: { edgeFailure: 'SERVICE_UNAVAILABLE', transitionId: null } });
  const result = await f.gate(f.payload);
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /changed since it was approved/i);
  assert.equal(f.calls.pending, 0);
});

test('an edge that cannot be resolved still fails closed once drift has passed', async () => {
  const f = await gateFixture({ driftCount: 0, ct: null, transitionId: null,
    snapshot: { edgeFailure: 'SERVICE_UNAVAILABLE', transitionId: null } });
  assert.equal((await f.gate(f.payload)).result, false);
});

test('uncontrolled sibling transitions with no exact id pass once drift has passed', async () => {
  const f = await gateFixture({ driftCount: 0, ct: null, transitionId: null,
    snapshot: { edgeFailure: null, transitionId: null } });
  assert.equal((await f.gate(f.payload)).result, true);
  assert.equal(f.calls.pending, 0);
});

test('a disabled project refuses its controlled transitions and leaves the rest alone', async () => {
  const controlled = await gateFixture({ driftCount: 0, ct: policy(), snapshot: { health: { enabled: false } } });
  assert.equal((await controlled.gate(controlled.payload)).result, false);
  const open = await gateFixture({ driftCount: 0, ct: null, pendingRow: null, snapshot: { health: { enabled: false } } });
  assert.equal((await open.gate(open.payload)).result, true);
});

test('drift holds a disabled project too', async () => {
  const f = await gateFixture({ driftCount: 1, ct: null, snapshot: { health: { enabled: false } } });
  assert.equal((await f.gate(f.payload)).result, false);
});

test('a restore in progress holds an uncontrolled transition', async () => {
  const f = await gateFixture({ driftCount: 0, ct: null, snapshot: { item: { state: 'RESTORING' } } });
  assert.equal((await f.gate(f.payload)).result, false);
});

test('a baselined item whose controlled transition was later deleted is still held on drift', async () => {
  // The baseline was captured on a controlled transition; the admin has since
  // deleted that row. The signature half has nothing left to ask for, but the
  // baseline still stands, so its drift still holds the item on every
  // transition the validator sits on — and releases it once decided.
  const held = await gateFixture({ driftCount: 2, ct: null, pendingRow: null });
  const refused = await held.gate(held.payload);
  assert.equal(refused.result, false);
  assert.match(refused.errorMessage, /changed since it was approved/i);

  const decided = await gateFixture({ driftCount: 0, ct: null, pendingRow: null });
  assert.equal((await decided.gate(decided.payload)).result, true);
});
