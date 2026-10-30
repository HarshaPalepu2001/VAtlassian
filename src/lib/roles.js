/**
 * Define the role names accepted by every configuration screen and write path.
 *
 * lib/eligibility.js compares role strings byte for byte, without trimming,
 * case folding or aliases. Separate free-text inputs previously allowed a
 * trailing space to make otherwise identical grants and transition rules fail
 * with NO_ELIGIBLE_REVIEWER.
 *
 * Both screens now use the picker served by admin:roles, and server-side
 * validation rejects values outside this list, including edited requests.
 *
 * Adding a role here adds it to both pickers on the next deployment. Before
 * removing a role, migrate va_eligibility and va_controlled_transition rows
 * that reference it. Otherwise matching rows remain but administrators cannot
 * read or recreate them through the pickers.
 */

export const ROLE = {
  REVIEWER: 'REVIEWER',
  APPROVER: 'APPROVER',
  QA: 'QA',
  TESTER: 'TESTER'
};

/**
 * Describe each role for the administrator's selector. Keep descriptions
 * beside role definitions so all clients explain the same role names.
 */
export const ROLES = [
  {
    id: ROLE.REVIEWER,
    label: 'Reviewer',
    help: 'Reads the diff and signs the item out of review. The default, and what most gates should ask for.'
  },
  {
    id: ROLE.APPROVER,
    label: 'Approver',
    help: 'A second, narrower authority for gates where sign-off is separated from review.'
  },
  {
    id: ROLE.QA,
    label: 'QA',
    help: 'For workflows where the exit from review is a quality check rather than an editorial one.'
  },
  {
    id: ROLE.TESTER,
    label: 'Tester',
    help: 'Executes test runs and signs them as executed. Used by test-management sign-off chains.'
  }
];

export const ROLE_IDS = ROLES.map((r) => r.id);

/** What a gate and a grant both default to when nobody has chosen. */
export const DEFAULT_ROLE = ROLE.REVIEWER;

export function isRole(value) {
  return ROLE_IDS.includes(String(value ?? ''));
}

/**
 * Return the accepted role value or null. Never replace an unrecognized role
 * with a default during save.
 */
export function normaliseRole(value) {
  return isRole(value) ? String(value) : null;
}

export function roleLabel(id) {
  return ROLES.find((r) => r.id === id)?.label ?? String(id ?? '');
}
