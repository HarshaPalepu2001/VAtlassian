/**
 * Second-factor replacement under 21 CFR 11.300(c) and 11.200(a)(3).
 *
 * Until 2026-08-31, resolvers/totp.js guarded only LOCKED credentials. An
 * ACTIVE credential could be deleted and replaced on request. Anyone with
 * a live Atlassian session could register another authenticator and sign as
 * the original signer. This reduced the two identification components in
 * 11.200(a)(1) to one and let one person perform the actions covered by
 * 11.200(a)(3). These tests prevent that regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrolmentDecision, enrolmentExpired, grantUsable, grantExpiry,
  ENROL_DECISION, ENROLMENT_TTL_MS, GRANT_TTL_MS
} from '../src/lib/credentialRecovery.js';
import { CREDENTIAL_STATE } from '../src/lib/totp.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const cred = (state, enrolledAt = NOW) => ({ state, enrolled_at: enrolledAt });
const openGrant = (over = {}) => ({ expires_at: NOW + 1000, redeemed_at: null, ...over });

// --- the hole that was open ----------------------------------------------

test('an ACTIVE credential cannot be replaced without a grant', () => {
  const verdict = enrolmentDecision({ credential: cred(CREDENTIAL_STATE.ACTIVE), grant: null, now: NOW });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.decision, ENROL_DECISION.NEEDS_GRANT);
  assert.match(verdict.error, /administrator/i);
});

test('a LOCKED credential cannot be replaced without a grant', () => {
  const verdict = enrolmentDecision({ credential: cred(CREDENTIAL_STATE.LOCKED), grant: null, now: NOW });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.decision, ENROL_DECISION.NEEDS_GRANT);
  assert.match(verdict.error, /locked/i);
});

test('ACTIVE and LOCKED credentials both refuse replacement', () => {
  const active = enrolmentDecision({ credential: cred(CREDENTIAL_STATE.ACTIVE), grant: null, now: NOW });
  const locked = enrolmentDecision({ credential: cred(CREDENTIAL_STATE.LOCKED), grant: null, now: NOW });
  assert.equal(active.decision, locked.decision);
  assert.notEqual(active.error, locked.error, 'same refusal, different cause explained');
});

// --- the grant path ------------------------------------------------------

test('a usable grant permits re-enrolment and is consumed', () => {
  const verdict = enrolmentDecision({
    credential: cred(CREDENTIAL_STATE.ACTIVE), grant: openGrant(), now: NOW
  });

  assert.equal(verdict.allow, true);
  assert.equal(verdict.decision, ENROL_DECISION.REDEEM_GRANT);
  assert.equal(verdict.consumesGrant, true, 'single use, or it is not a permission slip');
});

test('an already-redeemed grant is not a second chance', () => {
  const verdict = enrolmentDecision({
    credential: cred(CREDENTIAL_STATE.ACTIVE),
    grant: openGrant({ redeemed_at: NOW - 5 }),
    now: NOW
  });
  assert.equal(verdict.allow, false);
});

test('an expired grant does not work', () => {
  const verdict = enrolmentDecision({
    credential: cred(CREDENTIAL_STATE.ACTIVE),
    grant: openGrant({ expires_at: NOW - 1 }),
    now: NOW
  });
  assert.equal(verdict.allow, false);
});

test('grantUsable is exact at the expiry boundary', () => {
  assert.equal(grantUsable({ expires_at: NOW + 1, redeemed_at: null }, NOW), true);
  assert.equal(grantUsable({ expires_at: NOW, redeemed_at: null }, NOW), false);
  assert.equal(grantUsable(null, NOW), false);
});

test('a grant is issued with a bounded life', () => {
  assert.equal(grantExpiry(NOW), NOW + GRANT_TTL_MS);
  assert.ok(GRANT_TTL_MS > 0 && GRANT_TTL_MS <= 7 * 24 * 60 * 60 * 1000,
    'an unexpiring permission slip is just a weaker password');
});

// --- first-time and restart ----------------------------------------------

test('someone with no credential enrols freely', () => {
  const verdict = enrolmentDecision({ credential: null, grant: null, now: NOW });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.decision, ENROL_DECISION.FIRST_TIME);
  assert.equal(verdict.consumesGrant, false);
});

test('an unproven enrolment can be restarted without a grant', () => {
  const verdict = enrolmentDecision({
    credential: cred(CREDENTIAL_STATE.PENDING_CONFIRM), grant: null, now: NOW
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.decision, ENROL_DECISION.RESTART_PENDING);
});

test('restarting never consumes a grant the person may still need', () => {
  const verdict = enrolmentDecision({
    credential: cred(CREDENTIAL_STATE.PENDING_CONFIRM), grant: openGrant(), now: NOW
  });
  assert.equal(verdict.consumesGrant, false, 'a restart must not burn an unrelated open grant');
});

// --- the enrolment window ------------------------------------------------

test('a displayed enrolment expires', () => {
  const fresh = cred(CREDENTIAL_STATE.PENDING_CONFIRM, NOW - 60_000);
  const stale = cred(CREDENTIAL_STATE.PENDING_CONFIRM, NOW - ENROLMENT_TTL_MS - 1);

  assert.equal(enrolmentExpired(fresh, NOW), false);
  assert.equal(enrolmentExpired(stale, NOW), true);
});

test('the enrolment window is short enough for a leaked QR to be worthless', () => {
  assert.ok(ENROLMENT_TTL_MS <= 30 * 60 * 1000, 'a screenshot must go stale within the hour');
  assert.ok(ENROLMENT_TTL_MS >= 5 * 60 * 1000, 'long enough to install an app and scan');
});

test('expiry applies only to unproven enrolments', () => {
  const old = cred(CREDENTIAL_STATE.ACTIVE, NOW - ENROLMENT_TTL_MS * 100);
  assert.equal(enrolmentExpired(old, NOW), false, 'a working credential does not age out');
});

test('a stale enrolment can be restarted, and says why', () => {
  const verdict = enrolmentDecision({
    credential: cred(CREDENTIAL_STATE.PENDING_CONFIRM, NOW - ENROLMENT_TTL_MS - 1),
    grant: null,
    now: NOW
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.decision, ENROL_DECISION.RESTART_EXPIRED);
});

test('a missing enrolled_at does not expire the row by accident', () => {
  // A row written before this column was reliably populated must not become
  // unusable. Refusing it would lock people out of their own setup.
  assert.equal(enrolmentExpired({ state: CREDENTIAL_STATE.PENDING_CONFIRM, enrolled_at: null }, NOW), false);
});
