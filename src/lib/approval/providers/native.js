export function getLevel() { return 'NATIVE_TRANSITION'; }
export function describe() { return { id: 'native', level: getLevel(), configured: true, label: 'Confirm approval' }; }
export async function verify({ binding, confirmed }) {
  if (confirmed !== true || !binding?.accountId || !binding.issueId || !binding.contentHash) {
    return { ok: false, reason: 'CONFIRMATION_REQUIRED' };
  }
  return { ok: true, level: getLevel(), providerId: 'native', providerRef: null,
    evidence: { method: 'SESSION_CONFIRMATION', binding: { ...binding } } };
}
