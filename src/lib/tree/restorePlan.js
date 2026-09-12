import { diffTree } from './diff.js';

function createReplacementStep(node) {
  return { kind: 'CREATE_REPLACEMENT', logicalNodeId: node.logicalNodeId };
}
function moveNodeStep(node) {
  return { kind: 'MOVE_NODE', logicalNodeId: node.logicalNodeId, parent: node.from };
}
function restoreFieldsStep(node) {
  return { kind: 'RESTORE_FIELDS', logicalNodeId: node.logicalNodeId, fields: node.fields };
}
function deleteAddedNodeStep(node) {
  return { kind: 'DELETE_ADDED_NODE', logicalNodeId: node.logicalNodeId };
}

function orderRestoreSteps(steps) {
  return { steps };
}

export function planTreeRestore({ baselineTree, currentTree, controlledFields }) {
  const diff = diffTree({ baselineTree, currentTree, controlledFields });

  const removedNodes = diff.changes.filter(c => c.kind === 'NODE_REMOVED');
  const movedNodes = diff.changes.filter(c => c.kind === 'NODE_MOVED');
  const changedNodes = diff.changes.filter(c => c.kind === 'FIELD_CHANGED');
  const addedNodes = diff.changes.filter(c => c.kind === 'NODE_ADDED');

  // deepest first sort: how to find depth?
  // We can build a parent map from currentTree
  const parentMap = new Map();
  for (const node of currentTree.nodes) {
    // Note: diffTree uses currentTree node's logicalNodeId and parentLogicalId.
    // wait, currentTree nodes have `parentLogicalId` or `parent`?
    // In my test I used `parent`, but `diffTree` says `parentLogicalId`.
    parentMap.set(node.logicalNodeId, node.parentLogicalId || node.parent);
  }

  function getDepth(logicalNodeId) {
    let depth = 0;
    let curr = logicalNodeId;
    let seen = new Set();
    while (curr) {
      if (seen.has(curr)) break; // cycle protection
      seen.add(curr);
      depth++;
      curr = parentMap.get(curr);
    }
    return depth;
  }

  // Never delete the governed root under any circumstance.
  // The governed root is the one without a parent in the baseline or current tree.
  // Actually, we should just find the root of the current tree and explicitly exclude it from deletion.
  const rootIds = new Set();
  if (baselineTree && baselineTree.nodes) {
    for (const n of baselineTree.nodes) {
      if (!n.parentLogicalId && !n.parent) rootIds.add(n.logicalNodeId);
    }
  }
  if (currentTree && currentTree.nodes) {
    for (const n of currentTree.nodes) {
      if (!n.parentLogicalId && !n.parent) rootIds.add(n.logicalNodeId);
    }
  }

  const safeAddedNodes = addedNodes.filter(n => !rootIds.has(n.logicalNodeId));

  safeAddedNodes.sort((a, b) => getDepth(b.logicalNodeId) - getDepth(a.logicalNodeId));

  return orderRestoreSteps([
    ...removedNodes.map(node => createReplacementStep(node)),
    ...movedNodes.map(node => moveNodeStep(node)),
    ...changedNodes.map(node => restoreFieldsStep(node)),
    ...safeAddedNodes.map(node => deleteAddedNodeStep(node))
  ]);
}
