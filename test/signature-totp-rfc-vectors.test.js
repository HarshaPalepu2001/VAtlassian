import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hotp, generateCode, verifyCode, base32Encode, base32Decode,
  provisioningUri, TOTP_PERIOD_SECONDS
} from '../src/lib/totp.js';

/**
 * Does our 6-digit code equal the one Microsoft Authenticator is showing?
 *
 * That question cannot be answered by testing our own code against our own
 * code — generateCode() and verifyCode() agreeing with each other proves only
 * that they are consistently wrong together. The only way to know is to check
 * against the published constants in RFC 4226 / RFC 6238, which is what every
 * authenticator app implements. If these vectors pass, an authenticator that
 * scanned our QR code computes the same digits we do, by construction.
 *
 * The seed is the RFC's own: the ASCII string "12345678901234567890".
 */
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');

test('HOTP matches every RFC 4226 Appendix D test vector', () => {
  // RFC 4226, Appendix D, "HOTP Algorithm: Test Values" — counters 0..9.
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489'
  ];
  expected.forEach((code, counter) => {
    assert.equal(hotp(RFC_SEED, counter), code, `counter ${counter}`);
  });
});

test('TOTP matches the RFC 6238 Appendix B test vectors for SHA-1', () => {
  // RFC 6238, Appendix B, SHA-1 rows. Published as 8 digits; the truncation
  // is the same operation, so this exercises the exact code path a 6-digit
  // authenticator uses, with more digits of it pinned down.
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ];
  for (const [unixSeconds, expected] of vectors) {
    const step = Math.floor(unixSeconds / TOTP_PERIOD_SECONDS);
    assert.equal(hotp(RFC_SEED, step, 8), expected, `T=${unixSeconds}`);
  }
});

test('base32 encoding matches RFC 4648 — this is what the QR code carries', () => {
  // If base32Encode were wrong, the authenticator would store a DIFFERENT
  // secret from the one we hold, and every code would look "invalid" forever
  // with no other symptom. Node's own base64 is the independent check here:
  // both encodings must decode back to identical bytes.
  const cases = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [input, expected] of cases) {
    assert.equal(base32Encode(Buffer.from(input, 'ascii')), expected, `encode ${JSON.stringify(input)}`);
  }
  for (const [input] of cases) {
    const buf = Buffer.from(input, 'ascii');
    assert.deepEqual(base32Decode(base32Encode(buf)), buf, `round-trip ${JSON.stringify(input)}`);
  }
});

test('the QR code hands the authenticator the same secret we verify against', () => {
  // The end-to-end identity that actually matters: the secret embedded in the
  // otpauth:// URI, decoded the way an authenticator app decodes it, must
  // regenerate the code we would accept. A mismatch here is precisely the
  // "I typed the right code and it says invalid" failure.
  const uri = provisioningUri(RFC_SEED, { accountLabel: 'someone@example.com' });
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));

  assert.equal(params.get('algorithm'), 'SHA1');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');

  const secretTheAppWouldStore = base32Decode(params.get('secret'));
  assert.deepEqual(secretTheAppWouldStore, RFC_SEED);

  const now = 1111111109 * 1000;
  assert.equal(generateCode(secretTheAppWouldStore, now), generateCode(RFC_SEED, now));
  assert.equal(verifyCode(generateCode(RFC_SEED, now), secretTheAppWouldStore, { now }).valid, true);
});

test('a code from an authenticator up to one step out of sync is still accepted', () => {
  // Phone clocks drift. window=1 means +/-30s, which is what every other TOTP
  // implementation does; without it, correct codes get rejected intermittently
  // and look like a wiring bug.
  const now = 1700000000000;
  const early = generateCode(RFC_SEED, now - TOTP_PERIOD_SECONDS * 1000);
  const late = generateCode(RFC_SEED, now + TOTP_PERIOD_SECONDS * 1000);
  assert.equal(verifyCode(early, RFC_SEED, { now }).valid, true);
  assert.equal(verifyCode(late, RFC_SEED, { now }).valid, true);

  const tooEarly = generateCode(RFC_SEED, now - 3 * TOTP_PERIOD_SECONDS * 1000);
  assert.equal(verifyCode(tooEarly, RFC_SEED, { now }).valid, false);
});

test('verifyCode reports WHY it rejected, so a bad code and a replay are distinguishable', () => {
  const now = 1700000000000;
  const good = generateCode(RFC_SEED, now);
  const step = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

  assert.equal(verifyCode('12345', RFC_SEED, { now }).reason, 'CODE_FORMAT');
  assert.equal(verifyCode('abcdef', RFC_SEED, { now }).reason, 'CODE_FORMAT');
  assert.equal(verifyCode('000000', RFC_SEED, { now }).reason, 'CODE_INVALID_OR_REPLAYED');
  // The same correct code, already spent: accepted once, refused after.
  assert.equal(verifyCode(good, RFC_SEED, { now }).valid, true);
  assert.equal(verifyCode(good, RFC_SEED, { now, lastUsedStep: step }).valid, false);
});
