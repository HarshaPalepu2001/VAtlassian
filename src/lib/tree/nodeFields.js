import { RULE_SOURCE } from '../evidence/versionEvidence.js';

/**
 * EVERY NODE IS TRACKED WITH THE ROOT'S FIELDS.
 *
 * Decided 2026-09-25, replacing the per-issue-type rule of the 24th. The
 * approval being made is the root's, so the root's Controlled Fields page rows
 * are what every node it covers is held to: a Task under an Epic tracks the
 * Epic's fields, attachments included, whether or not anyone ever configured
 * Task. Under the old rule it tracked only its own issue type's rows — which,
 * for a type nobody configured, were none — so a file added to VAT-14 after
 * its parent's approval was not drift at all.
 *
 * `scopeKey`/`nodeScope` stay: they still name an item's own scope, which is
 * what an item governed by no tree tracks (fieldsForItem below).
 */
export const scopeKey = (projectId, issueTypeId) => `${Number(projectId)}:${String(issueTypeId)}`;

export function nodeScope(node) {
  return {
    projectId: Number(node?.fields?.project?.id ?? node?.projectId),
    issueTypeId: String(node?.fields?.issuetype?.id ?? node?.issueTypeId ?? '')
  };
}

/**
 * Read a tree with the fields its nodes track — the root's, for every node —
 * in one read. `fieldsFor(node)` is kept as the interface capture, the
 * collector, the panel and restore already share.
 */
export async function readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey, rootFields, extraFieldIds = [] }) {
  const fieldIds = [...new Set([...rootFields.map(f => f.field_id), ...extraFieldIds, 'project', 'issuetype'])];
  const { tree } = await readStableTree({ readTree, rootIssueKey, fieldIds });
  return { tree, fieldsFor: () => rootFields };
}

/**
 * THE FIELDS ONE WORK ITEM TRACKS, on every single-item path: drift, the panel,
 * a decision's evidence hash, a restore.
 *
 * The same rule as a tree read, seen from the child: an item covered by an
 * approved tree it is not the root of tracks that root's fields. Reading only
 * the capture link (`captured_by_baseline_id`) would not do — a drift decision
 * on the child re-baselines it without one, and the child would quietly fall
 * back to its own issue type's fields on its next approval.
 *
 *   · Covered by one or more other roots: the most recently approved root's
 *     fields, whether or not the item also has a baseline of its own.
 *   · A root with no other tree above it: its own fields. It has its own approval.
 *   · Covered by none: its own issue type's fields, as always.
 *
 * A root row with no scope (read before its columns existed) falls back to the
 * item's own fields rather than guessing.
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
