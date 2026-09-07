/**
 * REVIEWER ELIGIBILITY.
 *
 * ONE PREDICATE, ONE TABLE. Every authority question in this app —
 * "may this person decide?", "does anybody hold this role?", "who should this
 * item queue to?" — is this predicate against `va_eligibility`. Authority
 * expressed in two places is how a customer ends up with a person who may
 * approve one thing and not the near-identical thing beside it, a distinction
 * nobody asked for and nobody can explain.
 *
 * A PROJECT-SCOPED GRANT NEVER WIDENS. Holding a role on project 10001 says
 * nothing about 10002. Only an explicit site-wide grant (project_id IS NULL)
 * crosses projects, which is why the predicate is
 * `project_id = ? OR project_id IS NULL` and never a fallback that treats an
 * absent match as permission.
 *
 * PURE, AND EXPRESSED ONCE. The predicate exists here as SQL so the checking
 * sites — resolvers/panel.js before recording a decision, and gate.js before
 * consuming one — cannot drift apart. Two spellings of "is this person
 * authorised" would eventually disagree, and the disagreement would show up as
 * a decision that could be created but never used.
 */

/**
 * The WHERE fragment every call site shares. Parameters, in order:
 * account_id, issue_type_id, role, state, project_id.
 *
 * `issue_type_id = '*'` IS A REAL WILDCARD, matching how the console grants:
 * a reviewer is almost always trusted across a project's issue types, and being
 * eligible for a Story but not the Bug beside it is a distinction nobody asks
 * for. A grant naming one issue type still binds to that type only.
 */
export const ELIGIBILITY_PREDICATE =
  "account_id = ? AND (issue_type_id = ? OR issue_type_id = '*') AND role = ? AND state = ? "
  + 'AND (project_id = ? OR project_id IS NULL)';

/** Bind values for ELIGIBILITY_PREDICATE, in the order it expects. */
export function eligibilityParams({ accountId, issueTypeId, role, state, projectId }) {
  return [accountId, issueTypeId, role, state, projectId == null ? null : String(projectId)];
}

/**
 * Does one eligibility row authorise reviewing this work item?
 *
 * The in-memory twin of the SQL predicate, for tests and for any caller that
 * already holds the rows. Kept beside the SQL on purpose: if one changes and
 * the other does not, the tests fail rather than production drifting.
 */
export function rowAuthorises(row, { projectId, issueTypeId, role, activeState = 'ACTIVE' }) {
  if (!row) return false;
  if (row.state !== activeState) return false;
  if (String(row.role) !== String(role)) return false;
  // '*' is a grant across every issue type; anything else must match exactly.
  if (String(row.issue_type_id) !== '*' && String(row.issue_type_id) !== String(issueTypeId)) return false;
  // NULL project is a site-wide grant. Anything else must match exactly —
  // a project-scoped grant never widens to another project.
  if (row.project_id == null) return true;
  return String(row.project_id) === String(projectId);
}

/** Is anyone in this set authorised? */
export function anyAuthorises(rows, scope) {
  return (rows ?? []).some((row) => rowAuthorises(row, scope));
}

/** How a grant should read in the console. */
export function describeScope(row, projectName) {
  if (!row || row.project_id == null) return 'All projects';
  return projectName ? `${projectName} only` : `Project ${row.project_id} only`;
}
