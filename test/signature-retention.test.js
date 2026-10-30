/**
 * Retention and pruning under 21 CFR 11.10(c).
 *
 * Pruning irreversibly deletes records a customer may need to retain for
 * years. These tests guard every path to `prune: true` against accidental
 * deletion.
 *
 * The named 90-day case reproduces a near miss in which an operational
 * device-check interval was used as a legal retention period.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retentionPolicy, prunable, describeRetention,
  RETENTION_DAYS_CFG, RETENTION_ACK_CFG, RETENTION_FLOOR_DAYS, PRUNE_REFUSAL
} from '../src/lib/retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-31T12:00:00Z');

/** A segment with every evidence precondition satisfied. */
const ready = (over = {}) => ({
  sealed_at: NOW - 800 * DAY,
  export_ref: 'archive:12345',
  export_sha256: 'a'.repeat(64),
  verified_at: NOW - 799 * DAY,
  pruned_at: null,
  ...over
});

const policyOf = (cfg) => retentionPolicy(cfg);
const enabled = policyOf({ [RETENTION_DAYS_CFG]: '730' });

// --- the default is never ------------------------------------------------

test('an unconfigured instance never prunes', () => {
  const policy = policyOf({});

  assert.equal(policy.configured, false);
  assert.equal(policy.mayPrune, false);
  assert.equal(prunable(ready(), policy, NOW).reason, PRUNE_REFUSAL.NO_POLICY);
});

test('retaining forever is described as a posture, not a blank', () => {
  assert.match(describeRetention(policyOf({})), /Retained indefinitely/);
});

test('unreadable or nonsense config falls back to never, not to zero', () => {
  // A period of zero would mean delete everything immediately. It must not be
  // reachable by a typo, an empty string, or a failed config read.
  for (const raw of ['', '   ', 'abc', 'null', undefined, null, '0', '-30', 'NaN']) {
    const policy = policyOf({ [RETENTION_DAYS_CFG]: raw });
    assert.equal(policy.configured, false, `"${raw}" must not configure retention`);
    assert.equal(prunable(ready(), policy, NOW).prune, false);
  }
});

// --- the floor, and the near miss that motivated it ----------------------

test('90 days is refused without an explicit acknowledgement', () => {
  // The number that was nearly adopted. It came from the device-check
  // interval, which measures device activity rather than legal retention.
  const policy = policyOf({ [RETENTION_DAYS_CFG]: '90' });

  assert.equal(policy.configured, true);
  assert.equal(policy.belowFloor, true);
  assert.equal(policy.mayPrune, false);
  assert.match(policy.warning, /below the 365-day floor/);
  assert.match(policy.warning, /operational number entered into a legal field/);
  assert.equal(prunable(ready(), policy, NOW).reason, PRUNE_REFUSAL.BELOW_FLOOR_UNACKNOWLEDGED);
});

test('a short period works only after a second, deliberate act', () => {
  const acked = policyOf({ [RETENTION_DAYS_CFG]: '90', [RETENTION_ACK_CFG]: 'true' });

  assert.equal(acked.mayPrune, true);
  assert.equal(acked.warning, null);
  assert.equal(prunable(ready(), acked, NOW).prune, true);
});

test('acknowledgement must be the literal string true', () => {
  for (const ack of ['yes', '1', 'TRUE', 'on', '', 'false', undefined]) {
    const policy = policyOf({ [RETENTION_DAYS_CFG]: '90', [RETENTION_ACK_CFG]: ack });
    assert.equal(policy.mayPrune, false, `"${ack}" must not count as acknowledgement`);
  }
});

test('a period at or above the floor needs no acknowledgement', () => {
  const atFloor = policyOf({ [RETENTION_DAYS_CFG]: String(RETENTION_FLOOR_DAYS) });
  assert.equal(atFloor.belowFloor, false);
  assert.equal(atFloor.mayPrune, true);
});

test('one day below the floor is below the floor', () => {
  const policy = policyOf({ [RETENTION_DAYS_CFG]: String(RETENTION_FLOOR_DAYS - 1) });
  assert.equal(policy.belowFloor, true);
  assert.equal(policy.mayPrune, false);
});

// --- evidence before time ------------------------------------------------

test('an unexported segment is never pruned, however old', () => {
  const old = ready({ export_ref: null, export_sha256: null, sealed_at: NOW - 5000 * DAY });
  assert.deepEqual(prunable(old, enabled, NOW), { prune: false, reason: PRUNE_REFUSAL.NOT_EXPORTED });
});

test('an exported but unverified segment is never pruned', () => {
  // Exported is not retrievable. Until the copy has been read back and its
  // hash matched, deleting the original trades a record we have for one we
  // assume.
  const unverified = ready({ verified_at: null });
  assert.deepEqual(prunable(unverified, enabled, NOW), { prune: false, reason: PRUNE_REFUSAL.NOT_VERIFIED });
});

test('a half-exported segment counts as unexported', () => {
  assert.equal(prunable(ready({ export_sha256: null }), enabled, NOW).reason, PRUNE_REFUSAL.NOT_EXPORTED);
  assert.equal(prunable(ready({ export_ref: null }), enabled, NOW).reason, PRUNE_REFUSAL.NOT_EXPORTED);
});

test('an unsealed or missing segment is never pruned', () => {
  assert.equal(prunable(ready({ sealed_at: null }), enabled, NOW).reason, PRUNE_REFUSAL.NOT_SEALED);
  assert.equal(prunable(null, enabled, NOW).reason, PRUNE_REFUSAL.NOT_SEALED);
});

test('an already-pruned segment is not pruned twice', () => {
  assert.equal(prunable(ready({ pruned_at: NOW - DAY }), enabled, NOW).reason, PRUNE_REFUSAL.ALREADY_PRUNED);
});

test('evidence is checked before age, so age alone never prunes', () => {
  // A segment old enough by any measure, but with nothing to show for itself.
  const ancient = { sealed_at: 0, export_ref: null, export_sha256: null, verified_at: null, pruned_at: null };
  const verdict = prunable(ancient, enabled, NOW);

  assert.equal(verdict.prune, false);
  assert.notEqual(verdict.reason, PRUNE_REFUSAL.WITHIN_RETENTION, 'age must not be the reported reason');
});

// --- and only then, time -------------------------------------------------

test('a fully evidenced segment inside its period is retained, with a date', () => {
  const recent = ready({ sealed_at: NOW - 10 * DAY, verified_at: NOW - 9 * DAY });
  const verdict = prunable(recent, enabled, NOW);

  assert.equal(verdict.prune, false);
  assert.equal(verdict.reason, PRUNE_REFUSAL.WITHIN_RETENTION);
  assert.equal(verdict.retainedUntil, (NOW - 10 * DAY) + 730 * DAY);
});

test('a fully evidenced segment past its period may be pruned', () => {
  assert.deepEqual(prunable(ready(), enabled, NOW), { prune: true });
});

test('the period boundary retains rather than prunes', () => {
  // Exactly at the period is still within it. When the two readings are one
  // day apart and one of them deletes records, take the other.
  const exact = ready({ sealed_at: NOW - 730 * DAY, verified_at: NOW - DAY });
  assert.equal(prunable(exact, enabled, NOW).prune, false);

  const past = ready({ sealed_at: NOW - 730 * DAY - 1, verified_at: NOW - DAY });
  assert.equal(prunable(past, enabled, NOW).prune, true);
});

// --- how it reads --------------------------------------------------------

test('the console describes each of the three states distinctly', () => {
  assert.match(describeRetention(policyOf({})), /indefinitely/);
  assert.match(describeRetention(policyOf({ [RETENTION_DAYS_CFG]: '90' })), /Awaiting acknowledgement before taking effect/);
  assert.match(describeRetention(enabled), /730 days after sealing, once exported and verified/);
});
