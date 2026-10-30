/**
 * Directory reconciliation under 21 CFR 11.300(b).
 *
 * The job revokes credentials, so it must confirm directory evidence before
 * removing a signer's authority. A rate-limited lookup must not revoke valid
 * signers or disable signing across the site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revocations, unresolved, REVOCATION_REASON } from '../src/lib/directoryReconcile.js';

const row = (accountId, role = 'QA', issueTypeId = '10007') => ({
  account_id: accountId, role, issue_type_id: issueTypeId
});

const dir = (entries) => new Map(Object.entries(entries));

// --- the thing it is for -------------------------------------------------

test('a deactivated account loses its eligibility', () => {
  const out = revocations([row('gone')], dir({ gone: { active: false } }));

  assert.equal(out.length, 1);
  assert.equal(out[0].accountId, 'gone');
  assert.equal(out[0].reason, REVOCATION_REASON.DEACTIVATED);
});

test('an active account keeps it', () => {
  assert.deepEqual(revocations([row('here')], dir({ here: { active: true } })), []);
});

test('one revocation per person, however many roles they hold', () => {
  const rows = [row('gone', 'QA', '10007'), row('gone', 'LEAD', '10008'), row('gone', 'QA', '10009')];
  const out = revocations(rows, dir({ gone: { active: false } }));

  assert.equal(out.length, 1, 'someone who left has left for every role at once');
});

test('only the departed are touched when the site is mixed', () => {
  const rows = [row('stay1'), row('gone1'), row('stay2'), row('gone2')];
  const directory = dir({
    stay1: { active: true }, gone1: { active: false },
    stay2: { active: true }, gone2: { active: false }
  });

  assert.deepEqual(revocations(rows, directory).map((r) => r.accountId).sort(), ['gone1', 'gone2']);
});

// --- never revoke on silence ---------------------------------------------

test('a failed lookup revokes nobody', () => {
  const rows = [row('a'), row('b')];
  // Even with a directory that positively says both are inactive: if the call
  // is flagged as failed, its contents cannot be trusted at all.
  const directory = dir({ a: { active: false }, b: { active: false } });

  assert.deepEqual(revocations(rows, directory, { lookupFailed: true }), []);
});

test('an empty directory response revokes nobody', () => {
  // On a site with eligibility configured, the reading "everyone left today" is
  // never more likely than "the call came back empty".
  assert.deepEqual(revocations([row('a'), row('b')], new Map()), []);
});

test('a null directory revokes nobody', () => {
  assert.deepEqual(revocations([row('a')], null), []);
});

test('an account missing from the response is NOT revoked', () => {
  // A deleted user and a truncated page look identical from here, and only one
  // of them is a reason to strip authority.
  const out = revocations([row('present'), row('absent')], dir({ present: { active: false } }));

  assert.deepEqual(out.map((r) => r.accountId), ['present']);
});

test('an entry with no active flag is treated as active', () => {
  // Only an explicit `active: false` counts. A shape we did not expect must
  // default to leaving the person alone.
  for (const entry of [{}, { active: undefined }, { active: null }, { displayName: 'X' }]) {
    assert.deepEqual(revocations([row('x')], dir({ x: entry })), [], JSON.stringify(entry));
  }
});

test('the string "false" is not the boolean false', () => {
  // Guarding the same class of coercion bug that Number(null) caused in
  // credentialRecovery: a truthy string must not read as deactivated.
  assert.deepEqual(revocations([row('x')], dir({ x: { active: 'false' } })), []);
});

// --- unresolved accounts are reported, not acted on -----------------------

test('accounts the directory never mentioned are reported separately', () => {
  const rows = [row('known'), row('ghost1'), row('ghost2')];
  const directory = dir({ known: { active: true } });

  assert.deepEqual(unresolved(rows, directory).sort(), ['ghost1', 'ghost2']);
  assert.deepEqual(revocations(rows, directory), [], 'reported is not the same as revoked');
});

test('unresolved deduplicates a person holding several roles', () => {
  const rows = [row('ghost', 'QA'), row('ghost', 'LEAD')];
  assert.deepEqual(unresolved(rows, new Map([['other', { active: true }]])), ['ghost']);
});

// --- shapes that must not throw ------------------------------------------

test('empty and malformed input is handled without throwing', () => {
  assert.deepEqual(revocations([], dir({ a: { active: false } })), []);
  assert.deepEqual(revocations(null, dir({ a: { active: false } })), []);
  assert.deepEqual(revocations([{}, { account_id: null }], dir({ a: { active: false } })), []);
  assert.deepEqual(unresolved(null, new Map()), []);
});
