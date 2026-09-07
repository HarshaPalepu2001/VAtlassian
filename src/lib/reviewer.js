import { executeQuery } from './db.js';
import { ELIGIBILITY_PREDICATE, eligibilityParams } from './eligibility.js';

/**
 * Who may approve, and who is on the hook for a particular work item.
 *
 * TWO DIFFERENT QUESTIONS, and conflating them is a mistake worth naming:
 *
 *   ELIGIBILITY — "is this person authorised to decide on this item?" This is
 *   an authority check and it gates every decision. It is answered by
 *   lib/eligibility.js's predicate against va_eligibility.
 *
 *   ASSIGNMENT — "whose queue does this item appear in?" This is routing. It
 *   picks ONE person so the item has an owner, and being that person is neither
 *   necessary nor sufficient for eligibility. An item assigned to a reviewer on
 *   leave must still be decidable by their colleague.
 *
 * Getting this backwards produces the two classic failures: a queue nobody owns
 * because assignment was derived from eligibility and matched six people, or an
 * item only its assigned reviewer can act on because eligibility was derived
 * from assignment.
 */

const ACTIVE = 'ACTIVE';

/**
 * va_eligibility IS THE ONLY SOURCE OF REVIEWER AUTHORITY.
 *
 * There is deliberately no second table and no probe into another app's schema.
 * Two places to grant authority is how a customer ends up with someone who may
 * approve one thing and not the near-identical thing beside it — and inside a
 * ~10s validator budget, a speculative query against a table that is not there
 * is a round trip spent to learn nothing.
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
 * Does ANYBODY hold this role for this issue type?
 *
 * Asked only on the deny path, and only to choose which refusal to show. "You
 * need to approve this" and "nobody alive can approve this" send a person to
 * opposite places, and collapsing them produces a deny loop with no exit — the
 * reviewer is told to go and approve, cannot, and tries again forever.
 *
 * The lookup is on the DENY path deliberately, never beside the main config
 * read: it is a serial round trip inside a ~10s validator budget, it is needed
 * only to pick a sentence, and running it eagerly would bill it to every gated
 * transition including the allow path — already the longest one.
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
 * Every ACTIVE grant this one account holds, across every project.
 *
 * THE REVIEW PAGE'S FIRST QUERY, and the one that decides its shape. The page
 * has to answer "what is waiting on me anywhere", which is the opposite
 * direction from every other lookup in this file: those start from a work item
 * and ask whether a person is authorised; this starts from the person and asks
 * which work items could possibly qualify.
 *
 * Returned as raw rows rather than a boolean because the caller feeds them to
 * rowAuthorises() — the in-memory twin of ELIGIBILITY_PREDICATE — once per
 * candidate issue. Re-deriving authority in a second spelling for the sake of
 * the queue is exactly what lib/eligibility.js's header forbids.
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
 * Pick the ONE reviewer whose queue this item goes into.
 *
 * ROUTING, NOT AUTHORITY. The order below is a deliberate preference list, and
 * each step exists because the one before it can legitimately produce nobody:
 *
 *   1. The person who approved it. They have the context, they made the call,
 *      and they are the natural person to ask whether their approval still
 *      stands. This is the answer in the overwhelming majority of cases.
 *   2. A dedicated reviewer field, if the project has one. Some teams route
 *      review separately from whoever happened to click the button.
 *   3. Any eligible reviewer, deterministically chosen. Not random: the same
 *      item must land in the same person's queue every time it is recomputed,
 *      or a reconcile pass would silently move work between people.
 *
 * NEVER falls back to the assignee. The assignee is usually the person who made
 * the changes, and asking somebody to review their own edits is not a review.
 * An item with no eligible reviewer stays unassigned and shows up in the admin
 * console as a configuration gap — which is what it is.
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

  // Deterministic: sorted, first. Stable across recomputation, which matters
  // more than fairness here — an item that moves between queues every time the
  // reconcile job runs is worse than one that always lands on the same desk.
  const sorted = [...candidates].sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { accountId: sorted[0].accountId, displayName: sorted[0].displayName, reason: 'FIRST_ELIGIBLE' };
}
