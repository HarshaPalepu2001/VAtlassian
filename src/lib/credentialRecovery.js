/**
 * Decide who may replace a second factor and when.
 *
 * The recovery table va_credential_reset_grant and ledger events existed since
 * v011 but had no readers or writers. The enrol handler guarded only LOCKED,
 * so a live Atlassian session could replace an ACTIVE credential and sign with
 * a new authenticator. That bypassed the second identification component and
 * the administrator's role in replacement under 21 CFR 11.200(a)(1),
 * 11.200(a)(3) and 11.300(c).
 *
 * An owner may enrol without a grant only while they have no working
 * credential. Replacing ACTIVE or LOCKED credentials requires an unused,
 * unexpired administrator-issued grant. The administrator authorizes the
 * replacement without seeing or setting the secret; the owner scans the QR code.
 *
 * A PENDING_CONFIRM secret expires after ENROLMENT_TTL_MS. A QR code may have
 * been copied before confirmation, so it must not remain usable indefinitely.
 * Starting a fresh enrolment rotates the secret and invalidates earlier copies.
 *
 * This module contains pure decisions. resolvers/totp.js and resolvers/admin.js
 * perform the I/O.
 */
import { CREDENTIAL_STATE } from './totp.js';

/** How long a displayed-but-unproven enrolment stays redeemable.
 *  Long enough to install an authenticator app and scan; short enough that a
 *  leaked screenshot is worthless by the time it is found. */
export const ENROLMENT_TTL_MS = 15 * 60 * 1000;

/**
 * Lifetime of an administrator-issued reset grant. Allow more time than the
 * enrolment window so the owner can redeem it on a later shift, but still
 * require expiry for unused grants.
 */
export const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export const ENROL_DECISION = {
  /** No credential at all. First-time setup; nothing to protect yet. */
  FIRST_TIME: 'FIRST_TIME',
  /** A PENDING_CONFIRM that is still inside its window. Re-issuing rotates the
   *  secret, which is strictly safer than leaving the old one live. */
  RESTART_PENDING: 'RESTART_PENDING',
  /** A PENDING_CONFIRM that timed out. Same as above, and the expiry is why. */
  RESTART_EXPIRED: 'RESTART_EXPIRED',
  /** ACTIVE or LOCKED, and the owner holds a usable grant. Redeem it. */
  REDEEM_GRANT: 'REDEEM_GRANT',
  /** ACTIVE or LOCKED with no usable grant. This is the refusal that closes
   *  the hole. */
  NEEDS_GRANT: 'NEEDS_GRANT'
};

/** Has a displayed enrolment gone stale? */
export function enrolmentExpired(credential, now = Date.now()) {
  if (!credential) return false;
  if (credential.state !== CREDENTIAL_STATE.PENDING_CONFIRM) return false;
  // Number(null) is 0, so an unset enrolled_at would look like epoch time and
  // expire a new setup. Treat absence as unknown and leave it unexpired.
  if (credential.enrolled_at == null) return false;
  const enrolledAt = Number(credential.enrolled_at);
  if (!Number.isFinite(enrolledAt)) return false;
  return now - enrolledAt > ENROLMENT_TTL_MS;
}

/** Is this grant one the owner may still redeem? */
export function grantUsable(grant, now = Date.now()) {
  if (!grant) return false;
  if (grant.redeemed_at != null) return false;
  return Number(grant.expires_at) > now;
}

/**
 * May this person enrol a new authenticator right now?
 *
 * `grant` is the newest unredeemed grant for the account, or null. Returns the
 * decision and whether redeeming consumes the grant, so the caller knows to
 * mark it used in the same breath as writing the credential.
 */
export function enrolmentDecision({ credential, grant, now = Date.now() }) {
  if (!credential) {
    return { allow: true, decision: ENROL_DECISION.FIRST_TIME, consumesGrant: false };
  }

  const { state } = credential;

  if (state === CREDENTIAL_STATE.PENDING_CONFIRM) {
    // Never proven, so there is nothing here worth protecting from its own
    // owner. Restarting rotates the secret and invalidates any copy of the
    // previous QR code, which is the outcome we want either way.
    return {
      allow: true,
      decision: enrolmentExpired(credential, now)
        ? ENROL_DECISION.RESTART_EXPIRED
        : ENROL_DECISION.RESTART_PENDING,
      consumesGrant: false
    };
  }

  // Both ACTIVE and LOCKED require recovery authorization. Replacing an ACTIVE
  // credential also replaces a working second factor and cannot be self-authorized.
  if (grantUsable(grant, now)) {
    return { allow: true, decision: ENROL_DECISION.REDEEM_GRANT, consumesGrant: true };
  }

  return {
    allow: false,
    decision: ENROL_DECISION.NEEDS_GRANT,
    consumesGrant: false,
    // Wording differs because the two states send the person to the admin for
    // different reasons, and "ask an administrator" with no cause is the kind
    // of message that generates a ticket instead of resolving one.
    error: state === CREDENTIAL_STATE.LOCKED
      ? 'Your authenticator is locked after too many incorrect codes. Ask an administrator to issue a reset before setting it up again.'
      : 'You already have an authenticator set up. Replacing it needs an administrator to issue a reset first. This prevents someone else from re-registering your signature.'
  };
}

/** Expiry for a grant issued now. */
export function grantExpiry(now = Date.now()) {
  return now + GRANT_TTL_MS;
}
