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
    while (curr) {
      depth++;
      curr = parentMap.get(curr);
    }
    return depth;
  }

  addedNodes.sort((a, b) => getDepth(b.logicalNodeId) - getDepth(a.logicalNodeId));

  return orderRestoreSteps([
    ...removedNodes.map(node => createReplacementStep(node)),
    ...movedNodes.map(node => moveNodeStep(node)),
    ...changedNodes.map(node => restoreFieldsStep(node)),
    ...addedNodes.map(node => deleteAddedNodeStep(node))
  ]);
}
