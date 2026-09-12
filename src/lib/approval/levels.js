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

/**
 * The assurance no policy may go below.
 *
 * SERVER-ENFORCED, NOT CONFIGURED. `va_controlled_transition.required_assurance`
 * may raise this; nothing may lower it. NATIVE_TRANSITION's provider accepts a
 * session confirmation with no signature, and this app's whole claim is that a
 * controlled record does not change without one — including on rejection, which
 * rewrites the issue through the restore path.
 *
 * Raising the floor is a code change on purpose: it is the kind of decision
 * that should appear in a change-control record, not in a settings screen.
 */
export const MINIMUM_ASSURANCE = ASSURANCE_LEVEL.ESIGNATURE;

/** The stronger of the configured policy and the floor. Unknown input fails to the floor. */
export function effectiveAssurance(required) {
  if (!isAssuranceLevel(required)) return MINIMUM_ASSURANCE;
  return meetsAssurance(required, MINIMUM_ASSURANCE) ? required : MINIMUM_ASSURANCE;
}

/**
 * The EXACT authentication method configured for a controlled transition.
 *
 * Unlike effectiveAssurance(), this function NEVER silently raises weak levels:
 * it throws for anything that is not an explicit ESIGNATURE or BIOMETRIC choice.
 * Use it to (a) validate admin config — refuse NATIVE_TRANSITION/JSM_APPROVAL/
 * undefined as invalid controlled-transition policies — and (b) dispatch the
 * one exact provider at submit/challenge time. Never use it in the gate or in
 * any code that handles uncontrolled-transition rows.
 */
export function controlledAuthenticationMethod(required) {
  if (required === ASSURANCE_LEVEL.ESIGNATURE || required === ASSURANCE_LEVEL.BIOMETRIC) return required;
  throw new Error(`Controlled transitions require an explicit ESIGNATURE or BIOMETRIC policy; got: ${required}`);
}
