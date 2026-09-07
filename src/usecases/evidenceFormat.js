export function describeEvent(row, { statusName = () => null } = {}) {
 const p = row.payload ?? {};
 const event = String(row.event_type ?? 'UNKNOWN');
 const label = event.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
 const flow = [statusName(p.fromStatusId), statusName(p.toStatusId)].filter(Boolean).join(' → ');
 return {
  label,
  tone: /BROKEN|DENIED|REJECTED|LOCKED/.test(event) ? 'danger' : /APPROVED|CONSUMED|VERIFIED/.test(event) ? 'success' : 'neutral',
  detail: [p.meaning, p.role, flow, p.reason].filter(Boolean).join(' — ') || null,
  explanation: p.detail ?? null
 };
}
