import { canonical, sha256Hex } from '../hash.js';
import { diffTree } from './diff.js';
import { FailClosed } from './stableRead.js';

const parentOf = node => node?.parentLogicalNodeId ?? node?.parentLogicalId ?? node?.parent ?? null;
const idOf = node => String(node?.logicalNodeId ?? '');

function depthOf(node, byId) {
  let depth = 0;
  let current = node;
  const seen = new Set();
  while (current && parentOf(current) != null) {
    if (seen.has(idOf(current))) throw new FailClosed('CYCLE_DETECTED');
    seen.add(idOf(current));
    current = byId.get(String(parentOf(current)));
    if (!current) throw new FailClosed('MISSING_PARENT');
    depth += 1;
  }
  return depth;
}

function action(kind, logicalNodeId, parentLogicalNodeId, fieldIds = [], extra = {}) {
  const identity = {
    kind,
    logicalNodeId: String(logicalNodeId),
    parentLogicalNodeId: parentLogicalNodeId == null ? null : String(parentLogicalNodeId),
    fieldIds: [...fieldIds].map(String).sort()
  };
  return { ...identity, stepKey: sha256Hex(canonical(identity)), ...extra };
}

function compareByDepthThenId(byId, direction = 1) {
  return (left, right) => {
    const depth = depthOf(left, byId) - depthOf(right, byId);
    return direction * depth || idOf(left).localeCompare(idOf(right));
  };
}

function retainedFields(baselineTree, logicalNodeId, fieldIds) {
  const retained = baselineTree?.values?.[logicalNodeId];
  if (!retained || fieldIds.some(fieldId => !Object.hasOwn(retained, fieldId))) {
    throw new FailClosed('BASELINE_VALUES_REQUIRED');
  }
  return Object.fromEntries(fieldIds.map(fieldId => [fieldId, retained[fieldId]]));
}

export function planTreeRestore({ baselineTree, currentTree, controlledFields }) {
  const baselineNodes = Array.isArray(baselineTree?.nodes) ? baselineTree.nodes : [];
  const currentNodes = Array.isArray(currentTree?.nodes) ? currentTree.nodes : [];
  const baselineById = new Map(baselineNodes.map(node => [idOf(node), node]));
  const currentById = new Map(currentNodes.map(node => [idOf(node), node]));
  const roots = baselineNodes.filter(node => parentOf(node) == null);
  if (roots.some(root => !currentById.has(idOf(root)))) throw new FailClosed('BASELINE_ROOT_MISSING');

  const diff = diffTree({ baselineTree: { ...baselineTree, nodes: baselineNodes },
    currentTree: { ...currentTree, nodes: currentNodes }, controlledFields });
  const removedIds = new Set(diff.changes.filter(change => change.kind === 'NODE_REMOVED').map(change => String(change.logicalNodeId)));
  const movedIds = new Set(diff.changes.filter(change => change.kind === 'NODE_MOVED').map(change => String(change.logicalNodeId)));
  const changedById = new Map(diff.changes.filter(change => change.kind === 'FIELD_CHANGED')
    .map(change => [String(change.logicalNodeId), [...change.fields].map(String).sort()]));
  const addedIds = new Set(diff.changes.filter(change => change.kind === 'NODE_ADDED').map(change => String(change.logicalNodeId)));

  const removed = baselineNodes.filter(node => removedIds.has(idOf(node))).sort(compareByDepthThenId(baselineById));
  const moved = baselineNodes.filter(node => movedIds.has(idOf(node))).sort(compareByDepthThenId(baselineById));
  const added = currentNodes.filter(node => addedIds.has(idOf(node))).sort(compareByDepthThenId(currentById, -1));

  const createSteps = removed.map(node => action('CREATE_REPLACEMENT', idOf(node), parentOf(node), [], { node }));
  const moveSteps = moved.map(node => action('MOVE_NODE', idOf(node), parentOf(node)));
  const restoreIds = new Set([...changedById.keys(), ...removed.map(idOf)]);
  const fieldSteps = baselineNodes
    .filter(node => restoreIds.has(idOf(node)))
    .sort(compareByDepthThenId(baselineById))
    .flatMap(node => {
      const fieldIds = removedIds.has(idOf(node))
        ? controlledFields.map(field => String(field.field_id)).filter(fieldId => fieldId !== 'parent').sort()
        : (changedById.get(idOf(node)) ?? []).filter(fieldId => fieldId !== 'parent');
      if (fieldIds.length === 0) return [];
      return [action('RESTORE_FIELDS', idOf(node), parentOf(node), fieldIds, {
        fields: retainedFields(baselineTree, idOf(node), fieldIds)
      })];
    });
  const deleteSteps = added
    .filter(node => parentOf(node) != null)
    .map(node => action('DELETE_ADDED_NODE', idOf(node), parentOf(node)));

  return { steps: [...createSteps, ...moveSteps, ...fieldSteps, ...deleteSteps] };
}
