export type AssuranceLevel = 'NATIVE_TRANSITION' | 'JSM_APPROVAL' | 'ESIGNATURE' | 'BIOMETRIC';
export const ASSURANCE_LABELS: Record<AssuranceLevel, string> = {
  NATIVE_TRANSITION: 'Workflow approval', JSM_APPROVAL: 'JSM approval', ESIGNATURE: 'Electronic signature', BIOMETRIC: 'Biometric approval'
};
export function assuranceLabel(level?: string | null) { return level && level in ASSURANCE_LABELS ? ASSURANCE_LABELS[level as AssuranceLevel] : 'Assurance not recorded'; }
export function approvalMode(level: AssuranceLevel) { return level === 'ESIGNATURE' ? 'totp' : level === 'NATIVE_TRANSITION' ? 'confirm' : 'unavailable'; }
