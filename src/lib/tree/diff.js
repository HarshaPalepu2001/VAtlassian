import { changedFields } from '../content.js';
import { contentFieldIds } from './structure.js';

export function diffTree({ baselineTree, currentTree, controlledFields }) {
  const changes = [];
  // Shape is compared as nodes and edges below, never as field values. See
  // ./structure.js for the three failures that came of comparing it twice.
  const scopeIds = contentFieldIds(controlledFields);

  const baselineNodes = new Map(baselineTree.nodes.map(n => [n.logicalNodeId, n]));
  const currentNodes = new Map(currentTree.nodes.map(n => [n.logicalNodeId, n]));

  for (const curr of currentTree.nodes) {
    const base = baselineNodes.get(curr.logicalNodeId);
    if (!base) {
      changes.push({ kind: 'NODE_ADDED', logicalNodeId: curr.logicalNodeId });
    } else {
      if (curr.parentLogicalId !== base.parentLogicalId) {
        changes.push({ kind: 'NODE_MOVED', logicalNodeId: curr.logicalNodeId, from: base.parentLogicalId, to: curr.parentLogicalId });
      }
      const diffFields = changedFields(base.digests, curr.digests, scopeIds);
      if (diffFields.length > 0) {
        changes.push({ kind: 'FIELD_CHANGED', logicalNodeId: curr.logicalNodeId, fields: diffFields });
      }
    }
  }

  for (const base of baselineTree.nodes) {
    if (!currentNodes.has(base.logicalNodeId)) {
      changes.push({ kind: 'NODE_REMOVED', logicalNodeId: base.logicalNodeId });
    }
  }

  return { changes };
}
