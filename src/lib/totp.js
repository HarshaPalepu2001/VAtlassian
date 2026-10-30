import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'crypto';

/**
 * Implement TOTP RFC 6238 over HOTP RFC 4226 as the second identification
 * component, replacing lib/pin.js. Authenticator apps compute six-digit codes
 * locally from a shared secret and a 30-second time step. Forge verifies them
 * locally too, without external identity-provider calls.
 *
 * This uses standard QR/manual-key TOTP enrolment rather than Entra ID push
 * or PingID. See BUILD-PLAN.md's authentication-factor tradeoff.
 *
 * Verification needs the original secret to recompute HMAC codes. Encrypt it
 * with AES-256-GCM instead of hashing it as a PIN. Load the encryption key
 * from Forge's encrypted app storage using forge variables set --encrypt.
 * Never derive that key in this file or send it outside the app environment.
 */

export const TOTP_ALGO = 'TOTP-SHA1';   // SHA1 is what Microsoft/Google/Authy authenticator apps expect; RFC 6238 default.
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20;    // 160 bits, the RFC 4226 recommended minimum
export const TOTP_WINDOW = 1;           // accept the code one step early/late (clock drift)
export const MAX_FAILED_ATTEMPTS = 3;   // same lockout policy as the PIN it replaces

/** va_credential.state values (db/migrations.js v003_credential). */
export const CREDENTIAL_STATE = {
  PENDING_CONFIRM: 'PENDING_CONFIRM', // secret generated, not yet proven by a real code
  ACTIVE: 'ACTIVE',                   // confirmed, usable to sign
  LOCKED: 'LOCKED'                    // MAX_FAILED_ATTEMPTS wrong codes; admin-mediated recovery only
};

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding for authenticator QR codes. */
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new TypeError('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh, random shared secret. Never logged, never stored in plaintext. */
export function generateSecret() {
  return randomBytes(TOTP_SECRET_BYTES);
}

/**
 * The otpauth:// URI encoded into the enrolment QR code. `accountLabel`
 * should be the user's Jira email or display name; `issuer` identifies this
 * app in the authenticator's account list so it is distinguishable from the
 * customer's other Microsoft/Google accounts.
 */
export function provisioningUri(secret, { accountLabel, issuer = 'VAtlassian' }) {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** RFC 4226 HOTP over an explicit counter (the TOTP time-step). */
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

export function timeStep(now, period = TOTP_PERIOD_SECONDS) {
  return Math.floor(now / 1000 / period);
}

export function generateCode(secret, now = Date.now(), period = TOTP_PERIOD_SECONDS) {
  return hotp(secret, timeStep(now, period));
}

/**
 * Distinguish format errors from incorrect codes. CODE_FORMAT never compares
 * against the secret and must not count toward MAX_FAILED_ATTEMPTS.
 * See countsAsFailedAttempt.
 */
export const VERIFY_REASON = {
  CODE_FORMAT: 'CODE_FORMAT',
  CODE_INVALID_OR_REPLAYED: 'CODE_INVALID_OR_REPLAYED'
};

/**
 * Strip whitespace from copied authenticator codes such as "123 456".
 * Apply the same cleanup for every caller so a valid pasted code is not
 * counted as incorrect. gate.js rawCodeSubmitted also trims.
 */
export function normalizeCode(code) {
  return typeof code === 'string' ? code.replace(/\s+/g, '') : code;
}

/**
 * Count wrong and replayed codes toward lockout. Do not count malformed
 * input, which never reached secret verification. Recovery requires an
 * administrator's grant; there is no self-service unlock.
 */
export function countsAsFailedAttempt(verification) {
  return !verification.valid && verification.reason !== VERIFY_REASON.CODE_FORMAT;
}

/**
 * Verify within a time-step window to tolerate clock drift. Use the digits
 * and period stored with the credential so changed defaults do not invalidate
 * existing enrolments.
 *
 * Return the matched step. Callers must reject last_used_step >= matchedStep
 * to prevent replay during the code's validity window.
 */
export function verifyCode(code, secret, { now = Date.now(), period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS, window = TOTP_WINDOW, lastUsedStep = null } = {}) {
  const normalized = normalizeCode(code);
  if (typeof normalized !== 'string' || !new RegExp(`^[0-9]{${digits}}$`).test(normalized)) {
    return { valid: false, reason: VERIFY_REASON.CODE_FORMAT };
  }
  const current = timeStep(now, period);
  for (let delta = -window; delta <= window; delta++) {
    const step = current + delta;
    if (lastUsedStep != null && step <= lastUsedStep) continue; // replay: already consumed this or an earlier step
    const candidate = hotp(secret, step, digits);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) {
      return { valid: true, matchedStep: step };
    }
  }
  return { valid: false, reason: VERIFY_REASON.CODE_INVALID_OR_REPLAYED };
}

/**
 * Read a credential's enrolled digits and period, falling back to module
 * defaults for older rows. Coerce Forge SQL numeric strings to numbers before
 * using them in HOTP calculations.
 */
export function credentialPolicy(row = {}) {
  const digits = Number(row.digits);
  const period = Number(row.period_seconds);
  return {
    digits: Number.isInteger(digits) && digits > 0 ? digits : TOTP_DIGITS,
    period: Number.isInteger(period) && period > 0 ? period : TOTP_PERIOD_SECONDS
  };
}

// Encrypt secrets with AES-256-GCM using the app-level secret provisioned
// by forge variables set --encrypt TOTP_ENC_KEY_V1. Read it from process.env;
// never hard-code it or derive it from Forge SQL data. Store keyVersion with
// the ciphertext to support rotation and decryption of older rows.

export function encryptSecret(secret, key, keyVersion) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag, keyVersion };
}

export function decryptSecret({ ciphertext, iv, tag }, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Return the plaintext secret once for QR display and its encrypted form
 * for storage. Never persist or log plaintext. Keep it only in memory for
 * that response. Start in PENDING_CONFIRM and activate only after a valid
 * confirmation code proves the enrolment succeeded.
 */
export function enrol({ key, keyVersion }) {
  const secret = generateSecret();
  const { ciphertext, iv, tag } = encryptSecret(secret, key, keyVersion);
  return {
    secretForQrCodeOnly: secret,
    stored: { ciphertext, iv, tag, keyVersion, algo: TOTP_ALGO, digits: TOTP_DIGITS, period_seconds: TOTP_PERIOD_SECONDS }
  };
}

/**
 * Second step of enrolment: the user must submit one real code from their
 * authenticator app before the credential is trusted. Proves the QR was
 * actually scanned into Microsoft Authenticator (or equivalent) and the two
 * clocks agree closely enough to be usable.
 */
export function confirmEnrolment(code, secret, { now = Date.now(), digits = TOTP_DIGITS, period = TOTP_PERIOD_SECONDS } = {}) {
  return verifyCode(code, secret, { now, digits, period, window: TOTP_WINDOW, lastUsedStep: null });
}

/**
 * Compute attempt and lockout state after an incorrect confirmation code.
 * Keep the policy pure for tests outside Forge SQL.
 *
 * LOCKED recovery requires an administrator's time-limited reset grant,
 * redeemed by the owner. See migration v011_credential_reset_grant.
 * There is no self-service unlock.
 */
export function recordFailedAttempt(currentFailedAttempts, maxAttempts = MAX_FAILED_ATTEMPTS) {
  const attempts = currentFailedAttempts + 1;
  const locked = attempts >= maxAttempts;
  return { attempts, locked, state: locked ? CREDENTIAL_STATE.LOCKED : CREDENTIAL_STATE.PENDING_CONFIRM };
}
