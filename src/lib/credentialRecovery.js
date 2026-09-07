/**
 * CREDENTIAL RECOVERY — who is allowed to replace a second factor, and when.
 *
 * WHAT WAS ACTUALLY WRONG. db/migrations.js has carried va_credential_reset_grant
 * since v011, lib/ledger.js has carried CREDENTIAL_RESET_GRANT_ISSUED and
 * _REDEEMED, and resolvers/admin.js renders both in the ledger view. Nothing
 * ever wrote a row to that table and nothing ever read one. The admin-mediated
 * recovery control was documented in three places and implemented in none.
 *
 * Meanwhile resolvers/totp.js's enrol handler guarded only LOCKED. An ACTIVE
 * credential was deleted and replaced without ceremony, which means anyone
 * holding a live Atlassian session could enrol their OWN authenticator over the
 * signer's and then sign as them. That collapses the two identification
 * components of 21 CFR 11.200(a)(1) into one — the session — and defeats
 * 11.200(a)(3), which requires that using someone else's signature take the
 * collaboration of two or more people. One person with one stolen session was
 * enough.
 *
 * THE RULE THIS FILE ENCODES. A person may enrol themselves freely only while
 * they have no working credential. Once a credential is ACTIVE — or LOCKED,
 * which is the state an attacker would rather be in than out of — replacing it
 * requires a grant that an administrator issued, that has not expired, and that
 * nobody has used yet. The administrator never sees or sets the secret; they
 * issue a permission slip, and the owner redeems it by scanning a QR code only
 * they ever see. That is the collaboration 11.200(a)(3) asks for, and it is
 * also 11.300(c)'s "suitably rigorous controls" for issuing a replacement.
 *
 * ENROLMENT EXPIRES. A PENDING_CONFIRM credential is a secret that has been
 * displayed as a QR code and never proven. Left open forever it is a standing
 * offer: a screenshot in a chat log, a photo of a monitor, a shoulder-surfed
 * screen, redeemable months later by whoever kept it. We cannot un-display a QR
 * code, so the control is the window — the secret is only worth something for
 * ENROLMENT_TTL_MS, and any fresh enrolment rotates it, which kills every
 * earlier copy at once.
 *
 * PURE. Decisions here, I/O in resolvers/totp.js and resolvers/admin.js.
 */
import { CREDENTIAL_STATE } from './totp.js';

/** How long a displayed-but-unproven enrolment stays redeemable.
 *  Long enough to install an authenticator app and scan; short enough that a
 *  leaked screenshot is worthless by the time it is found. */
export const ENROLMENT_TTL_MS = 15 * 60 * 1000;

/** How long an administrator's reset grant stays open. Deliberately longer
 *  than the enrolment window — the admin issues it, then has to tell the person,
 *  who may be on another shift — but still bounded, because an unexpiring
 *  permission slip is just a weaker password. */
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
  // `Number(null)` is 0, not NaN, so an unset enrolled_at would read as the
  // epoch and expire every such row instantly — locking the owner out of their
  // own setup with no way back. Absence must mean "unknown, do not expire",
  // the same stance supersede() takes on a NULL baseline_status_id.
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

  // ACTIVE and LOCKED are treated identically on purpose. It is tempting to be
  // lenient with ACTIVE — the person is "just re-enrolling" — but ACTIVE is
  // precisely the case where a working second factor exists and replacing it
  // silently hands someone else the ability to sign.
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
      : 'You already have an authenticator set up. Replacing it needs an administrator to issue a reset first — this protects your signature from being re-registered by someone else.'
  };
}

/** Expiry for a grant issued now. */
export function grantExpiry(now = Date.now()) {
  return now + GRANT_TTL_MS;
}
