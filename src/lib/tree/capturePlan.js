import { FailClosed } from '../errors.js';
import { project } from '../content.js';
import { logicalNodeId, TREE_LIMIT } from './model.js';

function aggregateTree(rootIssueId, plannedNodes, fieldCount) {
  const rootLogicalId = logicalNodeId(rootIssueId);
  const byLogicalId = new Map();
  let edgeCount = 0;

  for (const p of plannedNodes) {
    if (byLogicalId.has(p.logicalNodeId)) {
      throw new FailClosed('DUPLICATE_NODE');
    }
    const parentId = p.fields?.parent?.id;
    p.parentLogicalId = parentId ? logicalNodeId(parentId) : null;
    byLogicalId.set(p.logicalNodeId, p);
  }

  const nodes = [];
  for (const p of plannedNodes) {
    if (p.parentLogicalId) {
      if (!byLogicalId.has(p.parentLogicalId)) {
        throw new FailClosed('MISSING_PARENT');
      }
      edgeCount++;
    }
    
    nodes.push({
      logicalNodeId: p.logicalNodeId,
      parentLogicalId: p.parentLogicalId,
      contentHash: p.contentHash,
      digests: p.digests,
      values: p.values,
      raw: p.raw
    });
  }

  for (const node of nodes) {
    let currentId = node.logicalNodeId;
    const path = new Set();
    while (currentId) {
      if (path.has(currentId)) {
        throw new FailClosed('CYCLE_DETECTED');
      }
      path.add(currentId);
      const currNode = byLogicalId.get(currentId);
      currentId = currNode.parentLogicalId;
    }
  }

  nodes.sort((a, b) => a.logicalNodeId.localeCompare(b.logicalNodeId));

  return {
    nodeCount: nodes.length,
    edgeCount,
    totalFieldCount: nodes.length * fieldCount,
    nodes
  };
}

export function planTreeCapture({ rootIssueId, nodes, controlledFields }) {
  if (!nodes.length || nodes.length > TREE_LIMIT) throw new FailClosed('TREE_LIMIT_EXCEEDED');
  const planned = nodes.map(node => {
    const projection = project(node.fields, controlledFields);
    if (Object.keys(projection.raw).length !== controlledFields.length) {
      throw new FailClosed('BASELINE_VALUES_REQUIRED');
    }
    return { ...node, logicalNodeId: logicalNodeId(node.id), ...projection };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return aggregateTree(String(rootIssueId), planned, controlledFields.length);
}
