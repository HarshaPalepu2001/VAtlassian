import crypto from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';

import { getChallenge as getApprovalChallenge } from '../db/challengeStore.js';
import {
  consumeWebAuthnChallenge,
  issueWebAuthnChallenge,
  webAuthnChallengeById
} from '../db/webauthnChallengeStore.js';
import {
  credentialFor,
  credentialsFor,
  enrolCredential,
  touchCredential
} from '../db/webauthnCredentialStore.js';
import { tryAppend } from '../db/store.js';
import {
  challengeUsable,
  deriveRpId,
  environmentIsDevelopment,
  originAllowed,
  rpChanged,
  acceptWebAuthnAssertion,
  webauthnBindingHash,
  WEBAUTHN_ASSERTION_ASSURANCE,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_CREDENTIAL_KIND,
  WEBAUTHN_FAIL,
  WEBAUTHN_FAIL_MESSAGE,
  WEBAUTHN_PURPOSE,
  WEBAUTHN_RP_NAME
} from '../lib/webauthn.js';

const PLATFORM_HINTS = ['client-device'];

function fail(reason, extra = {}) {
  return {
    ok: false,
    reason,
    error: WEBAUTHN_FAIL_MESSAGE[reason] ?? WEBAUTHN_FAIL_MESSAGE[WEBAUTHN_FAIL.UNAVAILABLE],
    ...extra
  };
}

function accountIdOf(context) {
  return typeof context?.accountId === 'string' && context.accountId ? context.accountId : null;
}

function userHandle(accountId) {
  return new Uint8Array(crypto.createHash('sha256').update(String(accountId)).digest().subarray(0, 32));
}

function parseBase64Id(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 16 ? decoded : null;
  } catch {
    return null;
  }
}

function parseHexChallengeId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value) ? Buffer.from(value, 'hex') : null;
}

function allowedRp(origin, context, where) {
  const isDevelopment = environmentIsDevelopment(context);
  if (!originAllowed(origin, isDevelopment)) {
    console.error('webauthn: origin refused', JSON.stringify({ where, origin: origin ?? null, isDevelopment }));
    return { ok: false, refusal: fail(WEBAUTHN_FAIL.ORIGIN_REFUSED) };
  }
  const rpId = deriveRpId(origin);
  if (!rpId) return { ok: false, refusal: fail(WEBAUTHN_FAIL.UNAVAILABLE) };
  return { ok: true, rpId };
}

function enrolmentKind(kind) {
  return kind === WEBAUTHN_CREDENTIAL_KIND.SYNCED
    ? WEBAUTHN_CREDENTIAL_KIND.SYNCED
    : WEBAUTHN_CREDENTIAL_KIND.DEVICE_BOUND;
}

function selectedEnrolmentShape(kind) {
  return kind === WEBAUTHN_CREDENTIAL_KIND.SYNCED
    ? { residentKey: 'required', hints: null }
    : { residentKey: 'discouraged', hints: PLATFORM_HINTS };
}

function publicKeyCredential(credential) {
  return {
    id: credential.credential_id,
    publicKey: new Uint8Array(Buffer.from(credential.public_key, 'base64')),
    counter: Number(credential.sign_count ?? 0),
    transports: credential.transports ? credential.transports.split(',') : undefined
  };
}

export function createWebAuthnUsecases(deps = {}) {
  const now = deps.now ?? Date.now;
  const store = {
    credentialsFor: deps.credentialsFor ?? credentialsFor,
    credentialFor: deps.credentialFor ?? credentialFor,
    enrolCredential: deps.enrolCredential ?? enrolCredential,
    touchCredential: deps.touchCredential ?? touchCredential,
    issueChallenge: deps.issueWebAuthnChallenge ?? issueWebAuthnChallenge,
    getChallenge: deps.webAuthnChallengeById ?? webAuthnChallengeById,
    consumeChallenge: deps.consumeWebAuthnChallenge ?? consumeWebAuthnChallenge,
    getApprovalChallenge: deps.getApprovalChallenge ?? getApprovalChallenge,
    audit: deps.audit ?? tryAppend
  };
  const simple = {
    generateRegistrationOptions: deps.generateRegistrationOptions ?? generateRegistrationOptions,
    verifyRegistrationResponse: deps.verifyRegistrationResponse ?? verifyRegistrationResponse,
    generateAuthenticationOptions: deps.generateAuthenticationOptions ?? generateAuthenticationOptions,
    verifyAuthenticationResponse: deps.verifyAuthenticationResponse ?? verifyAuthenticationResponse
  };

  async function status({ payload = {}, context = {} } = {}) {
    try {
      const accountId = accountIdOf(context);
      if (!accountId) return fail(WEBAUTHN_FAIL.UNAVAILABLE);
      const creds = await store.credentialsFor(accountId);
      const rp = payload.origin && originAllowed(payload.origin, environmentIsDevelopment(context))
        ? deriveRpId(payload.origin)
        : null;
      const here = rp ? creds.filter(credential => !rpChanged(credential, rp)) : [];
      return {
        ok: true,
        enrolled: creds.length > 0,
        rpId: rp,
        usableHere: rp ? here.length > 0 : null,
        enrolledElsewhere: rp ? creds.length > 0 && here.length === 0 : false,
        devices: creds.map(credential => ({
          credentialId: credential.credential_id,
          label: credential.device_label,
          enrolledAt: Number(credential.enrolled_at),
          lastUsedAt: credential.last_used_at == null ? null : Number(credential.last_used_at),
          synced: Boolean(credential.backup_state),
          usable: rp ? !rpChanged(credential, rp) : null
        }))
      };
    } catch (error) {
      console.error('webauthn: status failed', error);
      return fail(WEBAUTHN_FAIL.UNAVAILABLE);
    }
  }

  async function enrolStart({ payload = {}, context = {} } = {}) {
    try {
      const accountId = accountIdOf(context);
      if (!accountId) return fail(WEBAUTHN_FAIL.UNAVAILABLE);
      const origin = payload.origin;
      const rp = allowedRp(origin, context, 'enrolStart');
      if (!rp.ok) return rp.refusal;

      const existing = (await store.credentialsFor(accountId)).filter(credential => !rpChanged(credential, rp.rpId));
      const requestedKind = enrolmentKind(payload.kind);
      const shape = selectedEnrolmentShape(requestedKind);
      const options = await simple.generateRegistrationOptions({
        rpName: WEBAUTHN_RP_NAME,
        rpID: rp.rpId,
        userID: userHandle(accountId),
        userName: payload.userName ?? accountId,
        userDisplayName: payload.displayName ?? payload.userName ?? 'VAtlassian reviewer',
        attestationType: 'none',
        excludeCredentials: existing.map(credential => ({
          id: credential.credential_id,
          transports: credential.transports ? credential.transports.split(',') : undefined
        })),
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: shape.residentKey,
          userVerification: 'required'
        },
        timeout: WEBAUTHN_CHALLENGE_TTL_MS
      });
      if (shape.hints) options.hints = shape.hints;

      const issuedAt = now();
      const { challengeId, expiresAt } = await store.issueChallenge({
        accountId,
        purpose: WEBAUTHN_PURPOSE.ENROL,
        challenge: options.challenge,
        bindingHash: webauthnBindingHash({ accountId, issueId: null, decision: 'ENROL', contentHash: null }),
        rpId: rp.rpId,
        now: issuedAt
      });
      return { ok: true, challengeId: challengeId.toString('base64'), expiresAt, options };
    } catch (error) {
      console.error('webauthn: enrolStart failed', error);
      return fail(WEBAUTHN_FAIL.UNAVAILABLE);
    }
  }

  async function enrolFinish({ payload = {}, context = {} } = {}) {
    try {
      const accountId = accountIdOf(context);
      if (!accountId) return fail(WEBAUTHN_FAIL.UNAVAILABLE);
      const origin = payload.origin;
      const rp = allowedRp(origin, context, 'enrolFinish');
      if (!rp.ok) return rp.refusal;

      const challengeId = parseBase64Id(payload.challengeId);
      if (!challengeId) return fail(WEBAUTHN_FAIL.CHALLENGE_EXPIRED);
      const row = await store.getChallenge({ challengeId, accountId });
      const usable = challengeUsable(row, now());
      if (!usable.ok) return fail(usable.reason);
      if (row.purpose !== WEBAUTHN_PURPOSE.ENROL) return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);
      const { consumed } = await store.consumeChallenge({ challengeId, accountId, now: now() });
      if (!consumed) return fail(WEBAUTHN_FAIL.CHALLENGE_SPENT);

      let verification;
      try {
        verification = await simple.verifyRegistrationResponse({
          response: payload.response,
          expectedChallenge: row.challenge,
          expectedOrigin: origin,
          expectedRPID: rp.rpId,
          requireUserVerification: true
        });
      } catch (error) {
        console.error('webauthn: registration verification threw', error);
        return fail(WEBAUTHN_FAIL.BAD_SIGNATURE);
      }
      if (!verification.verified || !verification.registrationInfo) return fail(WEBAUTHN_FAIL.BAD_SIGNATURE);

      const info = verification.registrationInfo;
      const { id, publicKey, counter, transports } = info.credential;
      await store.enrolCredential({
        accountId,
        credentialId: id,
        publicKey: Buffer.from(publicKey).toString('base64'),
        signCount: Number(counter ?? 0),
        rpId: rp.rpId,
        origin,
        aaguid: info.aaguid ?? null,
        transports: Array.isArray(transports) ? transports.join(',') : null,
        backupEligible: Boolean(info.credentialBackedUp) || info.credentialDeviceType === 'multiDevice',
        backupState: Boolean(info.credentialBackedUp),
        deviceLabel: payload.deviceLabel ?? null,
        now: now()
      });

      const actualKind = Boolean(info.credentialBackedUp)
        ? WEBAUTHN_CREDENTIAL_KIND.SYNCED
        : WEBAUTHN_CREDENTIAL_KIND.DEVICE_BOUND;
      await store.audit({
        eventType: 'WEBAUTHN_CREDENTIAL_ENROLLED',
        actorAccountId: accountId,
        issueId: null,
        payload: {
          rpId: rp.rpId,
          aaguid: info.aaguid ?? null,
          deviceType: info.credentialDeviceType ?? null,
          backedUp: Boolean(info.credentialBackedUp),
          requestedKind: enrolmentKind(payload.kind),
          actualKind,
          deviceLabel: payload.deviceLabel ?? null
        }
      });
      return { ok: true, enrolled: true, kind: actualKind };
    } catch (error) {
      console.error('webauthn: enrolFinish failed', error);
      return fail(WEBAUTHN_FAIL.UNAVAILABLE);
    }
  }

  async function assertStart({ payload = {}, context = {} } = {}) {
    try {
      const accountId = accountIdOf(context);
      if (!accountId) return fail(WEBAUTHN_FAIL.UNAVAILABLE);
      const origin = payload.origin;
      const rp = allowedRp(origin, context, 'assertStart');
      if (!rp.ok) return rp.refusal;
      const approvalChallengeId = parseHexChallengeId(payload.approvalChallengeId);
      if (!approvalChallengeId) return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);

      const approvalChallenge = await store.getApprovalChallenge(approvalChallengeId);
      if (!approvalChallenge || approvalChallenge.state !== 'PENDING'
          || approvalChallenge.signer_account_id !== accountId
          || Number(approvalChallenge.expires_at) <= now()) {
        return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);
      }

      const allCredentials = await store.credentialsFor(accountId);
      const usableCredentials = allCredentials.filter(credential => !rpChanged(credential, rp.rpId));
      if (usableCredentials.length === 0) {
        return fail(allCredentials.length > 0 ? WEBAUTHN_FAIL.RP_CHANGED : WEBAUTHN_FAIL.NOT_ENROLLED);
      }

      const options = await simple.generateAuthenticationOptions({
        rpID: rp.rpId,
        allowCredentials: usableCredentials.map(credential => ({
          id: credential.credential_id,
          transports: credential.transports ? credential.transports.split(',') : undefined
        })),
        userVerification: 'required',
        timeout: WEBAUTHN_CHALLENGE_TTL_MS
      });
      if (usableCredentials.every(credential => !credential.backup_state)) options.hints = PLATFORM_HINTS;

      const issuedAt = now();
      const { challengeId, expiresAt } = await store.issueChallenge({
        accountId,
        purpose: WEBAUTHN_PURPOSE.ASSERT,
        challenge: options.challenge,
        bindingHash: webauthnBindingHash({
          accountId,
          issueId: approvalChallenge.issue_id,
          decision: approvalChallenge.decision,
          contentHash: approvalChallenge.candidate_hash
        }),
        issueId: approvalChallenge.issue_id,
        approvalChallengeId: approvalChallenge.challenge_id,
        rpId: rp.rpId,
        now: issuedAt
      });

      return { ok: true, challengeId: challengeId.toString('base64'), expiresAt, options };
    } catch (error) {
      console.error('webauthn: assertStart failed', error);
      return fail(WEBAUTHN_FAIL.UNAVAILABLE);
    }
  }

  async function verifyAssertion({ binding, approvalChallengeId = null, payload = {}, context = {} } = {}) {
    try {
      const accountId = binding?.accountId ?? accountIdOf(context);
      if (!accountId || binding?.accountId !== accountId) return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);
      const origin = payload.origin;
      const rp = allowedRp(origin, context, 'assertFinish');
      if (!rp.ok) return rp.refusal;
      const challengeId = parseBase64Id(payload.challengeId);
      if (!challengeId) return fail(WEBAUTHN_FAIL.CHALLENGE_EXPIRED);

      const row = await store.getChallenge({ challengeId, accountId });
      const usable = challengeUsable(row, now());
      if (!usable.ok) return fail(usable.reason);
      if (row.purpose !== WEBAUTHN_PURPOSE.ASSERT) return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);

      const presentedBinding = webauthnBindingHash(binding);
      if (row.binding_hash !== presentedBinding) return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);
      // The binding hash covers issue, decision and content but not the
      // transition or meaning the signer was shown; two approval challenges on
      // one item can share all three. assertStart recorded which challenge this
      // check was collected for, and only that one may spend it.
      if (!approvalChallengeId || !row.approval_challenge_id
          || !Buffer.from(row.approval_challenge_id).equals(Buffer.from(approvalChallengeId))) {
        return fail(WEBAUTHN_FAIL.BINDING_MISMATCH);
      }

      const { consumed } = await store.consumeChallenge({ challengeId, accountId, now: now() });
      if (!consumed) return fail(WEBAUTHN_FAIL.CHALLENGE_SPENT);

      const credential = await store.credentialFor({ accountId, credentialId: payload.response?.id });
      if (!credential) return fail(WEBAUTHN_FAIL.UNKNOWN_CREDENTIAL);
      if (rpChanged(credential, rp.rpId)) return fail(WEBAUTHN_FAIL.RP_CHANGED);

      let verification;
      try {
        verification = await simple.verifyAuthenticationResponse({
          response: payload.response,
          expectedChallenge: row.challenge,
          expectedOrigin: origin,
          expectedRPID: rp.rpId,
          credential: publicKeyCredential(credential),
          requireUserVerification: true
        });
      } catch (error) {
        console.error('webauthn: authentication verification threw', error);
        verification = { verified: false, authenticationInfo: null };
      }

      const info = verification.authenticationInfo ?? {};
      const verdict = acceptWebAuthnAssertion({
        verified: Boolean(verification.verified),
        userVerified: Boolean(info.userVerified),
        userPresent: Boolean(verification.verified),
        backupState: Boolean(info.credentialBackedUp ?? credential.backup_state),
        storedCount: credential.sign_count,
        presentedCount: Number(info.newCounter ?? 0),
        expectedBinding: row.binding_hash,
        presentedBinding
      });
      if (!verdict.ok) {
        await store.audit({
          eventType: 'WEBAUTHN_AUTH_FAILED',
          actorAccountId: accountId,
          issueId: binding?.issueId ?? row.issue_id ?? null,
          payload: { reason: verdict.reason, rpId: rp.rpId }
        });
        return fail(verdict.reason);
      }

      await store.touchCredential({
        credentialRowId: credential.credential_row_id,
        signCount: Number(info.newCounter ?? 0),
        now: now()
      });

      return {
        ok: true,
        credentialId: credential.credential_id,
        assertionAssurance: verdict.assertionAssurance ?? WEBAUTHN_ASSERTION_ASSURANCE.DEVICE_BOUND_UV,
        rpId: rp.rpId,
        origin,
        verifiedAt: now()
      };
    } catch (error) {
      console.error('webauthn: verifyAssertion failed', error);
      return fail(WEBAUTHN_FAIL.UNAVAILABLE);
    }
  }

  return { status, enrolStart, enrolFinish, assertStart, verifyAssertion };
}

export function defineWebAuthnResolvers(resolver) {
  const usecases = createWebAuthnUsecases();
  resolver.define('webauthn:status', ({ payload, context }) => usecases.status({ payload, context }));
  resolver.define('webauthn:enrolStart', ({ payload, context }) => usecases.enrolStart({ payload, context }));
  resolver.define('webauthn:enrolFinish', ({ payload, context }) => usecases.enrolFinish({ payload, context }));
  resolver.define('webauthn:assertStart', ({ payload, context }) => usecases.assertStart({ payload, context }));
}

export async function verifyAssertionForApproval(args) {
  return createWebAuthnUsecases().verifyAssertion(args);
}
