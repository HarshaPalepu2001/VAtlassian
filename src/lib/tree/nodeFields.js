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
 *   · The item is a root itself: its own fields. It has its own approval.
 *   · Covered by one or more roots: the most recently approved root's fields.
 *   · Covered by none: its own issue type's fields, as always.
 *
 * A root row with no scope (read before its columns existed) falls back to the
 * item's own fields rather than guessing.
 */
export async function fieldsForItem({ issueId, projectId, issueTypeId }, deps) {
  const own = () => deps.controlledFields({ projectId, issueTypeId });
  const roots = await deps.activeRootsForNode(Number(issueId));
  if (roots.some(root => Number(root.rootIssueId) === Number(issueId))) return own();
  const governing = roots
    .filter(root => root.projectId != null && root.issueTypeId != null)
    .sort((a, b) => Number(b.capturedAt ?? 0) - Number(a.capturedAt ?? 0))[0];
  if (!governing) return own();
  return deps.controlledFields({ projectId: Number(governing.projectId), issueTypeId: String(governing.issueTypeId) });
}

/** Field ids a set of nodes tracks between them: what a verification read must fetch. */
export function unionFieldIds(nodes, fieldsFor) {
  return [...new Set((nodes ?? []).flatMap(node => fieldsFor(node).map(f => String(f.field_id))))];
}
