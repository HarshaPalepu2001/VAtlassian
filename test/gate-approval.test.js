import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, rawCodeSubmitted } from '../src/gate.js';
import { makeApproval } from '../src/lib/approval/record.js';
import { providerFor } from '../src/lib/approval/registry.js';

async function fixture() {
  const binding = { accountId: 'actor', issueId: 10, fromStatusId: '1', toStatusId: '2', contentHash: 'a'.repeat(64), decision: 'APPROVE' };
  const proof = await providerFor('NATIVE_TRANSITION').verify({ binding, confirmed: true });
  const row = { ...makeApproval({ ...binding, issueKey: 'T-10', projectId: 1, issueTypeId: '1', actorName: 'Actor', meaning: 'Approve', signerRole: 'reviewer', proof, now: 100 }), state: 'PENDING' };
  const snapshot = { issueId: 10, projectId: 1, issueTypeId: '1', contentHash: binding.contentHash, item: { state: 'BASELINED' }, driftCount: 0, ct: { required_assurance: 'NATIVE_TRANSITION', required_role: 'reviewer', meaning: 'Approve', block_on_drift: 1 } };
  let consumed = false;
  const events = [], logs = [];
  const deps = { now: () => 200, log: (event) => logs.push(event), load: async () => snapshot, pending: async () => row, eligible: async () => true, consume: async () => { const won = !consumed; consumed = true; return { consumed: won }; }, voidOthers: async () => {}, audit: async (event) => events.push(event) };
  const payload = { issue: { key: 'T-10' }, transition: { from: { id: '1' }, to: { id: '2' } } };
  return { deps, row, snapshot, payload, logs, events };
}
test('gate consumes a verified native capability exactly once under concurrent requests', async () => {
  const f = await fixture(), gate = createGate(f.deps);
  const results = await Promise.all([gate(f.payload), gate(f.payload)]);
  assert.equal(results.filter(r => r.result).length, 1);
});
test('gate fails closed on policy, eligibility, drift, content, expiry and token mismatch', async () => {
  const cases = [
    f => { f.snapshot.ct.required_assurance = 'UNKNOWN'; },
    f => { f.snapshot.ct.required_assurance = 'ESIGNATURE'; },
    f => { f.deps.eligible = async () => false; },
    f => { f.snapshot.driftCount = 1; },
    f => { f.snapshot.contentHash = 'b'.repeat(64); },
    f => { f.row.expires_at = 200; },
    f => { f.row.from_status_id = '9'; },
    f => { f.row.decision = 'REJECT'; },
    f => { f.snapshot.item.state = 'RESTORING'; },
    f => { f.payload.transition.modifiedFields = { customfield_1: 'b'.repeat(32) }; },
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
