/**
 * Define reviewer eligibility through one predicate over va_eligibility.
 *
 * Use the same authority check for decision permission, role membership and
 * worklist routing. resolvers/panel.js checks it before recording a decision;
 * gate.js checks it before consuming one.
 *
 * A project-scoped grant authorizes only its named project. Only an explicit
 * site-wide grant, project_id IS NULL, applies across projects. The predicate
 * is project_id = ? OR project_id IS NULL; a missing match never grants access.
 *
 * Keep the SQL predicate here so signing and consumption use identical rules.
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
  // A null project means an explicit site-wide grant. Other grants match only
  // the named project.
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
