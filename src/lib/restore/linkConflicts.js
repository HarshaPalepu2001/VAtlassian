import { excludesLink, hydrateLinkPolicyIssue } from '../linkPolicy.js';

/**
 * Jira stores one link shared by both ends. Restoring it on one work item
 * changes the other too. Change a link only if the other end's approved state
 * permits the result. Otherwise leave it unchanged and explain the conflict,
 * naming the other work item. This prevents restores undoing one another.
 * See the 2026-09-25 regression involving VAT-10, VAT-12 and VAT-15.
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
 * Find link changes forbidden by the other end's approved state.
 * approvedLinksOf(issueId) returns null if that item has no governed link
 * state. Propagate read failures for governed items rather than guessing.
 */
export async function findLinkConflicts({ selfIssueId, selfIssue = null, additions = [], removals = [], approvedLinksOf, readIssue }) {
  if (typeof approvedLinksOf !== 'function') return [];
  const conflicts = [];
  for (const [change, links] of [['add', additions], ['remove', removals]]) {
    for (const link of links) {
      const end = otherEnd(link);
      if (!end) continue;
      const approved = await approvedLinksOf(ref(end.issue));
      if (approved == null) continue;
      let links = approved;
      if (!Array.isArray(approved)) {
        const opposite = end.direction === 'inwardIssue' ? 'outwardIssue' : 'inwardIssue';
        const reciprocal = { type: link.type, [opposite]: selfIssue ?? { id: String(selfIssueId) } };
        const authority = await hydrateLinkPolicyIssue({ ...approved.issue,
          fields: { ...approved.issue?.fields, issuelinks: [reciprocal] } }, approved.linkPolicy, readIssue);
        if (excludesLink({ linkPolicy: approved.linkPolicy, issue: authority, link: authority.fields.issuelinks[0] })) continue;
        links = approved.links;
        if (!Array.isArray(links)) throw linkStateUnknown(ref(end.issue));
      }
      const approvedHere = new Set(links.map(linkKey)).has(keyAtOtherEnd(link, selfIssueId));
      if (change === 'add' ? !approvedHere : approvedHere) {
        conflicts.push({ change, link, otherIssueId: end.issue?.id ?? null, otherIssueKey: end.issue?.key ?? ref(end.issue) });
      }
    }
  }
  return conflicts;
}

/** Describe each conflict for the reviewer and name the other work item. */
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
