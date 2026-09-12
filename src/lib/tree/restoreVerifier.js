export async function verifyTreeRestore({ readStableTree, rootIssueKey, baselineTree, controlledFields, replacements }) {
  const fieldIds = controlledFields.map(f => f.field_id);
  let liveTree;
  try {
    liveTree = await readStableTree(rootIssueKey, fieldIds);
  } catch (e) {
    return { matches: false, replacements, progress: false };
  }

  // Check logical nodes, parent edges, and controlled fields
  // For each baseline node, it must exist in live tree (possibly via replacement mapping)
  // and its fields must match, and its parent must match.

  const baselineMap = new Map(baselineTree.nodes.map(n => [n.logicalNodeId, n]));

  // live map: mapping from issue id/key to the node
  const liveMap = new Map();
  for (const n of liveTree.nodes) {
    liveMap.set(n.id, n);
    liveMap.set(n.key, n);
  }

  const replacementMap = new Map(replacements.map(r => [r.logicalNodeId, r.newIssueId]));

  let allMatch = true;
  for (const [logicalId, bNode] of baselineMap.entries()) {
    const expectedIssueIdOrKey = replacementMap.get(logicalId) || bNode.key || bNode.id;
    const lNode = liveMap.get(expectedIssueIdOrKey);
    if (!lNode) {
      allMatch = false;
      break;
    }

    // check fields
    for (const f of controlledFields) {
      if (f.field_id === 'parent') continue;
      // In real implementation we'd compare raw values or digests.
      // For simplicity in this structure we just assume digests match if we were to compare them.
      // Actually `diffTree` does the deep comparison. We can just use `diffTree`!
    }
  }

  // Let's use diffTree for verification!
  // But wait, diffTree takes `currentTree`. We need to construct `currentTree` with logicalNodeIds.
  // How do we map live tree to logical node ids?
  // We can assign logicalNodeIds to live nodes based on baseline keys and replacements.

  const liveToLogical = new Map();
  for (const [logicalId, bNode] of baselineMap.entries()) {
    const k = replacementMap.get(logicalId) || bNode.key || bNode.id;
    liveToLogical.set(k, logicalId);
  }

  const currentNodes = [];
  let mappedCount = 0;
  for (const ln of liveTree.nodes) {
    const logicalId = liveToLogical.get(ln.id) || liveToLogical.get(ln.key);
    if (logicalId) {
      mappedCount++;
      currentNodes.push({
        ...ln,
        logicalNodeId: logicalId,
        parentLogicalId: liveToLogical.get(ln.fields?.parent?.id) || liveToLogical.get(ln.fields?.parent?.key)
      });
    } else {
      // It's an added node
      currentNodes.push({
        ...ln,
        logicalNodeId: 'added-' + ln.id,
        parentLogicalId: liveToLogical.get(ln.fields?.parent?.id) || liveToLogical.get(ln.fields?.parent?.key)
      });
    }
  }

  const { diffTree } = await import('./diff.js');
  const diff = diffTree({ baselineTree, currentTree: { nodes: currentNodes }, controlledFields });

  const matches = diff.changes.length === 0;
  return {
    matches,
    replacements,
    progress: mappedCount > 0
  };
}
