import { WEBAUTHN_FAIL, WEBAUTHN_FAIL_MESSAGE } from '../../webauthn.js';
import { verifyAssertionForApproval } from '../../../usecases/webauthn.js';

export function getLevel() { return 'BIOMETRIC'; }
export function describe() { return { id: 'webauthn', level: getLevel(), configured: true, label: 'Sign with biometric approval' }; }
export async function verify({ binding, confirmed, webauthn, webauthnDeps, context }) {
  if (confirmed !== true) return { ok: false, reason: 'CONFIRMATION_REQUIRED', level: getLevel() };
  const verifier = webauthnDeps?.verifyAssertion ?? verifyAssertionForApproval;
  const result = await verifier({ binding, payload: webauthn, context });
  if (!result?.ok) {
    const reason = result?.reason ?? WEBAUTHN_FAIL.UNAVAILABLE;
    return {
      ok: false,
      reason,
      level: getLevel(),
      error: result?.error ?? WEBAUTHN_FAIL_MESSAGE[reason] ?? WEBAUTHN_FAIL_MESSAGE[WEBAUTHN_FAIL.UNAVAILABLE]
    };
  }
  return {
    ok: true,
    level: getLevel(),
    providerId: 'webauthn',
    providerRef: result.credentialId ?? null,
    evidence: {
      method: 'SESSION_AND_WEBAUTHN',
      verifiedAt: result.verifiedAt,
      assertionAssurance: result.assertionAssurance ?? null,
      rpId: result.rpId ?? null,
      origin: result.origin ?? null,
      credentialId: result.credentialId ?? null,
      binding: { ...binding }
    }
  };
}
