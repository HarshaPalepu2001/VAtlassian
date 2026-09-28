/**
 * AN ISSUE LINK IS ONE OBJECT WITH TWO OWNERS.
 *
 * Jira stores a link once; each end lists it by naming the other. So a restore
 * that re-creates or deletes a link on one work item changes the other one too
 * — and if the other item is itself approved, that change can contradict what
 * its reviewer signed.
 *
 * Found live on 2026-09-25: VAT-15's drift (link to VAT-12 removed) was
 * approved on VAT-15 alone, while VAT-12's approved state still held the link.
 * Rejecting on VAT-10 re-created VAT-12's link, which put it back on VAT-15;
 * the retry restored VAT-15 by deleting it again. Each restore was correct
 * about its own item and wrong about the other, and they undid each other.
 *
 * The rule: a restore changes a link only when the other end's approved state
 * agrees with the result. Otherwise the link is left exactly as it is and the
 * step says why, naming the other item — a decision is needed where both are
 * covered, not a restore that flips the link back and forth.
 */

const typeOf = link => String(link?.type?.id ?? link?.type?.name ?? '');
const ref = issue => String(issue?.id ?? issue?.key ?? '');

/** The other end of a link as this item lists it: which side it is on, and who. */
function otherEnd(link) {
  if (link?.inwardIssue) return { direction: 'inwardIssue', issue: link.inwardIssue };
  if (link?.outwardIssue) return { direction: 'outwardIssue', issue: link.outwardIssue };
  return null;
}

/** A link's identity as the listing item sees it: type, side, other end. */
export function linkKey(link) {
  const end = otherEnd(link);
  return JSON.stringify([typeOf(link), end?.direction ?? null, end ? ref(end.issue) : null]);
}

/**
 * The same Jira link as the OTHER end lists it. "VAT-15 relates to VAT-12"
 * appears on VAT-12 with `inwardIssue: VAT-15` and on VAT-15 with
 * `outwardIssue: VAT-12`: the side flips and the named issue becomes this one.
 */
export function keyAtOtherEnd(link, selfIssueId) {
  const end = otherEnd(link);
  const flipped = end?.direction === 'inwardIssue' ? 'outwardIssue' : 'inwardIssue';
  return JSON.stringify([typeOf(link), flipped, String(selfIssueId)]);
}

/**
 * Which of a restore's link changes the other end's approved state forbids.
 *
 * `approvedLinksOf(issueId)` returns the other item's approved link list, or
 * null when that item has no approved state for links (not governed, or not
 * tracking them) — in which case there is nobody to contradict. It may throw
 * when the item IS governed but its approved links cannot be read; that is
 * left to propagate, because guessing would be the failure this prevents.
 */
export async function findLinkConflicts({ selfIssueId, additions = [], removals = [], approvedLinksOf }) {
  if (typeof approvedLinksOf !== 'function') return [];
  const conflicts = [];
  for (const [change, links] of [['add', additions], ['remove', removals]]) {
    for (const link of links) {
      const end = otherEnd(link);
      if (!end) continue;
      const approved = await approvedLinksOf(ref(end.issue));
      if (approved == null) continue;
      const approvedHere = new Set(approved.map(linkKey)).has(keyAtOtherEnd(link, selfIssueId));
      if (change === 'add' ? !approvedHere : approvedHere) {
        conflicts.push({ change, link, otherIssueId: end.issue?.id ?? null, otherIssueKey: end.issue?.key ?? ref(end.issue) });
      }
    }
  }
  return conflicts;
}

/** One sentence per conflict, naming the other item — what the reviewer reads. */
export function describeLinkConflicts(conflicts) {
  return conflicts.map(c => c.change === 'add'
    ? `Left the link to ${c.otherIssueKey} removed: ${c.otherIssueKey}'s approved state does not have it.`
    : `Left the link to ${c.otherIssueKey} in place: ${c.otherIssueKey}'s approved state has it.`)
    .concat('Decide the link where both work items are covered, so both approvals agree.')
    .join(' ');
}

/**
 * The other end is approved and tracks links, but its approved list was not
 * retained, so there is nothing to check the change against. Refused like a
 * conflict: changing a link nobody can confirm is exactly the guess to avoid.
 */
export function linkStateUnknown(issueRef) {
  const error = new Error(`Left the link to ${issueRef} as it is: ${issueRef} is approved, but its approved links were not retained, so the change cannot be checked against them.`);
  error.name = 'LinkConflictError';
  error.code = 'LINK_CONFLICT';
  error.status = 409;
  error.operation = 'RESTORE_LINKS';
  error.detail = error.message;
  return error;
}

/**
 * The refusal. 409 on purpose: the executor settles a 4xx as this step's own
 * outcome, whereas an error with no status reads as Jira being unreachable and
 * would stop the whole restore to retry a conflict that retrying cannot fix.
 */
export class LinkConflictError extends Error {
  constructor(conflicts) {
    const detail = describeLinkConflicts(conflicts);
    super(detail);
    this.name = 'LinkConflictError';
    this.code = 'LINK_CONFLICT';
    this.status = 409;
    this.operation = 'RESTORE_LINKS';
    this.detail = detail;
    this.conflicts = conflicts;
  }
}
