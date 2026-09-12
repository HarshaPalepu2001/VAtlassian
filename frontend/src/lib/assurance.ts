export type AssuranceLevel = 'NATIVE_TRANSITION' | 'JSM_APPROVAL' | 'ESIGNATURE' | 'BIOMETRIC';
export const ASSURANCE_LABELS: Record<AssuranceLevel, string> = {
  NATIVE_TRANSITION: 'Workflow approval', JSM_APPROVAL: 'JSM approval', ESIGNATURE: 'Electronic signature', BIOMETRIC: 'Biometric approval'
};
export function assuranceLabel(level?: string | null) { return level && level in ASSURANCE_LABELS ? ASSURANCE_LABELS[level as AssuranceLevel] : 'Authentication not recorded'; }
export type ApprovalMode = 'confirm' | 'totp' | 'biometric' | 'unavailable';

/**
 * The two assurance levels an admin may configure on a controlled transition.
 * Only ESIGNATURE and BIOMETRIC are valid at creation time; NATIVE_TRANSITION
 * and JSM_APPROVAL are legacy / uncontrolled-transition levels that the server
 * rejects via controlledAuthenticationMethod(). ASSURANCE_LABELS is kept
 * intact so AssuranceChip and other read-only callers can still display an
 * existing row that carries a legacy value.
 */
export const CONTROLLED_TRANSITION_ASSURANCE_OPTIONS: { value: AssuranceLevel; label: string }[] = [
  { value: 'ESIGNATURE', label: ASSURANCE_LABELS.ESIGNATURE },
  { value: 'BIOMETRIC', label: ASSURANCE_LABELS.BIOMETRIC },
];

// Mirrors MINIMUM_ASSURANCE and effectiveAssurance() in
// src/lib/approval/levels.js. The server raises any policy weaker than an
// electronic signature to that floor, so a screen that reads the configured
// level literally would refuse an edge the server is willing to sign. These
// two must be changed together.
const ASSURANCE_ORDER: AssuranceLevel[] = ['NATIVE_TRANSITION', 'JSM_APPROVAL', 'ESIGNATURE', 'BIOMETRIC'];
export const MINIMUM_ASSURANCE: AssuranceLevel = 'ESIGNATURE';
export function effectiveAssurance(level?: string | null): AssuranceLevel {
  const index = ASSURANCE_ORDER.indexOf(level as AssuranceLevel);
  return index >= ASSURANCE_ORDER.indexOf(MINIMUM_ASSURANCE) ? (level as AssuranceLevel) : MINIMUM_ASSURANCE;
}
export function approvalMode(level?: string | null): ApprovalMode {
  return effectiveAssurance(level) === 'BIOMETRIC' ? 'biometric' : 'totp';
}
