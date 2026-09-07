/**
 * DEVICE TESTING — 21 CFR 11.300(e).
 *
 * "Initial and periodic testing of devices, such as tokens or cards, that bear
 * or generate identification code or password information, to ensure that they
 * function properly and have not been altered in an unauthorized manner."
 *
 * WHAT THE TEST IS. The clause was written with hardware tokens in mind, and
 * the instinct is to invent a testing ceremony to match. For a software
 * authenticator that would be theatre: a correct TOTP code already proves the
 * device holds the right secret and has a clock inside the accepted window.
 * Nothing we could administer separately would prove more. So confirmation at
 * enrolment IS the initial test, and every subsequent signature IS a periodic
 * one — we were performing this control all along and simply not recording it.
 *
 * WHY BLOCKING IS THE WRONG ENFORCEMENT, and this is worth stating because
 * everything else in this codebase fails closed. Refusing to sign until the
 * device is tested would be circular: the act of signing is the test. A gate
 * there would demand a code before accepting a code. The useful control is not
 * a barrier but a RECORD, plus one thing a record alone cannot give us —
 *
 * DORMANCY. A device that has not produced a code in months is untested, and
 * untested is where the risk actually lives: a phone replaced, an app deleted,
 * a secret cloned during enrolment and never used. None of that surfaces until
 * someone signs, and if the person who signs is not the owner, the first
 * evidence of the theft is the forged signature itself. So we notice the
 * silence: a credential past DEVICE_CHECK_INTERVAL_MS is due for an
 * attestation the OWNER performs, which puts the discovery in the hands of the
 * person who would notice their authenticator is gone.
 *
 * And when a long-dormant credential is finally used, that fact is recorded
 * alongside the signature. We cannot tell a returning employee from a thief —
 * but "this device had been silent for 214 days" is exactly the context an
 * investigator needs and the audit trail could not previously supply.
 *
 * PURE. Policy here; resolvers and jobs/devicecheck.js do the I/O.
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
  /** Not ACTIVE — enrolment never completed, or the credential is locked.
   *  There is no periodic obligation over a device that cannot sign. */
  UNPROVEN: 'UNPROVEN',
  /** Proven inside the interval. */
  OK: 'OK',
  /** Past the interval with no successful verification. The owner should be
   *  asked to attest; nothing is blocked. */
  DUE: 'DUE'
};

/**
 * When did this credential last demonstrate that it works?
 *
 * Falls back to `confirmed_at`, because confirmation is the initial test and a
 * credential confirmed yesterday is not overdue merely because nobody has
 * signed with it yet. Returns null when neither is known, which the caller must
 * treat as "cannot tell", never as "long overdue" — an upgrade that has not yet
 * populated these columns must not declare every credential in the instance
 * due on the day it ships.
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
 * At the moment a code verifies, had this device been silent long enough to be
 * worth noting?
 *
 * Called on the success path, so it must be cheap and must never throw. A
 * credential with no prior proof is not dormant — it is new, which is a
 * different thing and already recorded as an enrolment.
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
