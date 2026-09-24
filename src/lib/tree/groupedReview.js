/**
 * A PARENT'S REVIEW, GROUPED BY ISSUE.
 *
 * A parent decision covers the parent and every child (spec 2026-09-24 §4.5),
 * so the parent's review shows everything that decision would approve or
 * reject, read as "in this issue, these changed":
 *
 *   the parent, its own changed fields;
 *   structure, children added, removed or moved;
 *   each drifted child, against that child's own latest baseline.
 *
 * Children with no change are not listed. Pure over the review's field list,
 * each field carrying the `group` lib/tree/reviewDiff.js stamped on it, so it
 * can be recomputed after a viewer's visibility filter has removed fields
 * (panelAccess.filterViewableReviewDiff) and never names a hidden issue.
 */
const STRUCTURE = 'STRUCTURE';
const ISSUE = 'ISSUE';

const byKey = (a, b) => String(a.issueKey ?? '').localeCompare(String(b.issueKey ?? ''), undefined, { numeric: true });

export function groupReview(fields) {
  const groups = new Map();
  for (const field of fields ?? []) {
    const group = field.group;
    if (!group) continue;
    const id = group.kind === STRUCTURE ? STRUCTURE : `${ISSUE}:${group.logicalNodeId}`;
    if (!groups.has(id)) {
      groups.set(id, group.kind === STRUCTURE
        ? { kind: STRUCTURE, issueId: null, issueKey: null, summary: null, isRoot: false, baselineVersion: null, fields: [] }
        : { kind: ISSUE, issueId: group.issueId ?? null, issueKey: group.issueKey ?? null, summary: group.summary ?? null,
          isRoot: group.isRoot === true, baselineVersion: group.baselineVersion ?? null, fields: [] });
    }
    groups.get(id).fields.push(field);
  }
  const all = [...groups.values()];
  return [
    ...all.filter(g => g.kind === ISSUE && g.isRoot),
    ...all.filter(g => g.kind === STRUCTURE),
    ...all.filter(g => g.kind === ISSUE && !g.isRoot).sort(byKey)
  ];
}
