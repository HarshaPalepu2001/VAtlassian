import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptWebAuthnAssertion,
  counterRegressed,
  deriveRpId,
  environmentIsDevelopment,
  originAllowed,
  webauthnBindingHash,
  WEBAUTHN_ASSERTION_ASSURANCE,
  WEBAUTHN_FAIL
} from '../src/lib/webauthn.js';
import { createWebAuthnUsecases } from '../src/usecases/webauthn.js';

const ORIGIN = 'https://tenant.atlassian.net';
const RP_ID = 'tenant.atlassian.net';
const ACCOUNT = 'trusted-actor';
const BINDING = { accountId: ACCOUNT, issueId: 10, decision: 'APPROVE', contentHash: 'a'.repeat(64) };
const APPROVAL_CHALLENGE_ID = 'b'.repeat(32);
const WEBAUTHN_CHALLENGE_ID = Buffer.alloc(16, 7).toString('base64');

test('an assertion is accepted only when the signature, the user and the binding all hold', () => {
  const good = {
    verified: true, userPresent: true, userVerified: true, backupState: false,
    storedCount: 4, presentedCount: 5,
    expectedBinding: 'c'.repeat(64), presentedBinding: 'c'.repeat(64)
  };
  const accepted = acceptWebAuthnAssertion(good);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.assertionAssurance, WEBAUTHN_ASSERTION_ASSURANCE.DEVICE_BOUND_UV);
  assert.equal(acceptWebAuthnAssertion({ ...good, backupState: true }).assertionAssurance, WEBAUTHN_ASSERTION_ASSURANCE.SYNCED_UV);

  // A device that only sensed a finger has not identified the signer, which is
  // the whole claim a biometric approval makes.
  assert.equal(acceptWebAuthnAssertion({ ...good, userVerified: false }).reason, WEBAUTHN_FAIL.NO_USER_VERIFICATION);
  assert.equal(acceptWebAuthnAssertion({ ...good, verified: false }).reason, WEBAUTHN_FAIL.BAD_SIGNATURE);
  assert.equal(acceptWebAuthnAssertion({ ...good, userPresent: false }).reason, WEBAUTHN_FAIL.BAD_SIGNATURE);
  // A valid signature collected for another decision must not be replayable here.
  assert.equal(acceptWebAuthnAssertion({ ...good, presentedBinding: 'd'.repeat(64) }).reason, WEBAUTHN_FAIL.BINDING_MISMATCH);
  assert.equal(acceptWebAuthnAssertion({ ...good, presentedBinding: 'd'.repeat(63) }).reason, WEBAUTHN_FAIL.BINDING_MISMATCH);
  assert.equal(acceptWebAuthnAssertion({ ...good, presentedCount: 4 }).reason, WEBAUTHN_FAIL.COUNTER_REGRESSION);
  // A counter either side has never reported is not evidence of cloning.
  assert.equal(counterRegressed(0, 0), false);
  assert.equal(counterRegressed(9, 0), false);
});

test('the binding hash separates issue, decision and content', () => {
  const base = webauthnBindingHash(BINDING);
  assert.equal(base, webauthnBindingHash({ ...BINDING }));
  for (const change of [{ issueId: 11 }, { decision: 'REJECT' }, { contentHash: 'e'.repeat(64) }, { accountId: 'other' }]) {
    assert.notEqual(webauthnBindingHash({ ...BINDING, ...change }), base);
  }
});

test('only a secure Atlassian address may host a device check, and loopback only in development', () => {
  assert.equal(originAllowed(ORIGIN), true);
  assert.equal(originAllowed('https://x.cdn.prod.atlassian-dev.net'), true);
  assert.equal(originAllowed('http://tenant.atlassian.net'), false);
  assert.equal(originAllowed('https://tenant.atlassian.net.attacker.example'), false);
  assert.equal(originAllowed('https://evil.example'), false);
  assert.equal(originAllowed(undefined), false);
  assert.equal(originAllowed('http://localhost:3000'), false);
  assert.equal(originAllowed('http://localhost:3000', true), true);
  assert.equal(deriveRpId(ORIGIN), RP_ID);
  assert.equal(environmentIsDevelopment({ environmentType: 'DEVELOPMENT' }), true);
  assert.equal(environmentIsDevelopment({ environmentType: 'PRODUCTION' }), false);
});

function fixture(overrides = {}) {
  const state = {
    consumed: false,
    touched: null,
    audits: [],
    credential: {
      credential_row_id: 'row-1', account_id: ACCOUNT, credential_id: 'credential-1',
      public_key: Buffer.alloc(32, 1).toString('base64'), sign_count: 4,
      rp_id: RP_ID, origin: ORIGIN, backup_state: false, transports: 'internal', state: 'ACTIVE'
    },
    challengeRow: {
      challenge_id: WEBAUTHN_CHALLENGE_ID, account_id: ACCOUNT, purpose: 'ASSERT',
      challenge: 'server-challenge', binding_hash: webauthnBindingHash(BINDING),
      issue_id: 10, rp_id: RP_ID, consumed_at: null, expires_at: 10_000
    },
    approvalChallenge: {
      challenge_id: Buffer.from(APPROVAL_CHALLENGE_ID, 'hex'), signer_account_id: ACCOUNT,
      state: 'PENDING', expires_at: 10_000, issue_id: 10, decision: 'APPROVE', candidate_hash: BINDING.contentHash
    }
  };
  const deps = {
    now: () => 1_000,
    credentialsFor: async () => [state.credential],
    credentialFor: async ({ credentialId }) => (credentialId === state.credential.credential_id ? state.credential : null),
    touchCredential: async args => { state.touched = args; },
    enrolCredential: async () => ({ credentialRowId: 'row-2' }),
    webAuthnChallengeById: async () => state.challengeRow,
    consumeWebAuthnChallenge: async () => {
      if (state.consumed) return { consumed: false };
      state.consumed = true;
      return { consumed: true };
    },
    issueWebAuthnChallenge: async () => ({ challengeId: Buffer.alloc(16, 7), expiresAt: 10_000 }),
    getApprovalChallenge: async () => state.approvalChallenge,
    audit: async event => { state.audits.push(event); },
    generateAuthenticationOptions: async () => ({ challenge: 'server-challenge', allowCredentials: [] }),
    verifyAuthenticationResponse: async () => ({
      verified: true,
      authenticationInfo: { userVerified: true, newCounter: 5, credentialBackedUp: false }
    }),
    ...overrides
  };
  return { state, api: createWebAuthnUsecases(deps), deps };
}

const assertPayload = { origin: ORIGIN, challengeId: WEBAUTHN_CHALLENGE_ID, response: { id: 'credential-1' } };
const context = { accountId: ACCOUNT, environmentType: 'PRODUCTION' };

test('a verified assertion binds to the open approval and advances the signature counter', async () => {
  const { api, state } = fixture();
  const result = await api.verifyAssertion({ binding: BINDING, payload: assertPayload, context });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.credentialId, 'credential-1');
  assert.equal(result.rpId, RP_ID);
  assert.equal(result.assertionAssurance, WEBAUTHN_ASSERTION_ASSURANCE.DEVICE_BOUND_UV);
  assert.equal(state.touched.signCount, 5);
  assert.equal(state.consumed, true, 'the challenge must be spent so it cannot be replayed');
});

test('the same device check cannot be spent twice', async () => {
  const { api } = fixture();
  assert.equal((await api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).ok, true);
  const replay = await api.verifyAssertion({ binding: BINDING, payload: assertPayload, context });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, WEBAUTHN_FAIL.CHALLENGE_SPENT);
});

test('a device check refuses an approval it was not collected for', async () => {
  for (const change of [{ issueId: 11 }, { decision: 'REJECT' }, { contentHash: 'f'.repeat(64) }]) {
    const { api, state } = fixture();
    const result = await api.verifyAssertion({ binding: { ...BINDING, ...change }, payload: assertPayload, context });
    assert.equal(result.ok, false);
    assert.equal(result.reason, WEBAUTHN_FAIL.BINDING_MISMATCH);
    assert.equal(state.touched, null);
  }
});

test('a device check refuses an actor other than the signer the approval names', async () => {
  const { api } = fixture();
  const result = await api.verifyAssertion({ binding: { ...BINDING, accountId: 'someone-else' }, payload: assertPayload, context });
  assert.equal(result.ok, false);
  assert.equal(result.reason, WEBAUTHN_FAIL.BINDING_MISMATCH);
});

test('an expired, unknown, or wrong-purpose check is refused before any credential is read', async () => {
  const expired = fixture();
  expired.state.challengeRow = { ...expired.state.challengeRow, expires_at: 500 };
  assert.equal((await expired.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).reason, WEBAUTHN_FAIL.CHALLENGE_EXPIRED);

  const missing = fixture({ webAuthnChallengeById: async () => null });
  assert.equal((await missing.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).reason, WEBAUTHN_FAIL.CHALLENGE_EXPIRED);

  // An enrolment challenge must never be redeemable as an approval.
  const enrolPurpose = fixture();
  enrolPurpose.state.challengeRow = { ...enrolPurpose.state.challengeRow, purpose: 'ENROL' };
  assert.equal((await enrolPurpose.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).reason, WEBAUTHN_FAIL.BINDING_MISMATCH);
});

test('an unrecognised credential, a moved installation, and a bad signature are all refused', async () => {
  const unknown = fixture({ credentialFor: async () => null });
  assert.equal((await unknown.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).reason, WEBAUTHN_FAIL.UNKNOWN_CREDENTIAL);

  const moved = fixture();
  moved.state.credential = { ...moved.state.credential, rp_id: 'other.atlassian.net' };
  assert.equal((await moved.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).reason, WEBAUTHN_FAIL.RP_CHANGED);

  const forged = fixture({ verifyAuthenticationResponse: async () => ({ verified: false, authenticationInfo: null }) });
  const result = await forged.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context });
  assert.equal(result.reason, WEBAUTHN_FAIL.BAD_SIGNATURE);
  assert.equal(forged.state.touched, null);
  assert.equal(forged.state.audits.at(-1)?.eventType, 'WEBAUTHN_AUTH_FAILED');

  const thrown = fixture({ verifyAuthenticationResponse: async () => { throw new Error('malformed'); } });
  assert.equal((await thrown.api.verifyAssertion({ binding: BINDING, payload: assertPayload, context })).reason, WEBAUTHN_FAIL.BAD_SIGNATURE);
});

test('an untrusted address cannot host a device check for any account', async () => {
  const { api, state } = fixture();
  const result = await api.verifyAssertion({ binding: BINDING, payload: { ...assertPayload, origin: 'https://evil.example' }, context });
  assert.equal(result.ok, false);
  assert.equal(result.reason, WEBAUTHN_FAIL.ORIGIN_REFUSED);
  assert.equal(state.consumed, false);
});

test('a device check starts only against the signer own pending approval', async () => {
  const started = await fixture().api.assertStart({ payload: { origin: ORIGIN, approvalChallengeId: APPROVAL_CHALLENGE_ID }, context });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.challengeId, WEBAUTHN_CHALLENGE_ID);

  const other = fixture();
  other.state.approvalChallenge = { ...other.state.approvalChallenge, signer_account_id: 'someone-else' };
  assert.equal((await other.api.assertStart({ payload: { origin: ORIGIN, approvalChallengeId: APPROVAL_CHALLENGE_ID }, context })).reason, WEBAUTHN_FAIL.BINDING_MISMATCH);

  const spent = fixture();
  spent.state.approvalChallenge = { ...spent.state.approvalChallenge, state: 'CONSUMED' };
  assert.equal((await spent.api.assertStart({ payload: { origin: ORIGIN, approvalChallengeId: APPROVAL_CHALLENGE_ID }, context })).reason, WEBAUTHN_FAIL.BINDING_MISMATCH);

  const anonymous = await fixture().api.assertStart({ payload: { origin: ORIGIN, approvalChallengeId: APPROVAL_CHALLENGE_ID }, context: {} });
  assert.equal(anonymous.reason, WEBAUTHN_FAIL.UNAVAILABLE);
});

test('a reviewer with no usable registration is told which of the two problems it is', async () => {
  const none = fixture({ credentialsFor: async () => [] });
  assert.equal((await none.api.assertStart({ payload: { origin: ORIGIN, approvalChallengeId: APPROVAL_CHALLENGE_ID }, context })).reason, WEBAUTHN_FAIL.NOT_ENROLLED);

  const elsewhere = fixture();
  elsewhere.state.credential = { ...elsewhere.state.credential, rp_id: 'other.atlassian.net' };
  const moved = await elsewhere.api.assertStart({ payload: { origin: ORIGIN, approvalChallengeId: APPROVAL_CHALLENGE_ID }, context });
  assert.equal(moved.reason, WEBAUTHN_FAIL.RP_CHANGED);

  const status = await elsewhere.api.status({ payload: { origin: ORIGIN }, context });
  assert.equal(status.enrolled, true);
  assert.equal(status.usableHere, false);
  assert.equal(status.enrolledElsewhere, true);
});
