import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSURANCE_LEVEL, meetsAssurance, MINIMUM_ASSURANCE, effectiveAssurance } from '../src/lib/approval/levels.js';
import { providerFor } from '../src/lib/approval/registry.js';
import { makeApproval, validEvidence } from '../src/lib/approval/record.js';

const binding = { accountId: 'trusted-actor', issueId: 10, fromStatusId: '1', toStatusId: '2', contentHash: 'a'.repeat(64), decision: 'APPROVE' };
test('assurance is ordered once and unknown policy never permits an approval', () => {
  assert.equal(meetsAssurance('ESIGNATURE', 'NATIVE_TRANSITION'), true);
  assert.equal(meetsAssurance('NATIVE_TRANSITION', 'ESIGNATURE'), false);
  for (const value of [undefined, null, '', 'UNKNOWN', 'toString', '__proto__']) {
    assert.equal(meetsAssurance('BIOMETRIC', value), false);
    assert.equal(meetsAssurance(value, 'NATIVE_TRANSITION'), false);
  }
  assert.equal(Object.keys(ASSURANCE_LEVEL).length, 4);
});
test('native confirmation binds the trusted actor, issue, edge and content', async () => {
  const provider = providerFor('NATIVE_TRANSITION');
  assert.equal((await provider.verify({ binding, confirmed: false })).ok, false);
  const proof = await provider.verify({ binding, confirmed: true, accountId: 'spoof' });
  assert.equal(proof.ok, true);
  assert.deepEqual(proof.evidence.binding, binding);
  const record = makeApproval({ ...binding, issueKey: 'T-10', projectId: 1, issueTypeId: '1', actorName: 'Tester', meaning: 'Approved', signerRole: 'reviewer', proof, now: 100 });
  assert.equal(record.state, 'VOID');
  assert.equal(validEvidence(record), true);
  assert.equal(validEvidence({ ...record, content_hash: 'b'.repeat(64) }), false);
  assert.equal(validEvidence({ ...record, account_id: 'spoof' }), false);
});
test('reserved providers fail closed, and the registry refuses unknown providers', async () => {
  for (const level of ['JSM_APPROVAL', 'BIOMETRIC']) {
    assert.equal((await providerFor(level).verify({ binding })).reason, 'NOT_CONFIGURED');
  }
  assert.throws(() => providerFor('toString'));
});

test('the floor is an electronic signature', () => {
  assert.equal(MINIMUM_ASSURANCE, 'ESIGNATURE');
});

test('a policy configured below the floor is raised to it', () => {
  assert.equal(effectiveAssurance('NATIVE_TRANSITION'), 'ESIGNATURE');
  assert.equal(effectiveAssurance('JSM_APPROVAL'), 'ESIGNATURE');
});

test('a policy at or above the floor is left alone', () => {
  assert.equal(effectiveAssurance('ESIGNATURE'), 'ESIGNATURE');
  assert.equal(effectiveAssurance('BIOMETRIC'), 'BIOMETRIC');
});

test('an unknown or missing policy falls back to the floor, never below it', () => {
  assert.equal(effectiveAssurance('NONSENSE'), 'ESIGNATURE');
  assert.equal(effectiveAssurance(null), 'ESIGNATURE');
  assert.equal(effectiveAssurance(undefined), 'ESIGNATURE');
});
