import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  base32Encode, base32Decode, generateSecret, provisioningUri,
  hotp, timeStep, generateCode, verifyCode,
  encryptSecret, decryptSecret, enrol, confirmEnrolment,
  recordFailedAttempt, countsAsFailedAttempt, credentialPolicy, normalizeCode,
  CREDENTIAL_STATE, MAX_FAILED_ATTEMPTS,
  TOTP_SECRET_BYTES, TOTP_DIGITS, TOTP_PERIOD_SECONDS
} from '../src/lib/totp.js';

test('base32 round-trips arbitrary bytes', () => {
  for (let i = 0; i < 20; i++) {
    const buf = randomBytes(1 + (i % 33));
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  }
});

test('generateSecret produces the RFC 4226 recommended length', () => {
  const s = generateSecret();
  assert.equal(s.length, TOTP_SECRET_BYTES);
  assert.notDeepEqual(s, generateSecret(), 'two secrets must not collide');
});

test('provisioningUri is a well-formed otpauth URI Microsoft Authenticator can scan', () => {
  const secret = generateSecret();
  const uri = provisioningUri(secret, { accountLabel: 'alice@example.com' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=/);
  assert.match(uri, /issuer=VAtlassian/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});

test('hotp matches the RFC 4226 Appendix D test vectors', () => {
  // The canonical published vectors: 20-byte ASCII secret, counters 0-9.
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489'
  ];
  for (let counter = 0; counter < 10; counter++) {
    assert.equal(hotp(secret, counter), expected[counter], `counter ${counter}`);
  }
});

test('generateCode / verifyCode round-trip at the current time step', () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = generateCode(secret, now);
  const res = verifyCode(code, secret, { now });
  assert.equal(res.valid, true);
  assert.equal(res.matchedStep, timeStep(now));
});

test('verifyCode tolerates one step of clock drift either way', () => {
  const secret = generateSecret();
  const now = Date.now();
  const earlyCode = hotp(secret, timeStep(now) - 1);
  const lateCode = hotp(secret, timeStep(now) + 1);
  assert.equal(verifyCode(earlyCode, secret, { now }).valid, true);
  assert.equal(verifyCode(lateCode, secret, { now }).valid, true);
});

test('verifyCode rejects a code two steps outside the window', () => {
  const secret = generateSecret();
  const now = Date.now();
  const farCode = hotp(secret, timeStep(now) - 2);
  const res = verifyCode(farCode, secret, { now });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'CODE_INVALID_OR_REPLAYED');
});

test('verifyCode rejects malformed input without touching the secret', () => {
  const secret = generateSecret();
  assert.equal(verifyCode('12ab56', secret, {}).reason, 'CODE_FORMAT');
  assert.equal(verifyCode('123', secret, {}).reason, 'CODE_FORMAT');
  assert.equal(verifyCode(null, secret, {}).reason, 'CODE_FORMAT');
});

// Microsoft Authenticator renders "123 456" and its copy button carries the
// space; a mobile keyboard adds trailing whitespace of its own. Before this,
// a correct code pasted that way was rejected AND counted toward the
// three-strike lockout, so three pastes locked a signer out for a
// non-mistake, recoverable only through an admin.
test('a correct code pasted with the space the authenticator displays still verifies', () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = generateCode(secret, now);
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

  assert.equal(verifyCode(spaced, secret, { now }).valid, true);
  assert.equal(verifyCode(`  ${code}\n`, secret, { now }).valid, true);
  assert.equal(normalizeCode(spaced), code);
});

test('a malformed code is not chargeable against the lockout budget, a wrong one is', () => {
  const secret = generateSecret();
  const now = Date.now();

  assert.equal(countsAsFailedAttempt(verifyCode('12ab56', secret, { now })), false);
  assert.equal(countsAsFailedAttempt(verifyCode('123', secret, { now })), false);
  assert.equal(countsAsFailedAttempt(verifyCode(null, secret, { now })), false);

  // A code that is well-formed but wrong is a real attempt and must count.
  const wrong = generateCode(secret, now - 10 * TOTP_PERIOD_SECONDS * 1000);
  assert.equal(countsAsFailedAttempt(verifyCode(wrong, secret, { now })), true);

  // So is a replay of a code that was itself correct.
  const good = generateCode(secret, now);
  const consumed = verifyCode(good, secret, { now }).matchedStep;
  assert.equal(countsAsFailedAttempt(verifyCode(good, secret, { now, lastUsedStep: consumed })), true);

  assert.equal(countsAsFailedAttempt(verifyCode(good, secret, { now })), false, 'a valid code is never an attempt');
});

// A credential stores the digits/period it was enrolled under so a later
// change to this module's defaults can't invalidate authenticators already
// provisioned into people's phones.
test('verifyCode honours a non-default digit count and period', () => {
  const secret = generateSecret();
  const now = Date.now();

  const code8 = hotp(secret, timeStep(now), 8);
  assert.equal(code8.length, 8);
  assert.equal(verifyCode(code8, secret, { now, digits: 8 }).valid, true);
  assert.equal(verifyCode(code8, secret, { now }).reason, 'CODE_FORMAT', 'default digits must not silently accept it');

  const code60 = hotp(secret, timeStep(now, 60));
  assert.equal(verifyCode(code60, secret, { now, period: 60 }).valid, true);
});

test('credentialPolicy coerces the string ints Forge SQL can hand back, and falls back', () => {
  assert.deepEqual(credentialPolicy({ digits: '8', period_seconds: '60' }), { digits: 8, period: 60 });
  assert.deepEqual(credentialPolicy({ digits: 6, period_seconds: 30 }), { digits: 6, period: 30 });
  assert.deepEqual(credentialPolicy({}), { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
  assert.deepEqual(credentialPolicy({ digits: null, period_seconds: 0 }), { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
});

test('verifyCode refuses a replayed step even though the code itself is correct', () => {
  const secret = generateSecret();
  const now = Date.now();
  const step = timeStep(now);
  const code = hotp(secret, step);
  const first = verifyCode(code, secret, { now, lastUsedStep: null });
  assert.equal(first.valid, true);
  const replay = verifyCode(code, secret, { now, lastUsedStep: first.matchedStep });
  assert.equal(replay.valid, false, 'a consumed step must not verify again');
});

test('encryptSecret / decryptSecret round-trips and detects tampering', () => {
  const key = randomBytes(32);
  const secret = generateSecret();
  const enc = encryptSecret(secret, key, 1);
  assert.deepEqual(decryptSecret(enc, key), secret);

  const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  assert.throws(() => decryptSecret(tampered, key), /auth/i);
});

test('enrol + confirmEnrolment: the plaintext secret is only ever returned once', () => {
  const key = randomBytes(32);
  const { secretForQrCodeOnly, stored } = enrol({ key, keyVersion: 1 });
  assert.equal(decryptSecret(stored, key).length, TOTP_SECRET_BYTES);

  const now = Date.now();
  const goodCode = generateCode(secretForQrCodeOnly, now);
  assert.equal(confirmEnrolment(goodCode, secretForQrCodeOnly, { now }).valid, true);
  assert.equal(confirmEnrolment('000000', secretForQrCodeOnly, { now }).valid, false);
});

test('recordFailedAttempt stays in PENDING_CONFIRM below the threshold', () => {
  for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
    const r = recordFailedAttempt(i);
    assert.equal(r.attempts, i + 1);
    assert.equal(r.locked, false);
    assert.equal(r.state, CREDENTIAL_STATE.PENDING_CONFIRM);
  }
});

test('recordFailedAttempt locks exactly at MAX_FAILED_ATTEMPTS, not before or after', () => {
  const justBelow = recordFailedAttempt(MAX_FAILED_ATTEMPTS - 2);
  assert.equal(justBelow.locked, false);

  const atThreshold = recordFailedAttempt(MAX_FAILED_ATTEMPTS - 1);
  assert.equal(atThreshold.attempts, MAX_FAILED_ATTEMPTS);
  assert.equal(atThreshold.locked, true);
  assert.equal(atThreshold.state, CREDENTIAL_STATE.LOCKED);

  // Once locked, further recorded failures (e.g. a race) stay locked rather
  // than un-defining themselves.
  const pastThreshold = recordFailedAttempt(MAX_FAILED_ATTEMPTS);
  assert.equal(pastThreshold.locked, true);
  assert.equal(pastThreshold.state, CREDENTIAL_STATE.LOCKED);
});
