import { canonical, sha256Hex } from '../hash.js';
import { diffTree } from './diff.js';
import { FailClosed } from './stableRead.js';
import { FIELD_KIND } from '../content.js';
import { contentFieldIds, isStructuralField } from './structure.js';
import { adfMediaIds } from '../attachmentIdentity.js';

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

/**
 * `fieldsFor(node)` names each node's own tracked fields (./nodeFields.js).
 * `baselineTree` is the tree the decision returns to: for a parent reject,
 * each child that carries its own latest baseline already stands in it as that
 * baseline (./childBaselines.js), so the child is restored to its own record.
 */
export function planTreeRestore({ baselineTree, currentTree, controlledFields, fieldsFor = () => controlledFields }) {
  const baselineNodes = Array.isArray(baselineTree?.nodes) ? baselineTree.nodes : [];
  const currentNodes = Array.isArray(currentTree?.nodes) ? currentTree.nodes : [];
  const baselineById = new Map(baselineNodes.map(node => [idOf(node), node]));
  const currentById = new Map(currentNodes.map(node => [idOf(node), node]));
  const roots = baselineNodes.filter(node => parentOf(node) == null);
  if (roots.some(root => !currentById.has(idOf(root)))) throw new FailClosed('BASELINE_ROOT_MISSING');

  const diff = diffTree({ baselineTree: { ...baselineTree, nodes: baselineNodes },
    currentTree: { ...currentTree, nodes: currentNodes }, controlledFields, scopeFor: fieldsFor });
  const removedIds = new Set(diff.changes.filter(change => change.kind === 'NODE_REMOVED').map(change => String(change.logicalNodeId)));
  const movedIds = new Set(diff.changes.filter(change => change.kind === 'NODE_MOVED').map(change => String(change.logicalNodeId)));
  const changedById = new Map(diff.changes.filter(change => change.kind === 'FIELD_CHANGED')
    .map(change => [String(change.logicalNodeId), [...change.fields].map(String).sort()]));
  const addedIds = new Set(diff.changes.filter(change => change.kind === 'NODE_ADDED').map(change => String(change.logicalNodeId)));
  const linkFieldIdsOf = node => new Set((fieldsFor(node) ?? [])
    .filter(field => field.field_kind === FIELD_KIND.LINKS || field.field_id === 'issuelinks')
    .map(field => String(field.field_id)));
  // Files are not a field write either: Jira accepts no attachment list on an
  // edit. They are put back by re-uploading from the vault and deleting what
  // was added (../restore/attachments.js), as their own step.
  const attachmentFieldIdsOf = node => new Set((fieldsFor(node) ?? [])
    .filter(field => field.field_kind === FIELD_KIND.ATTACHMENTS || field.field_id === 'attachment')
    .map(field => String(field.field_id)));
  const currentValuesOf = id => currentTree?.values?.[id] ?? {};

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
      const linkFieldIds = linkFieldIdsOf(node);
      const attachmentFieldIds = attachmentFieldIdsOf(node);
      const fieldIds = removedIds.has(idOf(node))
        ? contentFieldIds(fieldsFor(node) ?? []).sort()
        : (changedById.get(idOf(node)) ?? []).filter(fieldId => !isStructuralField(fieldId));
      const regularFieldIds = fieldIds.filter(fieldId => !linkFieldIds.has(fieldId) && !attachmentFieldIds.has(fieldId));
      const steps = [];
      let filesComeBack = false;
      const nodeAttachmentIds = fieldIds.filter(fieldId => attachmentFieldIds.has(fieldId));
      if (nodeAttachmentIds.length > 1) throw new FailClosed('MULTI_ATTACHMENT_FIELD_UNSUPPORTED');
      const regularValues = regularFieldIds.length > 0 ? retainedFields(baselineTree, idOf(node), regularFieldIds) : {};
      const currentValues = currentValuesOf(idOf(node));
      const adfFieldIds = new Set([
        ...(fieldsFor(node) ?? [])
          .filter(f => f.field_kind === FIELD_KIND.ADF || f.field_id === 'description')
          .map(f => String(f.field_id)),
        ...Object.keys(currentValues).filter(k => currentValues[k]?.type === 'doc'),
        ...Object.keys(regularValues).filter(k => regularValues[k]?.type === 'doc')
      ]);
      const targetAdfMedia = new Set();
      const currentAdfMedia = new Set();
      for (const fieldId of adfFieldIds) {
        const targetVal = regularFieldIds.includes(fieldId)
          ? regularValues[fieldId]
          : currentValues[fieldId];
        if (targetVal && typeof targetVal === 'object' && targetVal.type === 'doc') {
          for (const mId of adfMediaIds(targetVal)) targetAdfMedia.add(String(mId));
        }
        const curVal = currentValues[fieldId];
        if (curVal && typeof curVal === 'object' && curVal.type === 'doc') {
          for (const mId of adfMediaIds(curVal)) currentAdfMedia.add(String(mId));
        }
      }
      const mediaAdded = [...currentAdfMedia].some(mId => !targetAdfMedia.has(mId));
      const mediaRemoved = [...targetAdfMedia].some(mId => !currentAdfMedia.has(mId));
      const richMediaChanged = mediaAdded || mediaRemoved;

      if (nodeAttachmentIds.length === 1 || (richMediaChanged && !removedIds.has(idOf(node)))) {
        const fieldId = nodeAttachmentIds[0] ?? 'attachment';
        const rawTarget = nodeAttachmentIds.length === 1
          ? (retainedFields(baselineTree, idOf(node), [fieldId])[fieldId] ?? []).filter(a => !a?.isRichText)
          : ((currentValues[fieldId] ?? []).filter(a => !a?.isRichText));
        let target = Array.isArray(rawTarget) ? [...rawTarget] : [];
        const current = removedIds.has(idOf(node)) ? [] : (currentValues[fieldId] ?? []);

        if (targetAdfMedia.size > 0) {
          const baselineAll = baselineTree?.values?.[idOf(node)]?.allAttachments
            ?? baselineTree?.values?.[idOf(node)]?.attachment ?? [];
          for (const a of Array.isArray(baselineAll) ? baselineAll : []) {
            if (a?.mediaId && targetAdfMedia.has(String(a.mediaId))) {
              if (!target.some(t => String(t.id) === String(a.id))) target.push(a);
            }
          }
          for (const a of Array.isArray(current) ? current : []) {
            if (a?.mediaId && targetAdfMedia.has(String(a.mediaId))) {
              if (!target.some(t => String(t.id) === String(a.id))) target.push(a);
            }
          }
        }

        // FILES BEFORE FIELDS: rich text that shows a file can only be written
        // while Jira has it. A recreated work item starts with no files: only
        // one that had some needs the step, and its files come from the
        // ORIGINAL item's vault page.
        if (!removedIds.has(idOf(node)) || (Array.isArray(target) && target.length > 0)) {
          const have = new Set((Array.isArray(current) ? current : []).map(a => String(a?.id)));
          filesComeBack = Array.isArray(target) && target.some(a => !have.has(String(a?.id)));
          steps.push(action('RESTORE_ATTACHMENTS', idOf(node), parentOf(node), [fieldId], { attachments: target, current }));
        }
      }
      if (regularFieldIds.length > 0) {
        steps.push(action('RESTORE_FIELDS', idOf(node), parentOf(node), regularFieldIds, {
          fields: regularValues
        }));
      }
      // Rich text nobody edited that shows a file this step puts back: the
      // deleted file's pointer is still in it, and the restored copy has a new
      // media id (../restore/planner.js repointCandidates says why). A
      // recreated node is not included: it writes every field anyway.
      if (filesComeBack && !removedIds.has(idOf(node))) {
        const retained = baselineTree?.values?.[idOf(node)] ?? {};
        const written = new Set(fieldIds);
        const repointIds = (fieldsFor(node) ?? []).map(field => String(field.field_id))
          .filter(fieldId => !written.has(fieldId) && !isStructuralField(fieldId) && !attachmentFieldIds.has(fieldId)
            && retained[fieldId]?.type === 'doc' && adfMediaIds(retained[fieldId]).length > 0);
        if (repointIds.length > 0) {
          steps.push(action('REPOINT_RICH_TEXT', idOf(node), parentOf(node), repointIds, {
            fields: retainedFields(baselineTree, idOf(node), repointIds)
          }));
        }
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

  // Files a rejection deletes (added since approval) and re-uploads from the
  // vault (removed since), named per work item before anyone signs.
  const attachments = { willDelete: [], willRestore: [] };
  for (const step of fieldSteps.filter(entry => entry.kind === 'RESTORE_ATTACHMENTS')) {
    const issueKey = (currentById.get(step.logicalNodeId) ?? baselineById.get(step.logicalNodeId))?.issueKey ?? null;
    const target = new Set((step.attachments ?? []).map(a => String(a?.id)));
    const current = new Set((step.current ?? []).map(a => String(a?.id)));
    const file = a => ({ logicalNodeId: step.logicalNodeId, issueKey, id: String(a?.id ?? ''), filename: a?.filename ?? '' });
    attachments.willDelete.push(...(step.current ?? []).filter(a => !target.has(String(a?.id))).map(file));
    attachments.willRestore.push(...(step.attachments ?? []).filter(a => !current.has(String(a?.id))).map(file));
    delete step.current;
  }
  const richTextRepoint = fieldSteps.filter(step => step.kind === 'REPOINT_RICH_TEXT').map(step => ({
    logicalNodeId: step.logicalNodeId,
    issueKey: (currentById.get(step.logicalNodeId) ?? baselineById.get(step.logicalNodeId))?.issueKey ?? null,
    fieldIds: step.fieldIds
  }));

  return {
    steps: [...createSteps, ...moveSteps, ...fieldSteps, ...deleteSteps],
    preflight: {
      willDelete,
      attachments,
      // Written only if a pointer in it really moves to a restored copy.
      richTextRepoint,
      // Recreation is not destruction, but it is not invisible either: the
      // recreated work item gets a NEW Jira key, and anything outside the tree
      // that referenced the old one will not follow it.
      willRecreate,
      willMove: moveSteps.length,
      willRestoreFields: fieldSteps.length
    }
  };
}
