export function getLevel() { return 'JSM_APPROVAL'; }
export function describe() { return { id: 'jsm', level: getLevel(), configured: false, label: 'Integration not configured' }; }
export async function verify() { return { ok: false, reason: 'NOT_CONFIGURED', level: getLevel() }; }
