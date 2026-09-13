import crypto from 'crypto';

export const WEBAUTHN_PURPOSE = Object.freeze({ ENROL: 'ENROL', ASSERT: 'ASSERT' });
export const WEBAUTHN_CHALLENGE_TTL_MS = 90 * 1000;
export const WEBAUTHN_RP_NAME = 'VAtlassian';
export const WEBAUTHN_CREDENTIAL_KIND = Object.freeze({ DEVICE_BOUND: 'device', SYNCED: 'synced' });
export const WEBAUTHN_ASSERTION_ASSURANCE = Object.freeze({
  DEVICE_BOUND_UV: 'DEVICE_BOUND_UV',
  SYNCED_UV: 'SYNCED_UV',
  PRESENCE_ONLY: 'PRESENCE_ONLY'
});

export const WEBAUTHN_FAIL = Object.freeze({
  NOT_ENROLLED: 'WEBAUTHN_NOT_ENROLLED',
  RP_CHANGED: 'WEBAUTHN_RP_CHANGED',
  UNKNOWN_CREDENTIAL: 'WEBAUTHN_UNKNOWN_CREDENTIAL',
  CHALLENGE_EXPIRED: 'WEBAUTHN_CHALLENGE_EXPIRED',
  CHALLENGE_SPENT: 'WEBAUTHN_CHALLENGE_SPENT',
  BINDING_MISMATCH: 'WEBAUTHN_BINDING_MISMATCH',
  NO_USER_VERIFICATION: 'WEBAUTHN_NO_USER_VERIFICATION',
  BAD_SIGNATURE: 'WEBAUTHN_BAD_SIGNATURE',
  COUNTER_REGRESSION: 'WEBAUTHN_COUNTER_REGRESSION',
  ORIGIN_REFUSED: 'WEBAUTHN_ORIGIN_REFUSED',
  CREDENTIAL_UNREACHABLE: 'WEBAUTHN_CREDENTIAL_UNREACHABLE',
  UNAVAILABLE: 'WEBAUTHN_UNAVAILABLE'
});

export const WEBAUTHN_FAIL_MESSAGE = Object.freeze({
  [WEBAUTHN_FAIL.NOT_ENROLLED]: 'Set up biometric approval on this device before signing.',
  [WEBAUTHN_FAIL.RP_CHANGED]: 'This device was set up for a different VAtlassian installation. Set it up again here.',
  [WEBAUTHN_FAIL.UNKNOWN_CREDENTIAL]: 'This device offered a biometric credential this app does not recognise. Set it up again.',
  [WEBAUTHN_FAIL.CHALLENGE_EXPIRED]: 'The biometric check took too long and expired. Try again.',
  [WEBAUTHN_FAIL.CHALLENGE_SPENT]: 'That biometric check was already used. Start the approval again.',
  [WEBAUTHN_FAIL.BINDING_MISMATCH]: 'This biometric check was collected for a different approval. Start again from this work item.',
  [WEBAUTHN_FAIL.NO_USER_VERIFICATION]: 'Your device confirmed presence but did not verify the user. Enable Face ID, Touch ID, Windows Hello, or a device PIN and try again.',
  [WEBAUTHN_FAIL.BAD_SIGNATURE]: 'The biometric check could not be verified. Nothing was recorded.',
  [WEBAUTHN_FAIL.COUNTER_REGRESSION]: 'This credential reported a lower signature counter than before, so the approval was refused.',
  [WEBAUTHN_FAIL.ORIGIN_REFUSED]: 'This app is being served from an address that cannot be used for biometric approval.',
  [WEBAUTHN_FAIL.CREDENTIAL_UNREACHABLE]: 'The device check did not complete. Either it was cancelled, or this browser cannot reach the registration for your account.',
  [WEBAUTHN_FAIL.UNAVAILABLE]: 'Biometric approval is not available in this browser or on this device.'
});

const ALLOWED_ORIGIN_SUFFIXES = ['.atlassian-dev.net', '.atlassian.net', '.atlassian.com'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
const DEVELOPMENT_MARKERS = new Set(['DEVELOPMENT', 'DEV']);

export function environmentIsDevelopment(context = {}) {
  const candidates = [
    context.environmentType,
    context.environment?.type,
    context.installContext?.environmentType,
    process.env.FORGE_ENVIRONMENT_TYPE,
    process.env.FORGE_ENV_TYPE,
    process.env.FORGE_ENVIRONMENT
  ];
  return candidates.some(value => value != null && DEVELOPMENT_MARKERS.has(String(value).trim().toUpperCase()));
}

export function originAllowed(origin, isDevelopment = false) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (isDevelopment && LOOPBACK_HOSTS.includes(url.hostname)) return ['http:', 'https:'].includes(url.protocol);
  if (url.protocol !== 'https:') return false;
  return ALLOWED_ORIGIN_SUFFIXES.some(suffix => url.hostname.endsWith(suffix));
}

export function deriveRpId(origin) {
  if (!origin) return null;
  try { return new URL(origin).hostname || null; }
  catch { return /^[a-z0-9.-]+$/i.test(origin) ? origin : null; }
}

export function rpChanged(credential, currentRpId) {
  if (!credential?.rp_id || !currentRpId) return false;
  return credential.rp_id !== currentRpId;
}

export function credentialKindOf(credential) {
  return credential?.backup_state ? WEBAUTHN_CREDENTIAL_KIND.SYNCED : WEBAUTHN_CREDENTIAL_KIND.DEVICE_BOUND;
}

export function webauthnBindingHash({ accountId, issueId, decision, contentHash }) {
  const parts = [
    `account=${accountId ?? ''}`,
    `issue=${issueId ?? ''}`,
    `decision=${decision ?? ''}`,
    `content=${contentHash ?? ''}`
  ];
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

export function bindingMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') return false;
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(presented, 'utf8'));
}

export function challengeUsable(row, now) {
  if (!row) return { ok: false, reason: WEBAUTHN_FAIL.CHALLENGE_EXPIRED };
  if (row.consumed_at != null) return { ok: false, reason: WEBAUTHN_FAIL.CHALLENGE_SPENT };
  if (Number(row.expires_at) <= now) return { ok: false, reason: WEBAUTHN_FAIL.CHALLENGE_EXPIRED };
  return { ok: true };
}

export function assertionAssuranceOf({ userVerified, backupState }) {
  if (!userVerified) return WEBAUTHN_ASSERTION_ASSURANCE.PRESENCE_ONLY;
  return backupState ? WEBAUTHN_ASSERTION_ASSURANCE.SYNCED_UV : WEBAUTHN_ASSERTION_ASSURANCE.DEVICE_BOUND_UV;
}

export function counterRegressed(storedCount, presentedCount) {
  const stored = Number(storedCount ?? 0);
  const presented = Number(presentedCount ?? 0);
  if (stored === 0 || presented === 0) return false;
  return presented <= stored;
}

export function acceptWebAuthnAssertion({
  verified,
  userVerified,
  userPresent,
  backupState = false,
  storedCount,
  presentedCount,
  expectedBinding,
  presentedBinding
}) {
  if (!verified || !userPresent) return { ok: false, reason: WEBAUTHN_FAIL.BAD_SIGNATURE };
  if (!bindingMatches(expectedBinding, presentedBinding)) return { ok: false, reason: WEBAUTHN_FAIL.BINDING_MISMATCH };
  if (!userVerified) return { ok: false, reason: WEBAUTHN_FAIL.NO_USER_VERIFICATION };
  if (counterRegressed(storedCount, presentedCount)) return { ok: false, reason: WEBAUTHN_FAIL.COUNTER_REGRESSION };
  return { ok: true, assertionAssurance: assertionAssuranceOf({ userVerified, backupState }) };
}
