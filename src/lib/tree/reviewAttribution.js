import { groupReview } from './groupedReview.js';

/** Add collector evidence for changed descendants without claiming sweep time was edit time. */
export function withStoredAttribution(reviewDiff, driftRows = []) {
  if (!reviewDiff?.fields?.length || !driftRows.length) return reviewDiff;
  const byField = new Map();
  for (const row of driftRows) {
    const key = `${row.issue_id}:${row.baseline_version}:${row.field_id}`;
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key).push(row);
  }
  const fields = reviewDiff.fields.map(field => {
    const group = field.group;
    if (group?.kind !== 'ISSUE' || group.isRoot || !group.issueId || !group.baselineVersion) return field;
    const rawFieldId = field.rawFieldId ?? String(field.fieldId).slice(String(group.logicalNodeId ?? '').length + 1);
    const rows = (byField.get(`${group.issueId}:${group.baselineVersion}:${rawFieldId}`) ?? [])
      .sort((a, b) => Number(a.occurred_at) - Number(b.occurred_at));
    if (!rows.length) return field;
    const detected = row => ['SWEEP', 'RECONCILE'].includes(row.detected_via) && !row.changelog_id;
    const confirmed = rows.filter(row => !detected(row));
    const last = confirmed.at(-1);
    return { ...field, attributionStatus: 'AVAILABLE',
      attribution: rows.map(row => ({
        at: Number(row.occurred_at), authorId: row.actor_account_id ?? null,
        authorName: row.actor_name ?? null, source: row.source ?? 'UNKNOWN',
        detected: detected(row),
        fromString: row.from_repr ?? null, toString: row.to_repr ?? null
      })),
      driftIds: rows.map(row => row.key).filter(Boolean),
      occurrences: confirmed.length,
      firstChangedAt: confirmed.length ? Number(confirmed[0].occurred_at) : null,
      lastChangedAt: last ? Number(last.occurred_at) : null,
      lastChangedBy: last?.actor_name ?? null
    };
  });
  return { ...reviewDiff, fields, ...(reviewDiff.groups ? { groups: groupReview(fields) } : {}) };
}
