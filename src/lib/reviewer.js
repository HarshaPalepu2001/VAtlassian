import { executeQuery } from './db.js';
import { ELIGIBILITY_PREDICATE, eligibilityParams } from './eligibility.js';

/**
 * Determine decision authority and worklist assignment separately.
 *
 * Eligibility checks whether a person may decide on an item. Every decision
 * uses lib/eligibility.js's predicate against va_eligibility.
 *
 * Assignment selects one worklist owner. It neither grants nor limits signing
 * authority: another eligible colleague may act while the owner is on leave.
 * Deriving authority from assignment would incorrectly block that colleague;
 * deriving a single owner from all eligible people could leave ownership unclear.
 */

const ACTIVE = 'ACTIVE';

/**
 * Read reviewer authority only from va_eligibility. Do not add another grant
 * table or probe another app's schema within the validator's time budget.
 */
async function baselineEligibility(scope) {
  const result = await executeQuery(
    `SELECT 1 AS ok FROM va_eligibility WHERE ${ELIGIBILITY_PREDICATE} LIMIT 1`,
    eligibilityParams(scope)
  );
  if (!result.result) throw result.error;
  return result.data.length > 0;
}

/**
 * Is this account authorised to decide on this work item?
 *
 * FAILS CLOSED. Any error propagates to the caller, which denies. An
 * authorisation check that returns "probably yes" when the database is
 * unreachable is not an authorisation check.
 */
export async function isEligible({ accountId, projectId, issueTypeId, role }) {
  if (!accountId || !role) return false;
  const scope = { accountId, issueTypeId: String(issueTypeId), role, state: ACTIVE, projectId };
  return baselineEligibility(scope);
}

/**
 * Check whether anybody holds the required role for this issue type.
 * Call only after denying authority to choose a useful refusal. Keep this
 * extra query off the validator's allow path.
 */
export async function anyReviewerHolds({ issueTypeId, role }) {
  const own = await executeQuery(
    `SELECT 1 AS ok FROM va_eligibility
     WHERE (issue_type_id = ? OR issue_type_id = '*') AND role = ? AND state = ? LIMIT 1`,
    [String(issueTypeId), role, ACTIVE]
  );
  if (!own.result) throw own.error;
  return own.data.length > 0;
}

/**
 * Read all active grants for one account across projects to populate its
 * worklist. Return rows for rowAuthorises, the in-memory equivalent of
 * ELIGIBILITY_PREDICATE, rather than implementing another authority rule.
 */
export async function grantsFor(accountId) {
  if (!accountId) return [];
  const own = await executeQuery(
    `SELECT account_id, project_id, issue_type_id, role, state
     FROM va_eligibility
     WHERE account_id = ? AND state = ?`,
    [accountId, ACTIVE]
  );
  if (!own.result) throw own.error;
  return own.data;
}

/**
 * Everyone authorised for this item, for the panel's "who can decide" line.
 *
 * Shown because a reviewer who cannot decide today needs to know who can, and
 * because a reviewer looking at somebody else's item should be able to see
 * whose it is without opening the admin console.
 */
export async function eligibleReviewers({ projectId, issueTypeId, role }) {
  const own = await executeQuery(
    `SELECT account_id, display_name FROM va_eligibility
     WHERE (issue_type_id = ? OR issue_type_id = '*') AND role = ? AND state = ?
       AND (project_id = ? OR project_id IS NULL)`,
    [String(issueTypeId), role, ACTIVE, projectId == null ? null : String(projectId)]
  );
  if (!own.result) return [];
  // Deduped: one person can hold both a '*' grant and a grant naming this issue
  // type, and appearing twice in "who can decide" reads as a data error.
  const seen = new Map();
  for (const r of own.data) {
    if (!seen.has(r.account_id)) seen.set(r.account_id, { accountId: r.account_id, displayName: r.display_name });
  }
  return [...seen.values()];
}

/**
 * Choose one worklist owner without granting signing authority.
 * Prefer the previous approver, then the configured reviewer field, then a
 * deterministically selected eligible reviewer. Do not fall back to the
 * assignee, who may have made the edits. Leave items without eligible
 * reviewers unassigned and report a configuration gap in the admin console.
 */
export async function assignReviewer({ baseline, issueFields, projectId, issueTypeId, role, reviewerFieldId = null }) {
  const candidates = await eligibleReviewers({ projectId, issueTypeId, role });
  if (candidates.length === 0) return { accountId: null, displayName: null, reason: 'NO_ELIGIBLE_REVIEWER' };

  const eligibleIds = new Set(candidates.map((c) => c.accountId));

  if (baseline?.approved_by && eligibleIds.has(baseline.approved_by)) {
    return {
      accountId: baseline.approved_by,
      displayName: baseline.approved_name ?? null,
      reason: 'APPROVER'
    };
  }

  if (reviewerFieldId) {
    const field = issueFields?.[reviewerFieldId];
    const accountId = Array.isArray(field) ? field[0]?.accountId : field?.accountId;
    if (accountId && eligibleIds.has(accountId)) {
      const named = Array.isArray(field) ? field[0] : field;
      return { accountId, displayName: named?.displayName ?? null, reason: 'REVIEWER_FIELD' };
    }
  }

  // Sort and choose the first reviewer so reconciliation keeps the item in
  // the same queue.
  const sorted = [...candidates].sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { accountId: sorted[0].accountId, displayName: sorted[0].displayName, reason: 'FIRST_ELIGIBLE' };
}
