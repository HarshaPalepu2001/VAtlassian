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
 * Minimum assurance for every controlled change, including rejection restores.
 * va_controlled_transition.required_assurance may raise this level, never lower
 * it. NATIVE_TRANSITION accepts session confirmation without a signature and
 * therefore cannot satisfy the minimum. Changing the minimum requires a code
 * change with a change-control record, rather than a setting.
 */
export const MINIMUM_ASSURANCE = ASSURANCE_LEVEL.ESIGNATURE;

/** The stronger of the configured policy and the floor. Unknown input fails to the floor. */
export function effectiveAssurance(required) {
  if (!isAssuranceLevel(required)) return MINIMUM_ASSURANCE;
  return meetsAssurance(required, MINIMUM_ASSURANCE) ? required : MINIMUM_ASSURANCE;
}

/**
 * Validate the exact configured authentication method for a controlled transition.
 * Throw unless the choice is explicitly ESIGNATURE or BIOMETRIC; unlike
 * effectiveAssurance(), do not raise a weaker choice automatically. Use this
 * for admin validation and provider selection at challenge/submit time, never
 * in the gate or for uncontrolled-transition rows.
 */
export function controlledAuthenticationMethod(required) {
  if (required === ASSURANCE_LEVEL.ESIGNATURE || required === ASSURANCE_LEVEL.BIOMETRIC) return required;
  throw new Error(`Controlled transitions require an explicit ESIGNATURE or BIOMETRIC policy; got: ${required}`);
}
