/**
 * Device testing under 21 CFR 11.300(e).
 *
 * 1. An unknown last-proven time must never count as overdue. Otherwise the
 *    migration would mark every credential due and obscure dormant devices.
 * 2. A credential that cannot sign has no periodic testing obligation.
 *    Locked and half-enrolled credentials must not appear overdue for testing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deviceStatus, dormantOnUse, lastProvenAt, daysBetween,
  DEVICE_STATE, DEVICE_CHECK_INTERVAL_MS, DORMANCY_THRESHOLD_MS
} from '../src/lib/deviceCheck.js';
import { overduePeriod, shouldRecord } from '../src/jobs/devicecheck.js';
import { CREDENTIAL_STATE } from '../src/lib/totp.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const active = (over = {}) => ({
  state: CREDENTIAL_STATE.ACTIVE,
  confirmed_at: NOW - 200 * DAY,
  last_verified_at: NOW - DAY,
  verification_count: 12,
  ...over
});

// --- what counts as "last proven" ----------------------------------------

test('a verification is the proof when there is one', () => {
  assert.equal(lastProvenAt(active({ last_verified_at: NOW - 5 * DAY })), NOW - 5 * DAY);
});

test('confirmation is the initial test when nothing has been signed yet', () => {
  // A credential confirmed yesterday is not overdue merely because its owner
  // has not had anything to sign.
  const cred = active({ last_verified_at: null, confirmed_at: NOW - DAY });
  assert.equal(lastProvenAt(cred), NOW - DAY);
  assert.equal(deviceStatus(cred, NOW).state, DEVICE_STATE.OK);
});

test('an unknown last-proven time is NOT treated as overdue', () => {
  // The migration-day trap: rows predating these columns must not all light up.
  const cred = active({ last_verified_at: null, confirmed_at: null });

  assert.equal(lastProvenAt(cred), null);
  const status = deviceStatus(cred, NOW);
  assert.equal(status.state, DEVICE_STATE.OK, 'cannot tell is not the same as overdue');
  assert.equal(status.msSinceProven, null, 'and must not invent a duration');
});

test('a zero timestamp is a real timestamp, not a missing one', () => {
  // Number(null) is 0, which bit us once already in credentialRecovery. Epoch
  // zero is genuinely ancient, so this one SHOULD be overdue.
  const cred = active({ last_verified_at: 0, confirmed_at: null });
  assert.equal(lastProvenAt(cred), 0);
  assert.equal(deviceStatus(cred, NOW).state, DEVICE_STATE.DUE);
});

// --- the interval boundary -----------------------------------------------

test('exactly at the interval is not yet due', () => {
  const cred = active({ last_verified_at: NOW - DEVICE_CHECK_INTERVAL_MS });
  assert.equal(deviceStatus(cred, NOW).state, DEVICE_STATE.OK);
});

test('one millisecond past the interval is due', () => {
  const cred = active({ last_verified_at: NOW - DEVICE_CHECK_INTERVAL_MS - 1 });
  assert.equal(deviceStatus(cred, NOW).state, DEVICE_STATE.DUE);
});

test('a clock that moved backwards does not make a device due', () => {
  // A future last_verified_at yields a negative age, which must not compare
  // as overdue through some sign mistake.
  const cred = active({ last_verified_at: NOW + 10 * DAY });
  const status = deviceStatus(cred, NOW);
  assert.equal(status.state, DEVICE_STATE.OK);
  assert.ok(status.msSinceProven < 0);
});

test('status reports the due date and the count for the console', () => {
  const cred = active({ last_verified_at: NOW - 10 * DAY, verification_count: 7 });
  const status = deviceStatus(cred, NOW);

  assert.equal(status.dueAt, NOW - 10 * DAY + DEVICE_CHECK_INTERVAL_MS);
  assert.equal(status.verificationCount, 7);
  assert.equal(status.msSinceProven, 10 * DAY);
});

// --- credentials with no obligation --------------------------------------

test('a credential that cannot sign is UNPROVEN, never DUE', () => {
  for (const state of [CREDENTIAL_STATE.LOCKED, CREDENTIAL_STATE.PENDING_CONFIRM]) {
    const cred = active({ state, last_verified_at: NOW - 900 * DAY });
    assert.equal(deviceStatus(cred, NOW).state, DEVICE_STATE.UNPROVEN, `${state} must not be reported as due`);
  }
});

test('a missing credential is UNPROVEN rather than a crash', () => {
  assert.equal(deviceStatus(null, NOW).state, DEVICE_STATE.UNPROVEN);
  assert.equal(deviceStatus(undefined, NOW).state, DEVICE_STATE.UNPROVEN);
});

// --- dormancy at the moment of use ---------------------------------------

test('a long-silent device is flagged when it is finally used', () => {
  const cred = active({ last_verified_at: NOW - 214 * DAY });
  const result = dormantOnUse(cred, NOW);

  assert.equal(result.dormant, true);
  assert.equal(daysBetween(NOW - result.msDormant, NOW), 214);
});

test('a device in regular use is never flagged as dormant', () => {
  assert.equal(dormantOnUse(active({ last_verified_at: NOW - DAY }), NOW).dormant, false);
});

test('a brand new credential is not dormant', () => {
  // No prior proof means new, which is already recorded as an enrolment.
  // Reporting it as a returning dormant device would be a false positive on
  // every first signature in the system.
  const cred = active({ last_verified_at: null, confirmed_at: null });
  assert.equal(dormantOnUse(cred, NOW).dormant, false);
});

test('dormancy is measured on the same threshold the scan uses', () => {
  // If these drifted apart, a device could be reported dormant on use without
  // ever having been listed as due, or vice versa. Both controls describe
  // the same silence with different numbers.
  assert.equal(DORMANCY_THRESHOLD_MS, DEVICE_CHECK_INTERVAL_MS);
});

// --- the once-per-period ledger rule -------------------------------------

test('overduePeriod counts whole intervals of silence', () => {
  assert.equal(overduePeriod(0), 0);
  assert.equal(overduePeriod(DEVICE_CHECK_INTERVAL_MS - 1), 0);
  assert.equal(overduePeriod(DEVICE_CHECK_INTERVAL_MS), 1);
  assert.equal(overduePeriod(DEVICE_CHECK_INTERVAL_MS * 2.5), 2);
  assert.equal(overduePeriod(null), 0);
});

test('a daily scan records a dormant credential once, not every day', () => {
  const cred = active({ last_verified_at: NOW - 100 * DAY });
  const status = deviceStatus(cred, NOW);

  assert.equal(shouldRecord(status, 0), true, 'first crossing is news');
  assert.equal(shouldRecord(status, 1), false, 'the same fact tomorrow is not');
  assert.equal(shouldRecord(status, undefined), true, 'never recorded before');
});

test('a second interval of silence is news again', () => {
  const cred = active({ last_verified_at: NOW - (DEVICE_CHECK_INTERVAL_MS * 2 + DAY) });
  const status = deviceStatus(cred, NOW);

  assert.equal(overduePeriod(status.msSinceProven), 2);
  assert.equal(shouldRecord(status, 1), true, 'still ignored after 180 days is a new fact');
  assert.equal(shouldRecord(status, 2), false);
});

test('nothing is recorded for a credential that is not due', () => {
  const status = deviceStatus(active({ last_verified_at: NOW - DAY }), NOW);
  assert.equal(shouldRecord(status, 0), false);
});

// --- helper --------------------------------------------------------------

test('daysBetween floors, so 90 days never reads as 91', () => {
  assert.equal(daysBetween(NOW - 90 * DAY - 1, NOW), 90);
  assert.equal(daysBetween(NOW, NOW), 0);
  assert.equal(daysBetween(null, NOW), null);
  assert.equal(daysBetween(NOW, null), null);
});
