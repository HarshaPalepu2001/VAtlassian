/** The only assurance ordering. Unknown values NEVER satisfy a policy. */
export const ASSURANCE_LEVEL = Object.freeze({
  NATIVE_TRANSITION: 'NATIVE_TRANSITION', JSM_APPROVAL: 'JSM_APPROVAL',
  ESIGNATURE: 'ESIGNATURE', BIOMETRIC: 'BIOMETRIC'
});
const order = Object.values(ASSURANCE_LEVEL);
export function isAssuranceLevel(level) { return order.includes(level); }
export function meetsAssurance(obtained, required) {
  return isAssuranceLevel(obtained) && isAssuranceLevel(required) && order.indexOf(obtained) >= order.indexOf(required);
}
export const assuranceMeets = meetsAssurance;
export function describeAssurance(level) {
  return ({ NATIVE_TRANSITION: 'Confirmed workflow approval', JSM_APPROVAL: 'Jira Service Management approval',
    ESIGNATURE: 'Electronic signature with authenticator', BIOMETRIC: 'Biometric electronic signature' })[level] ?? 'Unknown assurance';
}
