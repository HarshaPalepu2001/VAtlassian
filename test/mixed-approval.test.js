import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DECISION } from '../src/lib/decision.js';
import { baselineDecisionMeaning, challengeContextHash } from '../src/lib/approval/challenge.js';
import { makeApproval, validEvidence } from '../src/lib/approval/record.js';
import { CAUSE } from '../src/lib/evidence/versionEvidence.js';

test('decide(MIXED) needs drift and cuts a baseline unless every field is rejected', () => {
  assert.equal(decide({ decision: 'MIXED', diff: { changedFieldCount: 0 } }).allow, false);
  const r = decide({ decision: 'MIXED', diff: { changedFieldCount: 2, evidenceHash: 'h' }, evidenceHash: 'h' });
  assert.deepEqual([r.allow, r.cutsNewBaseline, r.marksDriftDecided, r.restores], [true, true, true, true]);
  assert.equal(decide({ decision: 'MIXED', diff: { changedFieldCount: 2, evidenceHash: 'h' }, evidenceHash: 'x' }).reason, 'STALE_EVIDENCE');
  assert.equal(DECISION.MIXED, 'MIXED');
  const base = { decision: 'MIXED', diff: { changedFieldCount: 2, evidenceHash: 'h' }, evidenceHash: 'h' };
  assert.equal(decide({ ...base, approvedCount: 1 }).cutsNewBaseline, true);
  assert.equal(decide({ ...base, approvedCount: 0 }).cutsNewBaseline, false);
});

test('mixed meaning and operation plan hash', () => {
  assert.equal(baselineDecisionMeaning('MIXED', 4), 'Save drift decisions against baseline v4');
  const base = { issue: { statusId: '1' }, transition: null, policy: { meaning: 'm', required_role: 'r', required_assurance: 'ESIGNATURE', capture_baseline: true },
    prepared: { baselineVersion: 1, evidenceHash: 'e' } };
  const a = challengeContextHash({ ...base, prepared: { ...base.prepared, mixed: { planHash: 'p1' } } });
  const b = challengeContextHash({ ...base, prepared: { ...base.prepared, mixed: { planHash: 'p2' } } });
  assert.notEqual(a, b);
  assert.equal(challengeContextHash(base), challengeContextHash({ ...base, prepared: { ...base.prepared, mixed: undefined } }));
});

const proof = hash => ({ ok: true, level: 'ESIGNATURE', providerId: 'esignature', evidence: { binding: {
  accountId: 'a', issueId: 1, fromStatusId: '1', toStatusId: '1', contentHash: 'a'.repeat(64), decision: 'MIXED', decisionMapHash: hash } } });
const mixedInput = hash => ({ proof: proof(hash), now: 1, accountId: 'a', contentHash: 'a'.repeat(64), decision: 'MIXED',
  issueId: 1, issueKey: 'T-1', projectId: 1, issueTypeId: '1', actorName: 'N', signerRole: 'r', meaning: 'm',
  fromStatusId: '1', toStatusId: '1', decisionMap: '[{"decision":"APPROVE","fieldId":"a"}]', decisionMapHash: hash });

test('a mixed approval binds its decision map into the evidence', () => {
  const row = makeApproval(mixedInput('h'.repeat(64)));
  assert.equal(row.decision, 'MIXED');
  assert.equal(row.decision_map_hash, 'h'.repeat(64));
  assert.equal(validEvidence(row), true);
  assert.equal(validEvidence({ ...row, decision_map_hash: 'z'.repeat(64) }), false);
  assert.notEqual(row.evidence_hash, makeApproval(mixedInput('i'.repeat(64))).evidence_hash);
  assert.equal(CAUSE.MIXED_DECISION, 'MIXED_DECISION');
});

test('whole-set approvals are byte-identical to before: no decision-map key in their evidence', () => {
  const plain = { proof: { ok: true, level: 'ESIGNATURE', providerId: 'esignature', evidence: { binding: {
    accountId: 'a', issueId: 1, fromStatusId: '1', toStatusId: '1', contentHash: 'a'.repeat(64), decision: 'APPROVE' } } },
  now: 1, accountId: 'a', contentHash: 'a'.repeat(64), decision: 'APPROVE', issueId: 1, issueKey: 'T-1', projectId: 1,
  issueTypeId: '1', actorName: 'N', signerRole: 'r', meaning: 'm', fromStatusId: '1', toStatusId: '1' };
  const row = makeApproval(plain);
  assert.equal(row.decision_map_hash, null);
  assert.equal(validEvidence(row), true);
});

// ── challenge and submit ─────────────────────────────────────────────────────
import { createApprovalUsecases } from '../src/usecases/approval.js';
import { applyOverlay, mixedPrepared, decisionMapHash, canonicalDecisions } from '../src/lib/approval/mixedDecision.js';

const NODE = 'n1';
const field = (rawFieldId, extra = {}) => ({ fieldId: `${NODE}:${rawFieldId}`, rawFieldId, logicalNodeId: NODE,
  fieldName: rawFieldId, group: { kind: 'ISSUE', logicalNodeId: NODE }, restorable: 'YES', retained: true, ...extra });
const baselineNode = Object.defineProperty({ logicalNodeId: NODE, parentLogicalNodeId: null,
  digests: { summary: 'S0', description: 'D0' } }, 'parentLogicalId', { value: null, enumerable: false });
const tree = {
  baselineTree: { nodes: [baselineNode], values: { [NODE]: { summary: 'old', description: 'oldD' } } },
  currentTree: { nodes: [{ logicalNodeId: NODE, parentLogicalId: null, digests: { summary: 'S1', description: 'D1' } }],
    values: { [NODE]: { summary: 'new', description: 'newD' } } },
  fields: [{ field_id: 'summary', field_kind: 'scalar' }, { field_id: 'description', field_kind: 'scalar' }]
};
const SUMMARY = `${NODE}:summary`, DESCRIPTION = `${NODE}:description`;
const MAP = [{ fieldId: SUMMARY, decision: 'APPROVE' }, { fieldId: DESCRIPTION, decision: 'REJECT' }];

test('mixed overlays replace read-only node digests without mutating the baseline metadata', () => {
  const baselineNode = { logicalNodeId: NODE, parentLogicalNodeId: null };
  Object.defineProperties(baselineNode, {
    parentLogicalId: { value: null, enumerable: false },
    digests: { value: { summary: 'S0', description: 'D0' }, enumerable: false }
  });
  const baselineTree = { nodes: [baselineNode], values: { [NODE]: { summary: 'old', description: 'oldD' } } };

  const result = applyOverlay({ baselineTree, overlay: { [NODE]: { summary: 'S1' } } });
  assert.deepEqual(result.nodes[0].digests, { summary: 'S1', description: 'D0' });
  assert.deepEqual(baselineNode.digests, { summary: 'S0', description: 'D0' });
  assert.equal(result.nodes[0].parentLogicalId, null);
  assert.equal(Object.getOwnPropertyDescriptor(result.nodes[0], 'digests').enumerable, false);
});

function mixedFixture({ reviewFields = [field('summary'), field('description')], fieldLevelBaseline = false } = {}) {
  const rows = [], events = [], challenges = new Map(), applied = [], prepareCalls = [];
  const policy = { transition_id: '5', from_status_id: '1', to_status_id: '2', required_role: 'baseline-reviewer',
    required_assurance: 'ESIGNATURE', meaning: 'Save drift decisions against baseline v4', capture_baseline: true };
  const baseline = { baseline_id: Buffer.alloc(16, 9), version: 4, tree_hash: fieldLevelBaseline ? null : 't'.repeat(64), transition_id: '5',
    from_status_id: '1', to_status_id: '2' };
  const fixedKey = Buffer.alloc(32, 2);
  const deps = {
    now: () => 1700000000000, issue: async () => ({ issueId: 10, issueKey: 'T-10', projectId: 1, issueTypeId: '1', statusId: '1' }),
    actor: async id => ({ accountId: id, displayName: 'Name' }),
    edge: async () => policy, eligible: async () => true, transition: async () => { throw new Error('no transition may be resolved'); },
    // Mirrors drift.prepareApproval for MIXED: the real planner over the server's own tree.
    prepare: async options => {
      prepareCalls.push(options);
      const prepared = { contentHash: 'a'.repeat(64), evidenceHash: 'e'.repeat(64), baselineVersion: 4, driftCount: 2,
        review: { state: 'DRIFTED' }, baseline, approvalPolicy: policy, gate: policy, reviewDiff: { fields: reviewFields },
        ...tree, fieldsFor: () => tree.fields };
      if (options.decision === 'MIXED') prepared.mixed = mixedPrepared({ decisions: options.decisions, prepared });
      return prepared;
    },
    apply: async ({ approval, prepared }) => { applied.push({ approval, prepared }); return { success: false, state: 'RESTORING',
      mixed: { approved: prepared.mixed.approvedIds.length, rejected: prepared.mixed.rejectedIds.length } }; },
    record: async row => rows.push(row), audit: async event => events.push(event),
    activate: async ({ approvalId, state }) => { rows.find(r => r.approval_id.equals(approvalId)).state = state; return true; },
    byId: async id => rows.find(r => r.approval_id.equals(id)),
    totpDeps: { now: () => 1700000000000, consume: async () => true, fail: async () => true, audit: async () => {},
      alert: async () => {}, activate: async () => true, key: () => fixedKey,
      read: async () => {
        const crypto = await import('node:crypto');
        const iv = Buffer.alloc(16, 3), cipher = crypto.createCipheriv('aes-256-gcm', fixedKey, iv);
        const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(20, 1)), cipher.final()]);
        return { state: 'ACTIVE', algo: 'TOTP-SHA1', digits: 6, period_seconds: 30, key_version: 1, version: 1, ciphertext, iv, tag: cipher.getAuthTag() };
      } },
    writeChallenge: async row => { const id = Buffer.alloc(16, 4); challenges.set(id.toString('hex'), { ...row, challenge_id: id }); return id; },
    getChallenge: async id => challenges.get(id.toString('hex')) ?? null,
    markChallengeConsumed: async id => { const row = challenges.get(id.toString('hex')); if (!row || row.state !== 'PENDING') return false; row.state = 'CONSUMED'; return true; }
  };
  const request = { context: { accountId: 'trusted' },
    payload: { issueKey: 'T-10', intent: 'DRIFT_MIXED', decisions: MAP, confirmed: true, code: '007787' } };
  return { deps, rows, events, challenges, applied, prepareCalls, request };
}

test('a mixed challenge is a baseline-owned drift decision: MIXED, no transition, nothing written', async () => {
  const f = mixedFixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  assert.equal(challenge.success, true, JSON.stringify(challenge));
  assert.equal(challenge.meaning, 'Save drift decisions against baseline v4');
  assert.deepEqual(challenge.mixed, { approve: [SUMMARY], reject: [DESCRIPTION], evidenceHash: 'e'.repeat(64) });
  const stored = f.challenges.get(challenge.challengeId);
  assert.equal(stored.decision, 'MIXED');
  assert.equal(stored.transition_id, null);
  assert.equal(f.rows.length, 0);
  assert.equal(f.applied.length, 0);
});

test('a mixed challenge accepts a scoped tree reconstructed from a field-level child baseline', async () => {
  const f = mixedFixture({ fieldLevelBaseline: true }), api = createApprovalUsecases(f.deps);
  const result = await api.challenge(f.request);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.meaning, 'Save drift decisions against baseline v4');
  assert.deepEqual(result.mixed, { approve: [SUMMARY], reject: [DESCRIPTION], evidenceHash: 'e'.repeat(64) });
});

test('a mixed challenge failure records the failing phase and safe error detail without changing the public denial', async () => {
  const f = mixedFixture();
  f.deps.writeChallenge = async () => { throw Object.assign(new TypeError('undefined in audit payload'), { code: 'E_TEST' }); };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const result = await createApprovalUsecases(f.deps).challenge(f.request);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'SERVICE_UNAVAILABLE');
    assert.equal(f.challenges.size, 0);
    const detail = logged.find(args => args[0] === 'approval: unhandled failure')?.[1];
    assert.equal(detail.phase, 'write-challenge');
    assert.equal(detail.name, 'TypeError');
    assert.equal(detail.message, 'undefined in audit payload');
    assert.equal(detail.code, 'E_TEST');
  } finally {
    console.error = originalError;
  }
});

test('signing a mixed decision records one MIXED approval carrying the exact field map', async () => {
  const f = mixedFixture(), api = createApprovalUsecases(f.deps);
  const { challengeId } = await api.challenge(f.request);
  // The map is re-sent at submit, in a different order: order must not matter.
  const result = await api.submit({ context: f.request.context,
    payload: { ...f.request.payload, decisions: [...MAP].reverse(), challengeId } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.rows.length, 1);
  const [row] = f.rows;
  const canon = canonicalDecisions(MAP);
  assert.equal(row.decision, 'MIXED');
  assert.equal(row.decision_map_hash, decisionMapHash(canon));
  assert.deepEqual(JSON.parse(row.decision_map), canon);
  assert.equal(JSON.parse(row.provider_evidence).binding.decisionMapHash, decisionMapHash(canon));
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].approval.decision, 'MIXED');
  assert.deepEqual(result.mixed, { approved: 1, rejected: 1 });
  const audit = f.events.find(e => e.eventType === 'APPROVAL_RECORDED');
  assert.deepEqual(audit.payload.decisionMap, canon);
  assert.equal(audit.payload.approvedCount, 1);
  assert.equal(audit.payload.rejectedCount, 1);
});

test('an invalid map is refused at challenge, before any challenge row exists', async () => {
  const cases = [
    ['a missing field', [MAP[0]], 'DECISION_MAP_MISMATCH'],
    ['an unknown field', [...MAP, { fieldId: 'ghost:x', decision: 'APPROVE' }], 'DECISION_MAP_MISMATCH'],
    ['a duplicate', [...MAP, MAP[0]], 'DECISION_MAP_INVALID'],
    ['not a list', null, 'DECISION_MAP_INVALID']
  ];
  for (const [name, decisions, reason] of cases) {
    const f = mixedFixture();
    f.request.payload.decisions = decisions;
    const result = await createApprovalUsecases(f.deps).challenge(f.request);
    assert.equal(result.success, false, name);
    assert.equal(result.reason, reason, name);
    assert.equal(f.challenges.size, 0, `${name}: no challenge was written`);
  }
});

test('a field whose approved value was not kept cannot be rejected, and nothing is spent finding out', async () => {
  const f = mixedFixture({ reviewFields: [field('summary', { restorable: 'NOT_RETAINED', retained: false }), field('description')] });
  f.request.payload.decisions = [{ fieldId: SUMMARY, decision: 'REJECT' }, { fieldId: DESCRIPTION, decision: 'APPROVE' }];
  const result = await createApprovalUsecases(f.deps).challenge(f.request);
  assert.equal(result.reason, 'FIELD_NOT_RESTORABLE');
  assert.equal(f.challenges.size, 0);
});

test('structural drift makes the mixed decision unavailable', async () => {
  const f = mixedFixture({ reviewFields: [field('summary'), { fieldId: 'tree:NODE_ADDED:n2', group: { kind: 'STRUCTURE' }, restorable: 'SPECIAL' }] });
  const result = await createApprovalUsecases(f.deps).challenge(f.request);
  assert.equal(result.reason, 'MIXED_STRUCTURE_UNSUPPORTED');
  assert.equal(f.challenges.size, 0);
});

test('submitting a different map than the one challenged records nothing', async () => {
  const f = mixedFixture(), api = createApprovalUsecases(f.deps);
  const { challengeId } = await api.challenge(f.request);
  const flipped = MAP.map(d => ({ ...d, decision: d.decision === 'APPROVE' ? 'REJECT' : 'APPROVE' }));
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, decisions: flipped, challengeId } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'CONTENT_CHANGED');
  assert.equal(f.rows.length, 0);
  assert.equal(f.applied.length, 0);
});

test('a consumed challenge cannot be replayed', async () => {
  const f = mixedFixture(), api = createApprovalUsecases(f.deps);
  const { challengeId } = await api.challenge(f.request);
  assert.equal((await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId } })).success, true);
  const replay = await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId } });
  assert.equal(replay.success, false);
  assert.equal(replay.reason, 'NO_DECISION');
  assert.equal(f.rows.length, 1);
});

test('a failed authentication records nothing and leaves the challenge usable', async () => {
  const f = mixedFixture(), api = createApprovalUsecases(f.deps);
  f.deps.totpDeps.consume = async () => false;
  const { challengeId } = await api.challenge(f.request);
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, code: '000000', challengeId } });
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
  assert.equal(f.applied.length, 0);
  assert.equal(f.challenges.get(challengeId).state, 'PENDING');
});

test('a mixed decision with no confirmation is refused', async () => {
  const f = mixedFixture(), api = createApprovalUsecases(f.deps);
  const { challengeId } = await api.challenge(f.request);
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, confirmed: false, challengeId } });
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
});

// ── the capture guard a mixed decision relies on ─────────────────────────────
import { writeCapturedTreeBaseline } from '../src/lib/capture.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';

test('a capture is refused unless it matches the signed hash, or the verified hash a mixed decision names', async () => {
  const controlled = [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }];
  const nodes = [{ id: '1', key: 'P-1', fields: { summary: 'resulting', project: { id: '1' }, issuetype: { id: 'S' }, parent: null } }];
  const live = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: controlled }).treeHash;
  const REACHED = new Error('guard passed');
  const run = extra => writeCapturedTreeBaseline({
    rootIssue: { id: '1', key: 'P-1', fields: nodes[0].fields }, controlledFields: controlled,
    ruleScope: { source: 'OWN', projectId: 1, issueTypeId: 'S' }, transitionAt: 1, cause: 'MIXED_DECISION',
    policy: { transition_id: '5', from_status_id: '1', to_status_id: '2', required_role: 'r', required_assurance: 'ESIGNATURE' },
    approval: { approvalId: Buffer.alloc(16, 1), accountId: 'a', displayName: 'A', assuranceLevel: 'ESIGNATURE',
      content_hash: 'c'.repeat(64) /* the signed CANDIDATE, which is not the resulting state */ },
    ...extra,
    deps: { planTreeCapture, baselineForApproval: async () => null, readStableTree: async () => ({ tree: { nodes } }),
      readTree: async () => ({}), currentVersion: async () => 1, beginTreeBaseline: async () => { throw REACHED; } } });
  assert.equal((await run({})).reason, 'CONTENT_CHANGED', 'without a verified hash the signed hash is the only way in');
  assert.equal((await run({ expectedTreeHash: 'd'.repeat(64) })).reason, 'CONTENT_CHANGED', 'a wrong verified hash is refused');
  await assert.rejects(run({ expectedTreeHash: live }), REACHED, 'the verified hash is accepted');
});
