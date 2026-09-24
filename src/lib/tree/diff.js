import { changedFields } from '../content.js';
import { contentFieldIds } from './structure.js';

/**
 * `scopeFor(node)` names the fields a node tracks (./nodeFields.js); each node
 * is compared over its own. Without it every node uses `controlledFields`.
 */
export function diffTree({ baselineTree, currentTree, controlledFields, scopeFor = null }) {
  const changes = [];
  // Shape is compared as nodes and edges below, never as field values. See
  // ./structure.js for the three failures that came of comparing it twice.
  const rootScopeIds = contentFieldIds(controlledFields ?? []);
  const scopeIdsOf = node => (scopeFor ? contentFieldIds(scopeFor(node) ?? []) : rootScopeIds);

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
      const diffFields = changedFields(base.digests, curr.digests, scopeIdsOf(curr));
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
