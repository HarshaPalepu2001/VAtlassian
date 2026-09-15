import { diffIssue } from '../diff/index.js';
import { timeline } from '../changelog.js';

/**
 * Adapt the aggregate tree comparison to the review workspace's field diff
 * contract. Tree capture and approval remain structural; this is only the
 * reviewer-facing projection used by drift:getDiff, panel evidence, and the
 * optional report. Keeping it separate means the approval path never treats a
 * display projection as authority.
 */
export function treeReviewDiff({ baseline, baselineTree, currentTree, treeDiff, controlledFields,
  changelogEntries = [], changelogUnavailable = false, changelogTruncated = false }) {
  const fields = [];
  const baselineById = new Map((baselineTree?.nodes ?? []).map(node => [node.logicalNodeId, node]));
  const currentById = new Map((currentTree?.nodes ?? []).map(node => [node.logicalNodeId, node]));

  for (const change of treeDiff?.changes ?? []) {
    const base = baselineById.get(change.logicalNodeId);
    const current = currentById.get(change.logicalNodeId);
    const nodeName = current?.issueKey ?? base?.issueKey ?? `node ${String(change.logicalNodeId).slice(0, 8)}`;

    if (change.kind === 'FIELD_CHANGED') {
      const isRoot = String(base?.originalIssueId ?? base?.currentIssueId ?? base?.id ?? '')
        === String(baseline?.issue_id ?? '');
      const nodeDiff = diffIssue({
        baseline: {
          ...baseline,
          field_digests: JSON.stringify(base?.digests ?? {})
        },
        baselineValues: baselineTree?.values?.[change.logicalNodeId] ?? {},
        currentFields: currentTree?.values?.[change.logicalNodeId] ?? {},
        controlledFields,
        driftRows: [],
        // This resolver reads the root issue's changelog. Do not apply those
        // authors to a descendant that changed the same field.
        changelogEntries: isRoot ? changelogEntries : []
      });
      const changedIds = new Set((change.fields ?? []).map(String));
      for (const field of nodeDiff.fields.filter(item => changedIds.has(String(item.fieldId)))) {
        fields.push({
          ...field,
          fieldId: `${change.logicalNodeId}:${field.fieldId}`,
          fieldName: `${nodeName} · ${field.fieldName}`,
          driftIds: [],
          attributionStatus: isRoot
            ? (changelogUnavailable ? 'UNAVAILABLE' : 'AVAILABLE')
            : 'NOT_COLLECTED'
        });
      }
      continue;
    }

    const labels = {
      NODE_ADDED: 'Added node',
      NODE_REMOVED: 'Removed node',
      NODE_MOVED: 'Moved node'
    };
    const label = labels[change.kind] ?? 'Tree structure changed';
    const before = change.kind === 'NODE_ADDED' ? null
      : change.kind === 'NODE_MOVED' ? (change.from ?? '(root)') : nodeName;
    const after = change.kind === 'NODE_REMOVED' ? null
      : change.kind === 'NODE_MOVED' ? (change.to ?? '(root)') : nodeName;
    fields.push({
      fieldId: `tree:${change.kind}:${change.logicalNodeId}`,
      fieldName: `${label} · ${nodeName}`,
      kind: 'scalar',
      materiality: 'MAJOR',
      retained: true,
      restorable: 'SPECIAL',
      semanticChange: true,
      before,
      after,
      ops: [{ op: 'delete', text: String(before ?? '(none)') }, { op: 'insert', text: String(after ?? '(none)') }],
      summary: `${label} in the governed tree`,
      magnitude: 1,
      driftIds: [],
      attributionStatus: 'NOT_COLLECTED',
      occurrences: 0
    });
  }

  return {
    issueId: baseline?.issue_id ?? null,
    baselineId: baseline?.baseline_id ?? null,
    baselineVersion: baseline?.version ?? null,
    baselineAt: baseline?.transition_at ?? null,
    approvedBy: baseline?.approved_by ?? null,
    approvedName: baseline?.approved_name ?? null,
    fidelity: baseline?.fidelity ?? null,
    fields,
    changedFieldCount: fields.length,
    materialFieldCount: fields.filter(field => field.semanticChange && field.materiality !== 'COSMETIC').length,
    maxMateriality: fields.length ? 'MAJOR' : null,
    timeline: timeline(changelogEntries, controlledFields.map(field => field.field_id)),
    historyUnavailable: changelogUnavailable,
    historyTruncated: changelogTruncated,
    evidenceHash: null
  };
}
