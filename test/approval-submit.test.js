import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalUsecases } from '../src/usecases/approval.js';
import crypto from 'node:crypto';

function fixture() {
  const rows = [], events = [];
  const issue = { issueId: 10, issueKey: 'T-10', projectId: 1, issueTypeId: '1', statusId: '1' };
  const deps = {
    now: () => 1700000000000, issue: async () => issue, actor: async id => ({ accountId: id, displayName: 'Name' }),
    edge: async () => ({ required_assurance: 'NATIVE_TRANSITION', required_role: 'reviewer', meaning: 'Approve', capture_baseline: true, block_on_drift: true }),
    eligible: async () => true, transition: async () => ({ id: '5', toStatusId: '2' }),
    prepare: async () => ({ contentHash: 'a'.repeat(64), evidenceHash: 'e'.repeat(64), baselineVersion: 1, driftCount: 0 }),
    apply: async () => ({ success: true }), record: async row => rows.push(row), audit: async event => events.push(event),
    activate: async ({ approvalId, state }) => { rows.find(r => r.approval_id.equals(approvalId)).state = state; return true; },
    performTransition: async () => ({ transitioned: true }),
    byId: async id => rows.find(r => r.approval_id.equals(id)),
    totpDeps: {
      now: () => 1700000000000,
      consume: async () => true, fail: async () => true, audit: async () => {}, alert: async () => {}, activate: async () => true
    }
  };
  const request = { context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', transitionId: '5', decision: 'APPROVE', confirmed: true, preauthorize: true, accountId: 'spoof', code: '007787' } };
  
  // Actually, I can just use a fixed key.
  const fixedKey = Buffer.alloc(32, 2);
  deps.totpDeps.key = () => fixedKey;
  deps.totpDeps.read = async () => {
    const crypto = await import('node:crypto');
    const secret = Buffer.alloc(20, 1);
    const iv = Buffer.alloc(16, 3);
    const cipher = crypto.createCipheriv('aes-256-gcm', fixedKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { state: 'ACTIVE', algo: 'TOTP-SHA1', digits: 6, period_seconds: 30, key_version: 1, version: 1, ciphertext, iv, tag };
  };
  
  return { deps, rows, events, request };
}
test('only resolver identity enters the persisted approval and audit precedes usable capability', async () => {
  const f = fixture();
  f.deps.audit = async () => assert.equal(f.rows[0].state, 'VOID');
  const result = await createApprovalUsecases(f.deps).submit(f.request);
  assert.equal(result.success, true);
  assert.equal(f.rows[0].account_id, 'trusted');
  assert.equal(f.rows[0].state, 'PENDING');
});
test('failed approval audit leaves only an unusable record', async () => {
  const f = fixture(); f.deps.audit = async () => { throw new Error('audit down'); };
  assert.equal((await createApprovalUsecases(f.deps).submit(f.request)).success, false);
  assert.equal(f.rows[0].state, 'VOID');
});
test('capture failure cannot complete ratification or publish a pending capability', async () => {
  const f = fixture(); delete f.request.payload.transitionId;
  f.deps.apply = async () => ({ success: false, captured: false });
  assert.equal((await createApprovalUsecases(f.deps).submit(f.request)).success, false);
  assert.equal(f.rows[0].state, 'VOID');
});
test('stale reviewed evidence is rejected before recording', async () => {
  const f = fixture(); f.request.payload.expectedEvidenceHash = 'f'.repeat(64);
  assert.equal((await createApprovalUsecases(f.deps).submit(f.request)).success, false);
  assert.equal(f.rows.length, 0);
});
test('rejection applies baseline restoration then becomes consumed, never pending', async () => {
  const f = fixture(); f.request.payload.decision = 'REJECT';
  let applied = false; f.deps.apply = async ({ approval }) => { assert.equal(approval.state, 'VOID'); applied = true; return { success: true }; };
  assert.equal((await createApprovalUsecases(f.deps).submit(f.request)).success, true);
  assert.equal(applied, true); assert.equal(f.rows[0].state, 'CONSUMED');
});
test('retry cannot use another actor approval or mint new capability', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const result = await api.submit(f.request);
  assert.equal(result.success, true);
  const retry = await api.retryTransition({ context: { accountId: 'intruder' }, payload: { issueKey: 'T-10', approvalId: result.approvalId, transitionId: '5' } });
  assert.equal(retry.success, false); assert.equal(f.rows.length, 1);
});
