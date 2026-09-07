import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'crypto';

/**
 * TOTP (RFC 6238, over HOTP RFC 4226) — replaces the PIN as the second
 * identification component. Supersedes lib/pin.js.
 *
 * WHY THIS KEEPS ZERO EGRESS: Microsoft Authenticator (and Google
 * Authenticator, Authy, 1Password, etc.) all implement the same open
 * standard. When an account is added via "Other account (Google, Microsoft,
 * etc.)" using a QR code / manual key, the app never talks to Microsoft's
 * servers again — the 6-digit code is a local HMAC over the shared secret and
 * the current 30-second time step, computed entirely on-device. We verify the
 * same way, entirely inside this Forge function. No remotes, no external
 * call, no forfeiting Runs on Atlassian.
 *
 * THIS IS NOT the same thing as Microsoft Entra ID push approval or PingID —
 * those require calling Microsoft's / Ping's identity servers at sign-in
 * time, which is egress. See BUILD-PLAN.md "Authentication factor" section
 * for that tradeoff; this module deliberately implements the egress-free
 * option.
 *
 * ONE THING THIS MODULE CANNOT DO THAT pin.js DID NOT NEED TO: a PIN is only
 * ever hashed (one-way, PBKDF2) because verification just re-hashes the
 * guess. A TOTP secret must be reversible — verification recomputes HMAC
 * codes FROM the secret — so it is symmetrically ENCRYPTED (AES-256-GCM), not
 * hashed. The encryption key must come from Forge's encrypted app storage
 * (`forge variables set --encrypt`), never from a value computed in this
 * file. That key never leaves the app's own execution environment either, so
 * this still does not introduce egress.
 */

export const TOTP_ALGO = 'TOTP-SHA1';   // SHA1 is what Microsoft/Google/Authy authenticator apps expect; RFC 6238 default.
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20;    // 160 bits — RFC 4226 recommended minimum
export const TOTP_WINDOW = 1;           // accept the code one step early/late (clock drift)
export const MAX_FAILED_ATTEMPTS = 3;   // same lockout policy as the PIN it replaces

/** va_credential.state values (db/migrations.js v003_credential). */
export const CREDENTIAL_STATE = {
  PENDING_CONFIRM: 'PENDING_CONFIRM', // secret generated, not yet proven by a real code
  ACTIVE: 'ACTIVE',                   // confirmed, usable to sign
  LOCKED: 'LOCKED'                    // MAX_FAILED_ATTEMPTS wrong codes; admin-mediated recovery only
};

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the form every authenticator app's QR scanner expects. */
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
 * Why a verification failed. The distinction is load-bearing, not cosmetic:
 * CODE_FORMAT means nothing was ever compared against the secret, so it must
 * NOT count toward MAX_FAILED_ATTEMPTS — see countsAsFailedAttempt.
 */
export const VERIFY_REASON = {
  CODE_FORMAT: 'CODE_FORMAT',
  CODE_INVALID_OR_REPLAYED: 'CODE_INVALID_OR_REPLAYED'
};

/**
 * Authenticator apps render codes with a separating space for legibility
 * ("123 456"), and both Microsoft Authenticator's copy button and an ordinary
 * select-and-copy carry that space — plus whatever leading/trailing
 * whitespace a mobile keyboard adds — into the field the signer pastes into.
 * Stripping it here, in the one place every caller goes through, is the
 * difference between a signer's correct code being accepted and it being
 * counted as a wrong guess. gate.js's rawCodeSubmitted() already trims for
 * the same reason.
 */
export function normalizeCode(code) {
  return typeof code === 'string' ? code.replace(/\s+/g, '') : code;
}

/**
 * Whether a rejected verification should be held against the account's
 * lockout budget. A wrong or replayed code is a real failed attempt. A
 * malformed one is a typing/paste accident that never touched the secret —
 * counting it means three bad pastes lock a signer out of signing entirely,
 * with admin-mediated recovery the only way back (there is deliberately no
 * self-service unlock), which is a denial of service dressed up as a control.
 */
export function countsAsFailedAttempt(verification) {
  return !verification.valid && verification.reason !== VERIFY_REASON.CODE_FORMAT;
}

/**
 * Verify a code against a window of time steps to tolerate clock drift.
 *
 * `digits` and `period` are parameters rather than constants because the
 * va_credential row stores its own — a credential enrolled under one policy
 * must keep verifying under that policy even if the app's defaults change,
 * otherwise a settings change silently invalidates every existing
 * authenticator.
 *
 * REPLAY GUARD: returns the matched step so the caller can enforce
 * last_used_step >= matchedStep as a rejection — otherwise the same 6-digit
 * code could be replayed for its entire ~30-90s validity window. This is the
 * TOTP analogue of the PIN's constant-time compare; both exist because a
 * short, low-entropy code is only as strong as everything wrapped around it.
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
 * Read the digits/period a stored credential was enrolled under, falling back
 * to this module's defaults for rows written before those columns carried
 * anything meaningful. Forge SQL's JSON wire protocol can hand an INT column
 * back as a string, so both are coerced rather than trusted — a string
 * `"6"` interpolated into verifyCode's `{digits}` regex quantifier still
 * works by luck, but `hotp`'s `10 ** digits` would not.
 */
export function credentialPolicy(row = {}) {
  const digits = Number(row.digits);
  const period = Number(row.period_seconds);
  return {
    digits: Number.isInteger(digits) && digits > 0 ? digits : TOTP_DIGITS,
    period: Number.isInteger(period) && period > 0 ? period : TOTP_PERIOD_SECONDS
  };
}

// --- Secret-at-rest encryption -------------------------------------------
// AES-256-GCM. The key is an app-level secret provisioned via
// `forge variables set --encrypt TOTP_ENC_KEY_V1` (Atlassian-managed
// encryption at rest for Forge app variables — GA, zero egress) and read in
// the resolver via `process.env`, never hard-coded and never derived from
// anything stored in Forge SQL. `keyVersion` is stored alongside the
// ciphertext so a future key rotation can decrypt old rows before
// re-encrypting them; it is not itself a secret.

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
 * Begin enrolment. Returns the secret ONCE, for QR display, plus the
 * encrypted form to store. The plaintext secret must never be persisted or
 * logged — only ever held in memory for the single response that renders the
 * QR code, exactly as a PIN was only ever handled in memory in pin.js.
 *
 * State starts PENDING_CONFIRM, not ACTIVE: see confirmEnrolment. Activating
 * on enrolment alone would let a typo'd or half-scanned secret silently lock
 * the user out at the first real signature.
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
 * Pure decision for what a WRONG confirmation code does to attempt/lockout
 * state — deliberately factored out of resolvers/totp.js so the lockout
 * policy is unit-testable without Forge SQL, the same way every other
 * decision in this codebase (lib/interception.js's `observe`, lib/signatures.js's
 * `evaluate`) is pure and the resolver around it is thin I/O glue.
 *
 * Recovery from LOCKED is deliberately NOT exposed here — see
 * db/migrations.js v011_credential_reset_grant: an admin issues a time-boxed
 * grant, the owner redeems it themselves. There is no self-service unlock.
 */
export function recordFailedAttempt(currentFailedAttempts, maxAttempts = MAX_FAILED_ATTEMPTS) {
  const attempts = currentFailedAttempts + 1;
  const locked = attempts >= maxAttempts;
  return { attempts, locked, state: locked ? CREDENTIAL_STATE.LOCKED : CREDENTIAL_STATE.PENDING_CONFIRM };
}
