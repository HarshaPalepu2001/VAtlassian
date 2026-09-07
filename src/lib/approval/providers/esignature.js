import { verifyTotp } from '../totpVerification.js';
export function getLevel() { return 'ESIGNATURE'; }
export function describe() { return { id: 'totp', level: getLevel(), configured: true, label: 'Sign with authenticator' }; }
export async function verify({ binding, code, totpDeps }) {
  const result = await verifyTotp(binding?.accountId, code, { issueId: binding?.issueId, purpose: 'APPROVAL' }, totpDeps);
  if (!result.ok) return result;
  return { ok: true, level: getLevel(), providerId: 'totp', providerRef: null,
    evidence: { method: 'SESSION_AND_TOTP', verifiedAt: result.verifiedAt, binding: { ...binding } } };
}
