/**
 * THE ROLE VOCABULARY. ONE LIST, AND THIS IS IT.
 *
 * A role in this app is a STRING COMPARED BYTE FOR BYTE. lib/eligibility.js
 * matches `role = ?` exactly — no trimming, no case folding, no aliasing — and
 * that is deliberate: an authority check that quietly accepts "reviewer" for
 * "REVIEWER" also quietly accepts whatever else somebody typed.
 *
 * The cost of that strictness is that the two screens which write a role MUST
 * write the same bytes. They did not. The gate screen had a free-text input
 * defaulted to "REVIEWER" and the reviewers screen had a second free-text input
 * defaulted to "REVIEWER", and nothing tied them together. A trailing space in
 * either one produces a configuration that looks completely correct on both
 * screens and denies every transition with NO_ELIGIBLE_REVIEWER — the worst
 * failure shape this app has, because nothing appears broken.
 *
 * So there is no free text anywhere any more. Both screens render a picker from
 * this list, served by `admin:roles`, and every write path validates against it
 * server-side. The frontend cannot invent a role even if somebody edits the
 * request, because the resolver refuses one that is not here.
 *
 * ADDING A ROLE. Add it here and it appears in both pickers on the next deploy.
 * REMOVING ONE IS NOT SAFE: va_eligibility and va_controlled_transition rows already
 * name it, and deleting the entry strands them — the grant still matches the
 * gate, but no admin can read or re-create either. Retire a role by migrating
 * the rows that use it first.
 */

export const ROLE = {
  REVIEWER: 'REVIEWER',
  APPROVER: 'APPROVER',
  QA: 'QA',
  TESTER: 'TESTER'
};

/**
 * What each role is FOR, in the words an admin needs to choose between them.
 *
 * The help text is here rather than in the component because the same sentence
 * has to appear on the gate screen and the People screen — an admin who reads
 * one description when granting and a different one when gating has been given
 * two different ideas of what they just configured.
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
 * The value to store, or null.
 *
 * RETURNS NULL RATHER THAN FALLING BACK TO THE DEFAULT. A save that silently
 * rewrites an unrecognised role as REVIEWER grants authority the admin did not
 * ask for; the resolvers refuse the write instead and say so.
 */
export function normaliseRole(value) {
  return isRole(value) ? String(value) : null;
}

export function roleLabel(id) {
  return ROLES.find((r) => r.id === id)?.label ?? String(id ?? '');
}
