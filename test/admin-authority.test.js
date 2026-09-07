import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { getEncryptionKey } from '../src/usecases/credentialKey.js';
import { fixture, request } from './admin-fixture.js';

test('every endpoint rejects missing identity before touching dependencies', async () => {
  for (const [name, handler] of Object.entries(admin)) {
    const deps = fixture();
    assert.equal((await handler({ payload: {} }, deps)).success, false, name);
    assert.equal(deps.calls.length, 0, name);
  }
});

test('all privileged endpoints reject inactive admins and database failure', async () => {
  const publicNames = new Set(['check', 'bootstrap', 'runMigrations']);
  for (const [name, handler] of Object.entries(admin)) {
    if (publicNames.has(name)) continue;
    for (const options of [{ unauthorized: true }, { authError: true }]) {
      const deps = fixture(options);
      assert.equal((await handler(request(), deps)).ok, false, name);
      assert.equal(deps.calls.length, 1, name);
      assert.equal(deps.events.length, 0, name);
    }
  }
});

test('bootstrap check never translates unreadable roster to needsBootstrap', async () => {
  const result = await admin.check(request(), fixture({ query: () => ({ result: false }) }));
  assert.equal(result.success, false);
  assert.equal(result.needsBootstrap, undefined);
});

test('bootstrap requires live Jira administrator permission', async () => {
  const deps = fixture(); deps.isJiraAdmin = async () => false;
  assert.equal((await admin.bootstrap(request(), deps)).success, false);
  assert.equal(deps.calls.length, 0);
});

test('concurrent bootstrap selects a single account using config primary key', async () => {
  let owner;
  const admins = [];
  const deps = fixture({ query: (sql, params) => {
    if (sql === 'SELECT account_id FROM va_admin') return { result: true, data: [...admins] };
    if (sql.includes('INSERT INTO va_config')) owner ??= params[0];
    if (sql.includes('SELECT cfg_value')) return { result: true, data: [{ cfg_value: owner }] };
    if (sql.includes('INSERT INTO va_admin')) admins.push({ account_id: params[0] });
    return { result: true, data: [] };
  } });
  const results = await Promise.all([admin.bootstrap(request({}, 'alice'), deps), admin.bootstrap(request({}, 'bob'), deps)]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.deepEqual(admins, [{ account_id: owner }]);
  assert.equal(deps.events[0].actorAccountId, owner);
});

test('bootstrap audit failure never activates an administrator', async () => {
  const deps = fixture({ auditError: true, query: sql => ({ result: true, data: sql.includes('SELECT cfg_value') ? [{ cfg_value: 'admin' }] : [] }) });
  assert.equal((await admin.bootstrap(request(), deps)).success, false);
  assert.equal(deps.calls.some(c => c.sql.includes('INSERT INTO va_admin')), false);
});

test('credential reset requires another person and audit before usable grant', async () => {
  const deps = fixture({ auditError: true });
  assert.equal((await admin.issueCredentialResetGrant(request({ targetAccountId: 'admin' }), deps)).success, false);
  assert.equal((await admin.issueCredentialResetGrant(request({ targetAccountId: 'other' }), deps)).success, false);
  assert.equal(deps.calls.some(c => c.sql.includes('INSERT INTO va_credential_reset_grant')), false);
});

test('credential grants carry correct target and bounded expiry', async () => {
  const deps = fixture();
  const start = Date.now();
  const result = await admin.issueCredentialResetGrant(request({ targetAccountId: 'other' }), deps);
  assert.equal(result.success, true);
  assert.ok(result.expiresAt >= start + 24 * 60 * 60 * 1000);
  const write = deps.calls.find(c => c.sql.includes('INSERT INTO va_credential_reset_grant'));
  assert.deepEqual(write.params.slice(1, 3), ['other', 'admin']);
});

test('credential inventory does not select encrypted secrets', async () => {
  const deps = fixture();
  assert.equal((await admin.listCredentials(request(), deps)).success, true);
  assert.doesNotMatch(deps.calls.at(-1).sql, /secret_|key_version/);
});

test('strict encryption key parser rejects hex suffix garbage', () => {
  const previous = process.env.TOTP_ENC_KEY_V1;
  try {
    process.env.TOTP_ENC_KEY_V1 = 'a'.repeat(64) + 'xx';
    assert.throws(getEncryptionKey, /64 hexadecimal/);
    process.env.TOTP_ENC_KEY_V1 = 'a'.repeat(64);
    assert.equal(getEncryptionKey().length, 32);
  } finally {
    if (previous === undefined) delete process.env.TOTP_ENC_KEY_V1;
    else process.env.TOTP_ENC_KEY_V1 = previous;
  }
});
