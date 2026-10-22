/**
 * Build the approved tree seen from the work item that opened the review.
 *
 * Parent captures store a field-level baseline row for every child, while the
 * parent tree stores the authoritative descendant structure. A child review
 * therefore needs both records: the governing tree supplies the subtree and
 * the child's own row supplies the clicked root's approved values.
 */

import { baselineLinkPolicy } from '../linkPolicy.js';

function parseDigests(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function copyNode(node, parentLogicalId, digests = node?.digests) {
  const descriptors = Object.getOwnPropertyDescriptors(node ?? {});
  if (descriptors.parentLogicalNodeId) descriptors.parentLogicalNodeId = {
    ...descriptors.parentLogicalNodeId, value: parentLogicalId
  };
  else descriptors.parentLogicalNodeId = { value: parentLogicalId, enumerable: true, writable: true, configurable: true };
  if (descriptors.parentLogicalId) descriptors.parentLogicalId = {
    ...descriptors.parentLogicalId, value: parentLogicalId
  };
  else descriptors.parentLogicalId = { value: parentLogicalId, enumerable: false, writable: false, configurable: true };
  if (descriptors.digests) descriptors.digests = { ...descriptors.digests, value: digests };
  else descriptors.digests = { value: digests, enumerable: false, writable: false, configurable: false };
  return Object.create(Object.getPrototypeOf(node ?? {}), descriptors);
}

export function sliceBaselineTree(tree, rootLogicalNodeId) {
  if (!tree?.nodes?.length || !rootLogicalNodeId) return null;
  const all = new Map(tree.nodes.map(node => [node.logicalNodeId, node]));
  if (!all.has(rootLogicalNodeId)) return null;
  const keep = new Set([rootLogicalNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of tree.nodes) {
      if (keep.has(node.parentLogicalId ?? node.parentLogicalNodeId) && !keep.has(node.logicalNodeId)) {
        keep.add(node.logicalNodeId);
        changed = true;
      }
    }
  }
  const nodes = tree.nodes
    .filter(node => keep.has(node.logicalNodeId))
    .map(node => copyNode(node, node.logicalNodeId === rootLogicalNodeId ? null : (node.parentLogicalId ?? node.parentLogicalNodeId)));
  const values = Object.fromEntries(nodes.map(node => [node.logicalNodeId, tree.values?.[node.logicalNodeId] ?? {}]));
  return { ...tree, nodes, values };
}

export function effectiveScopedBaselineTree({ governedTree, rootLogicalNodeId, ownBaseline, ownValues }) {
  const scoped = sliceBaselineTree(governedTree, rootLogicalNodeId);
  const digests = parseDigests(ownBaseline?.field_digests ?? ownBaseline?.fieldDigests);
  if (!scoped || !digests) return null;
  const nodes = scoped.nodes.map(node => node.logicalNodeId === rootLogicalNodeId
    ? copyNode(node, null, digests)
    : node);
  const root = nodes.find(node => node.logicalNodeId === rootLogicalNodeId);
  const ownPolicy = baselineLinkPolicy(ownBaseline);
  if (root && (root.linkPolicy?.version === 2 || ownPolicy.version === 2)) {
    Object.defineProperty(root, 'linkPolicy', { value: ownPolicy, enumerable: true, configurable: true, writable: true });
  }
  return {
    ...scoped,
    nodes,
    values: { ...scoped.values, [rootLogicalNodeId]: ownValues ?? {} }
  };
}

/**
 * Resolve the exact approved tree for the work item being reviewed or
 * restored. A tree baseline owns its own stored tree; a field-level child
 * baseline created by a parent capture instead points back to that parent's
 * signed tree and contributes the child's latest approved fields at the
 * scoped root.
 *
 * Keeping this boundary shared is important: the interactive diff and the
 * queued restore must never disagree about whether descendants belong to the
 * approved hierarchy.
 */
export async function resolveBaselineTree({ baseline, baselineValues, rootLogicalNodeId,
  baselineById, readBaselineTree }) {
  if (!baseline?.baseline_id) return null;
  if (baseline.tree_hash) {
    const tree = await readBaselineTree(baseline.baseline_id);
    return tree?.nodes?.length ? { governingBaseline: baseline, tree } : null;
  }
  if (!baseline.captured_by_baseline_id || typeof baselineById !== 'function') return null;
  const governingBaseline = await baselineById(baseline.captured_by_baseline_id);
  if (!governingBaseline?.tree_hash) return null;
  const governedTree = await readBaselineTree(governingBaseline.baseline_id);
  const tree = effectiveScopedBaselineTree({ governedTree, rootLogicalNodeId,
    ownBaseline: baseline, ownValues: baselineValues });
  return tree ? { governingBaseline, tree } : null;
}
