import test from 'node:test';
import assert from 'node:assert/strict';
import { resumable } from '../src/lib/restore/resume.js';

const baseline = { summary: 'B_SUM', duedate: 'B_DUE', labels: 'B_LAB' };
const candidate = { summary: 'C_SUM', duedate: 'C_DUE', labels: 'B_LAB' };

test('nothing moved since the signature: resumable', () => {
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: candidate });
  assert.equal(r.ok, true);
  assert.deepEqual(r.intruded, []);
});

test('a partially applied restore is resumable', () => {
  // summary already reverted to baseline, duedate still at the rejected value.
  const current = { summary: 'B_SUM', duedate: 'C_DUE', labels: 'B_LAB' };
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: current });
  assert.equal(r.ok, true);
});

test('a fully applied restore is resumable and idempotent', () => {
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: baseline });
  assert.equal(r.ok, true);
});

test('a third party edit to a tracked field is NOT resumable', () => {
  const current = { summary: 'B_SUM', duedate: 'SOMEBODY_ELSE', labels: 'B_LAB' };
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: current });
  assert.equal(r.ok, false);
  assert.deepEqual(r.intruded, ['duedate']);
  assert.equal(r.reason, 'NEW_EVIDENCE_REQUIRES_APPROVAL');
});

test('a tracked field missing from the current read is NOT resumable', () => {
  const current = { summary: 'B_SUM', labels: 'B_LAB' };
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: current });
  assert.equal(r.ok, false);
  assert.deepEqual(r.intruded, ['duedate']);
});

test('a missing candidate snapshot refuses rather than guessing', () => {
  const r = resumable({ baselineDigests: baseline, candidateDigests: {}, currentDigests: baseline });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_SIGNED_CANDIDATE');
});
