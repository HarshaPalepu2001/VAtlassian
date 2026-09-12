import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, rawCodeSubmitted } from '../src/gate.js';
import { makeApproval } from '../src/lib/approval/record.js';
import { providerFor } from '../src/lib/approval/registry.js';

async function fixture(level = 'ESIGNATURE') {
  const binding = { accountId: 'actor', issueId: 10, fromStatusId: '1', toStatusId: '2', contentHash: 'a'.repeat(64), decision: 'APPROVE' };
  const proof = level === 'NATIVE_TRANSITION'
    ? await providerFor('NATIVE_TRANSITION').verify({ binding, confirmed: true })
    : { ok: true, level, providerId: 'totp', evidence: { method: 'SESSION_AND_TOTP', verifiedAt: 100, binding } };
  const row = { ...makeApproval({ ...binding, issueKey: 'T-10', projectId: 1, issueTypeId: '1', actorName: 'Actor', meaning: 'Approve', signerRole: 'reviewer', proof, transitionId: '50', now: 100 }), state: 'PENDING' };
  const snapshot = { issueId: 10, projectId: 1, issueTypeId: '1', contentHash: binding.contentHash, item: { state: 'BASELINED' }, driftCount: 0, ct: { required_assurance: 'NATIVE_TRANSITION', required_role: 'reviewer', meaning: 'Approve', block_on_drift: 1 } };
  let consumed = false;
  const events = [], logs = [];
  const deps = { now: () => 200, log: (event) => logs.push(event), load: async () => snapshot, pending: async () => row, eligible: async () => true, consume: async () => { const won = !consumed; consumed = true; return { consumed: won }; }, voidOthers: async () => {}, audit: async (event) => events.push(event) };
  const payload = { issue: { key: 'T-10' }, transition: { id: '50', from: { id: '1' }, to: { id: '2' } } };
  return { deps, row, snapshot, payload, logs, events };
}
test('gate consumes a verified capability exactly once under concurrent requests', async () => {
  const f = await fixture(), gate = createGate(f.deps);
  const results = await Promise.all([gate(f.payload), gate(f.payload)]);
  assert.equal(results.filter(r => r.result).length, 1);
});
test('gate refuses legacy session-only approvals even if stored transition policy is weaker', async () => {
  const f = await fixture('NATIVE_TRANSITION');
  const result = await createGate(f.deps)(f.payload);
  assert.equal(result.result, false);
});
test('gate refuses an item with an unresolved operation error', async () => {
  const f = await fixture(); f.snapshot.item.state = 'ERROR';
  assert.equal((await createGate(f.deps)(f.payload)).result, false);
});
test('gate fails closed on policy, eligibility, drift, content, expiry and token mismatch', async () => {
  const cases = [
    f => { f.snapshot.ct.required_assurance = 'UNKNOWN'; },
    f => { f.snapshot.ct.required_assurance = 'BIOMETRIC'; },
    f => { f.deps.eligible = async () => false; },
    f => { f.snapshot.driftCount = 1; },
    f => { f.snapshot.contentHash = 'b'.repeat(64); },
    f => { f.row.expires_at = 200; },
    f => { f.row.from_status_id = '9'; },
    f => { f.row.decision = 'REJECT'; },
    f => { f.snapshot.item.state = 'RESTORING'; },
    f => { f.payload.transition.modifiedFields = { customfield_1: 'b'.repeat(32) }; },
    f => { f.payload.transition.id = null; },
    f => { f.row.transition_id = '999'; },
  ];
  for (const mutate of cases) {
    const f = await fixture(); mutate(f);
    f.deps.consume = async () => assert.fail('Refusal must not spend capability');
    assert.equal((await createGate(f.deps)(f.payload)).result, false);
  }
});
test('raw-code trap precedes I/O, and telemetry never includes credentials or field values', async () => {
  const f = await fixture();
  f.payload.transition.modifiedFields = { customfield_1: '123 456', secret: 'private text' };
  f.deps.load = async () => assert.fail('Code trap must run first');
  assert.equal((await createGate(f.deps)(f.payload)).result, false);
  assert.equal(rawCodeSubmitted({ value: '123 456' }), true);
  assert.doesNotMatch(JSON.stringify(f.logs), /123|456|private text/);
});
test('audit failure on allow path returns denial even after CAS', async () => {
  const f = await fixture(); f.deps.audit = async () => { throw new Error('unavailable'); };
  assert.equal((await createGate(f.deps)(f.payload)).result, false);
});

// Two workflow transitions can share a destination status ("Approve" and
// "Approve (fast-track)", both 1 -> 2). Matching on the status pair alone
// cannot tell them apart, so a receipt signed for one transition id must
// never be accepted for a request naming a different one — even though
// deps.pending here is a stub that hands back the same row regardless of
// what it was asked for, exactly as a real query that filtered on the wrong
// id would.
test('validator cannot consume a receipt signed for a sibling transition', async () => {
  const f = await fixture('BIOMETRIC');
  f.payload.transition.id = '103';
  f.row.transition_id = '102';
  assert.equal((await createGate(f.deps)(f.payload)).result, false);
});
