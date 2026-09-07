import { decryptSecret, verifyCode, countsAsFailedAttempt, recordFailedAttempt, CREDENTIAL_STATE } from '../totp.js';
import { enrolmentExpired } from '../credentialRecovery.js';

/** Shared confirmation/signing/device proof. No raw secret or code escapes. */
export async function verifyTotp(accountId, code, options = {}, suppliedDeps) {
  if (!accountId) return { ok: false, reason: 'NOT_ELIGIBLE', error: 'Sign in to use your authenticator.' };
  const deps = suppliedDeps ?? await (await import('./totpRuntime.js')).totpRuntime();
  const now = deps.now();
  const row = await deps.read(accountId);
  const expectedState = options.confirm ? CREDENTIAL_STATE.PENDING_CONFIRM : CREDENTIAL_STATE.ACTIVE;
  const refuse = (reason, error) => ({ ok: false, reason, error });
  if (row?.state === CREDENTIAL_STATE.LOCKED) return refuse('CREDENTIAL_LOCKED', 'Your authenticator is locked. Ask an administrator to reset it.');
  if (!row || row.state !== expectedState) return refuse('CREDENTIAL_REQUIRED', 'Complete authenticator setup before signing.');
  if (options.confirm && enrolmentExpired(row, now)) return refuse('ENROLMENT_EXPIRED', 'This setup expired. Start authenticator setup again.');
  // Invalid persisted policy is configuration corruption, never a fallback to weaker defaults.
  const digits = Number(row.digits), period = Number(row.period_seconds), version = Number(row.key_version);
  if (row.algo !== 'TOTP-SHA1' || ![6, 8].includes(digits) || !Number.isInteger(period) || period < 15 || period > 120
      || !Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(Number(row.version))) {
    return refuse('NOT_CONFIGURED', 'Authenticator policy is invalid. Contact your administrator.');
  }
  const secret = decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, deps.key(version));
  let verification;
  try { verification = verifyCode(code, secret, { now, digits, period, lastUsedStep: row.last_used_step }); }
  finally { secret.fill(0); }
  if (!verification.valid) {
    if (!countsAsFailedAttempt(verification)) return refuse('CODE_FORMAT', `Enter the ${digits}-digit authenticator code.`);
    const failure = recordFailedAttempt(Number(row.failed_attempts));
    if (!await deps.fail(accountId, row, failure, now)) return refuse('CREDENTIAL_RACE', 'Credential changed. Please try again.');
    await deps.audit({ eventType: 'TOTP_ATTEMPT_FAILED', actorAccountId: accountId, issueId: options.issueId, payload: { attempt: failure.attempts, purpose: options.purpose ?? 'CONFIRM' } });
    if (failure.locked) {
      await deps.audit({ eventType: 'TOTP_LOCKED_OUT', actorAccountId: accountId, payload: { failedAttempts: failure.attempts } });
      await deps.alert({ accountId, failedAttempts: failure.attempts, occurredAt: now });
    }
    return refuse(failure.locked ? 'CREDENTIAL_LOCKED' : 'CODE_INVALID_OR_REPLAYED', failure.locked ? 'Your authenticator is locked. Ask an administrator to reset it.' : 'Invalid or already used code. Wait for the next code.');
  }
  if (!await deps.consume(accountId, row, verification.matchedStep, now)) return refuse('CREDENTIAL_RACE', 'That code was already used or your credential changed. Wait for the next code.');
  if (options.confirm) {
    await deps.audit({ eventType: 'TOTP_CONFIRMED', actorAccountId: accountId, payload: {} });
    if (!await deps.activate(accountId, row, now)) return refuse('CREDENTIAL_RACE', 'Credential changed during confirmation. Please try again.');
  }
  return { ok: true, verifiedAt: now };
}
