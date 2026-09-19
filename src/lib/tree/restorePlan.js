import { canonical, sha256Hex } from '../hash.js';
import { diffTree } from './diff.js';
import { FailClosed } from './stableRead.js';
import { FIELD_KIND } from '../content.js';
import { contentFieldIds, isStructuralField } from './structure.js';

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
  const linkFieldIds = new Set(controlledFields
    .filter(field => field.field_kind === FIELD_KIND.LINKS || field.field_id === 'issuelinks')
    .map(field => String(field.field_id)));

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
      // A structural id is never written back: `parent` is restored by moving
      // the node and `subtasks` is read-only in Jira, so including either turns
      // a correct plan into a request Jira refuses. ./structure.js has the full
      // reasoning; the filter is applied to both branches because a recreated
      // node takes the whole field set rather than a diff.
      const fieldIds = removedIds.has(idOf(node))
        ? contentFieldIds(controlledFields).sort()
        : (changedById.get(idOf(node)) ?? []).filter(fieldId => !isStructuralField(fieldId));
      const regularFieldIds = fieldIds.filter(fieldId => !linkFieldIds.has(fieldId));
      const steps = [];
      if (regularFieldIds.length > 0) {
        steps.push(action('RESTORE_FIELDS', idOf(node), parentOf(node), regularFieldIds, {
          fields: retainedFields(baselineTree, idOf(node), regularFieldIds)
        }));
      }
      // Existing nodes can reconcile links against their current identity.
      // Removed descendants are intentionally left to the existing replacement
      // path; their external link identities need a separate rewire policy.
      if (!removedIds.has(idOf(node))) {
        const nodeLinkIds = fieldIds.filter(fieldId => linkFieldIds.has(fieldId));
        if (nodeLinkIds.length > 1) {
          throw new FailClosed('MULTI_LINK_FIELD_UNSUPPORTED');
        }
        if (nodeLinkIds.length === 1) {
          const values = retainedFields(baselineTree, idOf(node), [nodeLinkIds[0]]);
          steps.push(action('RESTORE_LINKS', idOf(node), parentOf(node), [nodeLinkIds[0]], { links: values[nodeLinkIds[0]] }));
        }
      }
      return steps;
    });
  const deleteSteps = added
    .filter(node => parentOf(node) != null)
    .map(node => action('DELETE_ADDED_NODE', idOf(node), parentOf(node)));

  // ── WHAT THIS REJECTION WILL COST, STATED BEFORE IT IS SIGNED ─────────────
  //
  // planRestore() has always returned a `preflight` so the confirmation dialog
  // can say what cannot be restored, on the principle that "there is no path
  // where a reviewer clicks Reject and discovers afterwards that two fields
  // were quietly left drifted". The tree planner returned steps and nothing
  // else, and the one consequence it carries that the field planner never did
  // is PERMANENT DELETION of work items.
  //
  // A reviewer signing a rejection is authorising that deletion. They cannot
  // authorise what they were not shown, so the keys are named here and the
  // panel reads them straight out of the plan.
  const willDelete = deleteSteps.map(step => {
    const node = currentById.get(step.logicalNodeId);
    return { logicalNodeId: step.logicalNodeId, issueKey: node?.issueKey ?? node?.key ?? null };
  });
  const willRecreate = createSteps.map(step => {
    const node = baselineById.get(step.logicalNodeId);
    return { logicalNodeId: step.logicalNodeId, issueKey: node?.issueKey ?? null };
  });

  return {
    steps: [...createSteps, ...moveSteps, ...fieldSteps, ...deleteSteps],
    preflight: {
      willDelete,
      // Recreation is not destruction, but it is not invisible either: the
      // recreated work item gets a NEW Jira key, and anything outside the tree
      // that referenced the old one will not follow it.
      willRecreate,
      willMove: moveSteps.length,
      willRestoreFields: fieldSteps.length
    }
  };
}
