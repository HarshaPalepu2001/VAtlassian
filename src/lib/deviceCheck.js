/**
 * Authenticator testing policy for 21 CFR 11.300(e).
 *
 * "Initial and periodic testing of devices, such as tokens or cards, that bear
 * or generate identification code or password information, to ensure that they
 * function properly and have not been altered in an unauthorized manner."
 *
 * A correct TOTP code proves possession of the shared secret and a clock within
 * the accepted window. Enrolment confirmation records the initial test; each
 * later signature records another test. Requiring a separate test before
 * signing would ask for the same code twice.
 *
 * After DEVICE_CHECK_INTERVAL_MS without a successful code, the owner is asked
 * to attest that the authenticator still works. This can reveal a replaced
 * phone or deleted app. A copied secret can still generate a valid code;
 * this check cannot detect that copy and does not block signatures. If a dormant credential is used, its audit
 * entry also records how long it was inactive; that does not identify whether
 * the user was the owner or an attacker.
 *
 * This module contains pure policy functions. Resolvers and
 * jobs/devicecheck.js perform the I/O.
 */
import { CREDENTIAL_STATE } from './totp.js';

/** How long a credential may go unproven before its owner is asked to attest.
 *  Ninety days matches the cadence the manifest has described since 2026-08-18
 *  and is the common interpretation of "periodic" for this clause. */
export const DEVICE_CHECK_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

/** Silence beyond this is worth recording when the device is finally used.
 *  Same threshold: a device we would have asked about is a device whose return
 *  deserves a note in the record. */
export const DORMANCY_THRESHOLD_MS = DEVICE_CHECK_INTERVAL_MS;

export const DEVICE_STATE = {
  /**
 * The credential is not ACTIVE because enrolment is incomplete or it is
 * locked. A device that cannot sign is outside periodic checks.
 */
  UNPROVEN: 'UNPROVEN',
  /** Proven inside the interval. */
  OK: 'OK',
  /** Past the interval with no successful verification. The owner should be
   *  asked to attest; nothing is blocked. */
  DUE: 'DUE'
};

/**
 * Find the credential's most recent successful test.
 *
 * Use confirmed_at when it has not yet signed: confirmation is the initial
 * test. Return null when neither timestamp is known. Callers must treat null
 * as unknown, not overdue, including during upgrades before columns are populated.
 */
export function lastProvenAt(credential) {
  if (!credential) return null;
  const verified = credential.last_verified_at;
  if (verified != null && Number.isFinite(Number(verified))) return Number(verified);
  const confirmed = credential.confirmed_at;
  if (confirmed != null && Number.isFinite(Number(confirmed))) return Number(confirmed);
  return null;
}

/**
 * The device-testing status of one credential.
 *
 * `msSinceProven` is returned even when the state is OK, because the console
 * shows it and an auditor asks for it.
 */
export function deviceStatus(credential, now = Date.now()) {
  if (!credential || credential.state !== CREDENTIAL_STATE.ACTIVE) {
    return { state: DEVICE_STATE.UNPROVEN, lastProvenAt: null, msSinceProven: null, dueAt: null };
  }

  const proven = lastProvenAt(credential);
  if (proven == null) {
    // Known-unknown. Not DUE: see lastProvenAt's note on upgrades.
    return { state: DEVICE_STATE.OK, lastProvenAt: null, msSinceProven: null, dueAt: null };
  }

  const msSinceProven = now - proven;
  return {
    state: msSinceProven > DEVICE_CHECK_INTERVAL_MS ? DEVICE_STATE.DUE : DEVICE_STATE.OK,
    lastProvenAt: proven,
    msSinceProven,
    dueAt: proven + DEVICE_CHECK_INTERVAL_MS,
    verificationCount: Number(credential.verification_count ?? 0)
  };
}

/**
 * Check for dormancy when a code verifies. This success-path function must
 * not throw. A credential without earlier proof is new, not dormant; its
 * enrolment is already recorded.
 */
export function dormantOnUse(credential, now = Date.now()) {
  const proven = lastProvenAt(credential);
  if (proven == null) return { dormant: false, msDormant: null };
  const msDormant = now - proven;
  return { dormant: msDormant > DORMANCY_THRESHOLD_MS, msDormant };
}

/** Whole days, for messages and ledger payloads. Floors, so "90 days" never
 *  reads as 91 because of a few milliseconds. */
export function daysBetween(fromMs, toMs) {
  if (fromMs == null || toMs == null) return null;
  return Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000));
}
