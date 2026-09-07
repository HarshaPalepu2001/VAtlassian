export function getLevel() { return 'BIOMETRIC'; }
export function describe() { return { id: 'biometric', level: getLevel(), configured: false, label: 'Integration not configured' }; }
export async function verify() { return { ok: false, reason: 'NOT_CONFIGURED', level: getLevel() }; }
