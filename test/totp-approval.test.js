import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, generateCode } from '../src/lib/totp.js';
import { verifyTotp } from '../src/lib/approval/totpVerification.js';
import { createTotpUsecases } from '../src/usecases/totp.js';

function fixture(state = 'ACTIVE') {
  const secret = Buffer.from('12345678901234567890'), key = Buffer.alloc(32, 7), now = 1200000;
  let row = { ...encryptSecret(secret, key, 1), key_version: 1, algo: 'TOTP-SHA1', digits: 6,
    period_seconds: 30, state, failed_attempts: 0, last_used_step: null, version: 0, enrolled_at: now };
  const events = [];
  const deps = { now: () => now, key: () => key, read: async () => ({ ...row }), audit: async event => events.push(event), alert: async () => {},
    consume: async (id, old, step) => { if (row.version !== old.version) return false; row.version++; row.last_used_step = step; return true; },
    fail: async (id, old, fail) => { if (row.version !== old.version) return false; row.version++; row.failed_attempts = fail.attempts; if (fail.locked) row.state = 'LOCKED'; return true; },
    activate: async (id, old) => { if (row.version !== old.version + 1) return false; row.version++; row.state = 'ACTIVE'; return true; },
    grant: async () => null,
    redeem: async () => false,
    save: async (id, old, stored, enrolledAt) => { row = { ...stored, state: 'PENDING_CONFIRM', enrolled_at: enrolledAt }; return true; }
  };
  return { deps, secret, key, now, events, get row() { return row; } };
}
test('encrypted TOTP verifies once across simultaneous approvals', async () => {
  const f = fixture(), code = generateCode(f.secret, f.now);
  const results = await Promise.all([verifyTotp('owner', code, {}, f.deps), verifyTotp('owner', code, {}, f.deps)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal((await verifyTotp('owner', code, {}, f.deps)).ok, false);
});
test('three real failed codes lock credential; malformed input does not spend attempts', async () => {
  const f = fixture();
  assert.equal((await verifyTotp('owner', 'oops', {}, f.deps)).reason, 'CODE_FORMAT');
  assert.equal(f.row.failed_attempts, 0);
  for (let i = 0; i < 3; i++) await verifyTotp('owner', '000000', {}, f.deps);
  assert.equal(f.row.state, 'LOCKED');
  assert.equal((await verifyTotp('owner', generateCode(f.secret, f.now), {}, f.deps)).ok, false);
  assert.ok(f.events.some(e => e.eventType === 'TOTP_LOCKED_OUT'));
  assert.doesNotMatch(JSON.stringify(f.events), /000000|ciphertext|secret/);
});
test('unknown credential policy or encryption key version fails closed', async () => {
  const f = fixture(); f.row.digits = 0;
  assert.equal((await verifyTotp('owner', '000000', {}, f.deps)).reason, 'NOT_CONFIGURED');
});
test('confirmation requires fresh enrollment and activation waits for durable audit', async () => {
  const f = fixture('PENDING_CONFIRM'); f.row.enrolled_at = 0;
  assert.equal((await verifyTotp('owner', generateCode(f.secret, f.now), { confirm: true }, f.deps)).reason, 'ENROLMENT_EXPIRED');
  f.row.enrolled_at = f.now;
  f.deps.audit = async () => { throw new Error('ledger unavailable'); };
  await assert.rejects(verifyTotp('owner', generateCode(f.secret, f.now), { confirm: true }, f.deps));
  assert.equal(f.row.state, 'PENDING_CONFIRM');
});
test('active or locked credential cannot be replaced without administrator grant', async () => {
  for (const state of ['ACTIVE','LOCKED']) {
    const f = fixture(state);
    assert.equal((await createTotpUsecases(f.deps).enrol({ context: { accountId: 'owner' }, payload: {} })).success, false);
    assert.equal(f.row.state, state);
  }
});
test('TOTP endpoints reject missing context identity and ignore payload actor', async () => {
  const f = fixture(); let readId;
  f.deps.read = async id => { readId = id; return f.row; };
  const api = createTotpUsecases(f.deps);
  assert.equal((await api.checkStatus({ payload: { accountId: 'victim' } })).success, false);
  assert.equal((await api.checkStatus({ payload: { accountId: 'victim' }, context: { accountId: 'owner' } })).isEnrolled, true);
  assert.equal(readId, 'owner');
});
