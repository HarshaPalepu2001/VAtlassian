import { project } from '../content.js';
import { diffTree } from './diff.js';
import { logicalNodeId } from './model.js';

const parentOf = node => node?.parentLogicalNodeId ?? node?.parentLogicalId ?? node?.parent ?? null;

function putIdentity(map, value, logicalId) {
  if (value != null) map.set(String(value), String(logicalId));
}

export async function verifyTreeRestore({
  readStableTree, readTree, rootIssueKey, baselineTree, controlledFields,
  replacements = [], expectedRootStatusId = null
}) {
  const fieldIds = [...new Set([
    ...controlledFields.map(field => String(field.field_id)),
    'parent',
    'status'
  ])];
  let liveTree;
  try {
    const stable = await readStableTree({ readTree, rootIssueKey, fieldIds });
    liveTree = stable?.tree;
    if (!Array.isArray(liveTree?.nodes)) throw new Error('Stable tree read returned no nodes');
  } catch {
    return { matches: false, replacements, progress: false, statusMatches: false, changes: [] };
  }

  const realToLogical = new Map();
  for (const node of baselineTree?.nodes ?? []) {
    putIdentity(realToLogical, node.originalIssueId ?? node.id, node.logicalNodeId);
    putIdentity(realToLogical, node.currentIssueId, node.logicalNodeId);
    putIdentity(realToLogical, node.issueKey ?? node.key, node.logicalNodeId);
  }
  for (const replacement of replacements) {
    putIdentity(realToLogical, replacement.newIssueId, replacement.logicalNodeId);
    putIdentity(realToLogical, replacement.newIssueKey, replacement.logicalNodeId);
  }

  const currentNodes = liveTree.nodes.map(node => {
    const mapped = realToLogical.get(String(node.id)) ?? realToLogical.get(String(node.key));
    const currentLogicalNodeId = mapped ?? logicalNodeId(node.id);
    const parent = node.fields?.parent;
    const parentIdentity = parent?.id ?? parent?.key;
    const parentLogicalId = parent == null ? null
      : realToLogical.get(String(parentIdentity)) ?? logicalNodeId(parentIdentity);
    return {
      logicalNodeId: currentLogicalNodeId,
      parentLogicalId,
      digests: project(node.fields ?? {}, controlledFields).digests
    };
  });

  const diff = diffTree({ baselineTree, currentTree: { nodes: currentNodes }, controlledFields });
  const baselineRoot = (baselineTree?.nodes ?? []).find(node => parentOf(node) == null);
  const liveRoot = baselineRoot
    ? liveTree.nodes.find(node => realToLogical.get(String(node.id)) === String(baselineRoot.logicalNodeId)
      || realToLogical.get(String(node.key)) === String(baselineRoot.logicalNodeId))
    : null;
  const statusMatches = expectedRootStatusId == null
    ? true
    : String(liveRoot?.fields?.status?.id ?? '') === String(expectedRootStatusId);
  const baselineIds = new Set((baselineTree?.nodes ?? []).map(node => String(node.logicalNodeId)));
  const mappedCount = currentNodes.filter(node => baselineIds.has(String(node.logicalNodeId))).length;

  return {
    matches: diff.changes.length === 0 && statusMatches,
    replacements,
    progress: mappedCount > 0,
    statusMatches,
    changes: diff.changes
  };
}
