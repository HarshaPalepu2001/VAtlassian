/**
 * Group the parent's review by changed work item, with separate structural
 * changes. Each child is compared with its own latest baseline.
 * See spec 2026-09-24 section 4.5.
 *
 * Use the group metadata from reviewDiff.js after applying the viewer's
 * visibility filter. Omit unchanged children and never name hidden issues.
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
