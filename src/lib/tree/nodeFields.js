import { RULE_SOURCE } from '../evidence/versionEvidence.js';

/**
 * Track every node with the root's Controlled Fields, including attachments.
 * This rule was decided on 2026-09-25, replacing per-issue-type tracking.
 * Under the earlier rule, children of an unconfigured type tracked no fields.
 *
 * scopeKey and nodeScope still identify an item's own scope for single items
 * not governed by a tree. See fieldsForItem.
 */
export const scopeKey = (projectId, issueTypeId) => `${Number(projectId)}:${String(issueTypeId)}`;

export function nodeScope(node) {
  return {
    projectId: Number(node?.fields?.project?.id ?? node?.projectId),
    issueTypeId: String(node?.fields?.issuetype?.id ?? node?.issueTypeId ?? '')
  };
}

/**
 * Read a tree once with the root's fields for every node. Keep fieldsFor(node)
 * as the shared interface for capture, collection, panel reads and restores.
 */
export async function readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey, rootFields, extraFieldIds = [] }) {
  const fieldIds = [...new Set([...rootFields.map(f => f.field_id), ...extraFieldIds, 'project', 'issuetype'])];
  const { tree } = await readStableTree({ readTree, rootIssueKey, fieldIds });
  return { tree, fieldsFor: () => rootFields };
}

/**
 * Resolve tracked fields for single-item drift, panel reads, evidence hashes
 * and restores. Items covered by other approved roots use the most recently
 * approved root's fields, even if they have their own baseline. Roots with no
 * governing ancestor and uncovered items use their own fields.
 *
 * Do not rely only on captured_by_baseline_id. A child's drift decision
 * re-baselines it without that link but does not change its governing scope.
 * If an older root lacks scope columns, fall back to the item's own fields.
 */
export async function scopeForItem({ issueId, projectId, issueTypeId }, deps) {
  const roots = await deps.activeRootsForNode(Number(issueId));
  // A root covering this item from above governs it even once the item has a
  // baseline of its own. A covered child signs under that root's fields and the
  // capture its signature triggers makes it a root too; moving it to its own
  // issue type at that moment gave the validator a different field set than the
  // one just signed (found live 2026-10-12: VAT-59, VAT-68, VAT-69).
  const governing = roots
    .filter(root => Number(root.rootIssueId) !== Number(issueId) && root.projectId != null && root.issueTypeId != null)
    .sort((a, b) => Number(b.capturedAt ?? 0) - Number(a.capturedAt ?? 0))[0];
  if (!governing) {
    const isRoot = roots.some(root => Number(root.rootIssueId) === Number(issueId));
    return { projectId, issueTypeId, source: 'own', rootIssueId: isRoot ? Number(issueId) : null };
  }
  return { projectId: Number(governing.projectId), issueTypeId: String(governing.issueTypeId),
    source: 'governing-root', rootIssueId: Number(governing.rootIssueId),
    rootBaselineId: governing.baselineId ?? null, rootVersion: governing.version ?? null };
}

/**
 * The fields an item tracks AND the rule scope they came from, from one
 * lookup: a capture records which rule required its fields
 * (docs/specs/2026-10-03-baseline-evidence-model-design.md §4). Fields held to
 * a governing root are recorded as INHERITED from that root's version.
 */
export async function fieldScope(item, deps) {
  const scope = await scopeForItem(item, deps);
  const fields = await deps.controlledFields({ projectId: scope.projectId, issueTypeId: scope.issueTypeId });
  const inherited = scope.source === 'governing-root';
  return {
    fields,
    ruleScope: {
      source: inherited ? RULE_SOURCE.INHERITED : RULE_SOURCE.OWN,
      projectId: Number(scope.projectId),
      issueTypeId: String(scope.issueTypeId),
      imposedByBaselineId: inherited ? scope.rootBaselineId : null,
      imposedByVersion: inherited && scope.rootVersion != null ? Number(scope.rootVersion) : null
    }
  };
}

export async function fieldsForItem(item, deps) {
  return (await fieldScope(item, deps)).fields;
}

/** Field ids a set of nodes tracks between them: what a verification read must fetch. */
export function unionFieldIds(nodes, fieldsFor) {
  return [...new Set((nodes ?? []).flatMap(node => fieldsFor(node).map(f => String(f.field_id))))];
}
