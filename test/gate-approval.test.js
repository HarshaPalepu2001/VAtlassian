import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, rawCodeSubmitted } from '../src/gate.js';
import { makeApproval } from '../src/lib/approval/record.js';
import { providerFor } from '../src/lib/approval/registry.js';
import { approvalContentHash } from '../src/lib/approval/runtime.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';

async function fixture(level = 'ESIGNATURE', baselineControl = null) {
  const binding = { accountId: 'actor', issueId: 10, fromStatusId: '1', toStatusId: '2', contentHash: 'a'.repeat(64), decision: 'APPROVE', transitionId: '50' };
  const proof = level === 'NATIVE_TRANSITION'
    ? await providerFor('NATIVE_TRANSITION').verify({ binding, confirmed: true })
    : { ok: true, level, providerId: 'totp', evidence: { method: 'SESSION_AND_TOTP', verifiedAt: 100, binding } };
  const row = { ...makeApproval({ ...binding, issueKey: 'T-10', projectId: 1, issueTypeId: '1', actorName: 'Actor',
    meaning: baselineControl?.meaning ?? 'Approve', signerRole: baselineControl?.required_role ?? 'reviewer',
    proof, transitionId: '50', now: 100, baselineId: baselineControl?.baselineId,
    baselineVersion: baselineControl?.version ?? 0 }), state: 'PENDING' };
  const snapshot = { issueId: 10, projectId: 1, issueTypeId: '1', contentHash: binding.contentHash, item: { state: 'BASELINED' }, driftCount: 0, ct: { required_assurance: 'NATIVE_TRANSITION', required_role: 'reviewer', meaning: 'Approve', block_on_drift: 1 } };
  let consumed = false;
  const events = [], logs = [];
  const deps = { now: () => 200, log: (event) => logs.push(event), load: async () => snapshot, pending: async () => row,
    policyForApproval: baselineControl ? async () => baselineControl : undefined,
    eligible: async () => true, consume: async () => { const won = !consumed; consumed = true; return { consumed: won }; }, voidOthers: async () => {}, audit: async (event) => events.push(event) };
  const payload = { issue: { key: 'T-10' }, transition: { id: '50', from: { id: '1' }, to: { id: '2' } } };
  return { deps, row, snapshot, payload, logs, events };
}
test('gate consumes a verified capability exactly once under concurrent requests', async () => {
  const f = await fixture(), gate = createGate(f.deps);
  const results = await Promise.all([gate(f.payload), gate(f.payload)]);
  assert.equal(results.filter(r => r.result).length, 1);
});
test('validator accepts Jira Lambda payloads without transition.id when trusted loading resolves it', async () => {
  const f = await fixture();
  f.payload.transition.id = null;
  let loaded;
  f.deps.load = async args => {
    loaded = args;
    return { ...f.snapshot, transitionId: '50' };
  };

  const result = await createGate(f.deps)(f.payload);

  assert.equal(result.result, true, JSON.stringify(result));
  assert.equal(loaded.transitionId, null);
});
test('validator recomputes the recursive tree hash for a tree-backed baseline', async () => {
  const controlledFields = ['summary', 'description', 'issuelinks', 'subtasks'].map(field_id => ({
    field_id, field_name: field_id, field_kind: field_id === 'description' ? 'ADF' : field_id === 'summary' ? 'TEXT' : 'MULTI',
    store_values: true, writable: true
  }));
  const issue = { id: '10', key: 'T-10', fields: {
    project: { id: '1' }, issuetype: { id: '1' }, status: { id: '1' }, parent: null,
    summary: 'root', description: null, issuelinks: [], subtasks: []
  } };
  const tree = childSummary => ({ nodes: [
    issue,
    { id: '11', key: 'T-11', fields: { ...issue.fields, parent: { id: '10' }, summary: childSummary } }
  ] });
  const read = childSummary => async (_key, fieldIds) => fieldIds.length === 1 && fieldIds[0] === 'parent'
    ? tree(childSummary) : tree(childSummary);

  const first = await approvalContentHash({ issue, declared: controlledFields, modifiedFields: {},
    activeBaseline: { tree_hash: 'stored-tree' }, readTree: read('child v1') });
  const second = await approvalContentHash({ issue, declared: controlledFields, modifiedFields: {},
    activeBaseline: { tree_hash: 'stored-tree' }, readTree: read('child v2') });

  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.contentHash, second.contentHash);
});
test('validator hashes a parent-captured child in the same recursive scope as its approval panel', async () => {
  const declared = [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, writable: true }];
  const issue = { id: '57', key: 'VAT-57', fields: {
    project: { id: '1' }, issuetype: { id: '2' }, status: { id: '10000' },
    parent: { id: '56' }, summary: 'child root'
  } };
  // The tree reader intentionally makes the selected child the root of its
  // own review, while retaining descendants signed under the parent's tree.
  const nodes = [
    { ...issue, fields: { ...issue.fields, parent: null } },
    { id: '58', key: 'VAT-58', fields: { ...issue.fields, parent: { id: '57' }, summary: 'grandchild' } }
  ];
  const panelHash = planTreeCapture({ rootIssueId: issue.id, nodes, controlledFields: declared }).treeHash;
  const validator = await approvalContentHash({ issue, declared,
    activeBaseline: { tree_hash: null, captured_by_baseline_id: Buffer.alloc(16, 1) },
    readTree: async () => ({ nodes }) });

  assert.equal(validator.contentHash, panelHash);
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
test('validator uses the approval baseline policy even when current edge configuration was edited', async () => {
  const baselineControl = {
    baselineId: Buffer.alloc(16, 7), version: 4,
    required_assurance: 'ESIGNATURE', required_role: 'baseline-reviewer',
    meaning: 'Approve changes against baseline v4', block_on_drift: true
  };
  const f = await fixture('ESIGNATURE', baselineControl);
  f.snapshot.ct = { required_assurance: 'BIOMETRIC', required_role: 'attacker',
    meaning: 'Changed configuration', block_on_drift: true };
  const checkedRoles = [];
  f.deps.eligible = async ({ role }) => { checkedRoles.push(role); return role === 'baseline-reviewer'; };
  const result = await createGate(f.deps)(f.payload);
  assert.equal(result.result, true, JSON.stringify(result));
  assert.deepEqual(checkedRoles, ['baseline-reviewer']);
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
test('raw-code trap precedes spending the approval, and telemetry never includes credentials or field values', async () => {
  // The trap cannot precede the load any more: only the loaded edge says
  // whether a signature is being asked for, and so whether six digits are a code.
  const f = await fixture();
  f.payload.transition.modifiedFields = { customfield_1: '123 456', secret: 'private text' };
  f.deps.consume = async () => assert.fail('Code trap must refuse before the approval is spent');
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

// WHAT THE VALIDATOR READS. The configured assurance is per edge, and the
// floor in levels.js means a policy weaker than an electronic signature is
// enforced AS an electronic signature. Only two tiers are therefore
// enforceable, and this is the table of which approval satisfies which policy.
// The level has to be baked into the row rather than assigned afterwards:
// evidence_hash covers assurance_level, so a row edited in place is refused
// as tampered before the assurance comparison is ever reached.
test('the validator enforces the assurance configured on that edge, and nothing weaker', async () => {
  const cases = [
    { policy: 'NATIVE_TRANSITION', obtained: 'ESIGNATURE', allowed: true },
    { policy: 'NATIVE_TRANSITION', obtained: 'BIOMETRIC', allowed: true },
    { policy: 'JSM_APPROVAL', obtained: 'ESIGNATURE', allowed: true },
    { policy: 'JSM_APPROVAL', obtained: 'BIOMETRIC', allowed: true },
    { policy: 'ESIGNATURE', obtained: 'ESIGNATURE', allowed: true },
    { policy: 'ESIGNATURE', obtained: 'BIOMETRIC', allowed: true },
    { policy: 'BIOMETRIC', obtained: 'BIOMETRIC', allowed: true },
    // The case on screen today: a biometric edge signed with a code only.
    { policy: 'BIOMETRIC', obtained: 'ESIGNATURE', allowed: false },
    { policy: 'BIOMETRIC', obtained: 'NATIVE_TRANSITION', allowed: false },
    // Weaker than the floor never passes, whatever the edge says.
    { policy: 'ESIGNATURE', obtained: 'NATIVE_TRANSITION', allowed: false },
    { policy: 'NATIVE_TRANSITION', obtained: 'NATIVE_TRANSITION', allowed: false },
    { policy: 'UNKNOWN', obtained: 'BIOMETRIC', allowed: false }
  ];
  for (const { policy, obtained, allowed } of cases) {
    const f = await fixture(obtained);
    f.snapshot.ct.required_assurance = policy;
    const result = await createGate(f.deps)(f.payload);
    assert.equal(result.result, allowed, `policy ${policy} with ${obtained} should be ${allowed ? 'allowed' : 'refused'}`);
  }
});

test('the validator states which assurance was obtained and which the edge required', async () => {
  const f = await fixture('ESIGNATURE');
  f.snapshot.ct.required_assurance = 'BIOMETRIC';
  const result = await createGate(f.deps)(f.payload);
  assert.equal(result.result, false);
  assert.match(result.errorMessage, /Obtained: ESIGNATURE/);
  assert.match(result.errorMessage, /Required: BIOMETRIC/);
});

// Eligibility is re-read at transition time against the role the edge names,
// so a reviewer removed from that role after signing cannot still transition.
test('the validator serves only people who still hold the role that edge requires', async () => {
  const f = await fixture('BIOMETRIC');
  f.snapshot.ct.required_assurance = 'BIOMETRIC';
  const asked = [];
  f.deps.eligible = async args => { asked.push(args); return false; };
  const refused = await createGate(f.deps)(f.payload);
  assert.equal(refused.result, false);
  assert.equal(asked[0].role, 'reviewer', 'eligibility is checked against the role configured on the edge');
  assert.equal(asked[0].accountId, 'actor', 'and against the account that actually signed');

  const held = await fixture('BIOMETRIC');
  held.snapshot.ct.required_assurance = 'BIOMETRIC';
  assert.equal((await createGate(held.deps)(held.payload)).result, true);
});

test('gate emits SIGNATURE_CONSUMED with full denormalised payload on successful transition', async () => {
  const f = await fixture();
  const result = await createGate(f.deps)(f.payload);
  assert.equal(result.result, true);
  const consumedEvent = f.events.find(e => e.eventType === 'SIGNATURE_CONSUMED');
  assert.ok(consumedEvent, 'SIGNATURE_CONSUMED must be appended to the ledger');
  assert.equal(consumedEvent.actorAccountId, 'actor');
  assert.equal(consumedEvent.issueId, 10);
  assert.deepEqual(consumedEvent.approvalId, f.row.approval_id);
  assert.equal(consumedEvent.payload.actorName, 'Actor');
  assert.equal(consumedEvent.payload.role, 'reviewer');
  assert.equal(consumedEvent.payload.assuranceLevel, 'ESIGNATURE');
  assert.equal(consumedEvent.payload.meaning, 'Approve');
  assert.equal(consumedEvent.payload.fromStatusId, '1');
  assert.equal(consumedEvent.payload.toStatusId, '2');
  assert.equal(consumedEvent.payload.transitionId, '50');
  assert.equal(consumedEvent.payload.decision, 'APPROVE');
});
