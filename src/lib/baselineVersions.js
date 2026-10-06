import { FIELD_KIND, normaliseField } from './content.js';
import { diffField, presentationKind, withAttachmentDetails } from './diff/fields.js';
import { buildRecord } from './record.js';
import { groupReview } from './tree/groupedReview.js';
import { isStructuralField } from './tree/structure.js';

function digestsOf(node) {
  const value = node?.fieldDigests ?? node?.field_digests ?? node?.digests ?? {};
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return {}; }
}

function rootOf(snapshot) {
  return (snapshot.nodes ?? []).find(node => String(node.originalIssueId ?? node.currentIssueId) === String(snapshot.baseline.issue_id)) ?? null;
}

function valueOf(snapshot, node) {
  return node ? snapshot.values?.[node.logicalNodeId] ?? {} : {};
}

/** The root's signed field set and retained values, never today's mutable field set. */
export function recordSnapshot(snapshot, currentFields = []) {
  const root = rootOf(snapshot);
  const digests = root ? digestsOf(root) : digestsOf(snapshot.baseline);
  const values = root ? valueOf(snapshot, root) : snapshot.values ?? {};
  const byId = new Map(currentFields.map(field => [String(field.field_id), field]));
  const signedFields = Object.keys(digests).map(id => ({
    ...(byId.get(id) ?? {}), field_id: id,
    field_name: byId.get(id)?.field_name ?? id,
    field_kind: presentationKind(byId.get(id)?.field_kind ?? inferKind(values[id]), values[id], values[id]),
    store_values: Object.hasOwn(values, id)
  }));
  return buildRecord({ baseline: snapshot.baseline, controlledFields: signedFields,
    baselineValues: values, digests });
}

function inferKind(value) {
  if (value?.type === 'doc') return FIELD_KIND.ADF;
  if (Array.isArray(value)) {
    if (value.some(item => item && typeof item === 'object' && 'filename' in item)) return FIELD_KIND.ATTACHMENTS;
    if (value.some(item => item && typeof item === 'object' && ('inward' in item || 'outward' in item))) return FIELD_KIND.LINKS;
    return FIELD_KIND.MULTI;
  }
  if (typeof value === 'string') return FIELD_KIND.TEXT;
  return FIELD_KIND.SCALAR;
}

function normalise(kind, value) {
  try { return normaliseField(kind, value); }
  catch { return value ?? null; }
}

function emptyFor(kind) {
  return [FIELD_KIND.MULTI, FIELD_KIND.ATTACHMENTS, FIELD_KIND.LINKS, FIELD_KIND.SUBTASKS].includes(kind) ? [] : null;
}

function nodeChange(node, added) {
  const name = node.issueKey ?? `Work item ${node.originalIssueId}`;
  return {
    fieldId: `tree:${added ? 'added' : 'removed'}:${node.logicalNodeId}`,
    fieldName: `${added ? 'Added' : 'Removed'} work item · ${name}`,
    issueKey: name, label: `${added ? 'Added' : 'Removed'} work item`,
    kind: 'scalar', materiality: 'MAJOR', retained: true,
    before: added ? null : name, after: added ? name : null,
    summary: added ? 'Work item entered the signed tree' : 'Work item left the signed tree',
    scopeChange: added ? 'NODE_ADDED' : 'NODE_REMOVED',
    attribution: [], attributionStatus: 'NOT_COLLECTED',
    group: { kind: 'STRUCTURE' }
  };
}

/** Exact saved-snapshot comparison. Approval identities are provenance, never edit attribution. */
export function compareBaselineSnapshots(beforeSnapshot, afterSnapshot, currentFields = []) {
  const definitions = new Map(currentFields.map(field => [String(field.field_id), field]));
  const beforeNodes = new Map((beforeSnapshot.nodes ?? []).map(node => [node.logicalNodeId, node]));
  const afterNodes = new Map((afterSnapshot.nodes ?? []).map(node => [node.logicalNodeId, node]));
  const fields = [];

  for (const nodeId of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
    const oldNode = beforeNodes.get(nodeId);
    const newNode = afterNodes.get(nodeId);
    if (!oldNode || !newNode) {
      fields.push(nodeChange(newNode ?? oldNode, Boolean(newNode)));
    }
    const issueKey = newNode?.issueKey ?? oldNode?.issueKey ?? String(nodeId);
    if (oldNode && newNode && (oldNode.parentLogicalNodeId ?? null) !== (newNode.parentLogicalNodeId ?? null)) {
      const parentName = (parentId, nodes) => parentId == null ? 'Root' : nodes.get(parentId)?.issueKey ?? 'Unavailable parent';
      fields.push({
        fieldId: `tree:moved:${nodeId}`, fieldName: `Moved work item · ${issueKey}`,
        issueKey, label: 'Parent changed', kind: 'scalar', materiality: 'MAJOR', retained: true,
        before: parentName(oldNode.parentLogicalNodeId, beforeNodes),
        after: parentName(newNode.parentLogicalNodeId, afterNodes),
        summary: 'Work item moved in the signed tree', scopeChange: 'NODE_MOVED',
        attribution: [], attributionStatus: 'NOT_COLLECTED', group: { kind: 'STRUCTURE' }
      });
    }
    const oldDigests = digestsOf(oldNode);
    const newDigests = digestsOf(newNode);
    const oldValues = valueOf(beforeSnapshot, oldNode);
    const newValues = valueOf(afterSnapshot, newNode);
    const group = { kind: 'ISSUE', logicalNodeId: nodeId, issueKey, summary: null,
      isRoot: String((newNode ?? oldNode)?.originalIssueId) === String(afterSnapshot.baseline.issue_id),
      baselineVersion: Number(beforeSnapshot.baseline.version) };
    for (const id of new Set([...Object.keys(oldDigests), ...Object.keys(newDigests)])) {
      if (isStructuralField(id)) continue;
      const wasTracked = Object.hasOwn(oldDigests, id);
      const nowTracked = Object.hasOwn(newDigests, id);
      if (wasTracked && nowTracked && oldDigests[id] === newDigests[id]) continue;
      const oldRetained = Object.hasOwn(oldValues, id);
      const newRetained = Object.hasOwn(newValues, id);
      const definition = definitions.get(id) ?? {};
      const kind = presentationKind(definition.field_kind ?? inferKind(newRetained ? newValues[id] : oldValues[id]), oldValues[id], newValues[id]);
      const field = { ...definition, field_id: id, field_name: definition.field_name ?? id,
        field_kind: kind };
      const retained = (!wasTracked || oldRetained) && (!nowTracked || newRetained)
        && (oldRetained || newRetained);
      const before = wasTracked ? normalise(kind, oldValues[id]) : emptyFor(kind);
      const after = nowTracked ? normalise(kind, newValues[id]) : emptyFor(kind);
      const diff = withAttachmentDetails(diffField({ field, before, after, retained,
        digestChanged: oldDigests[id] !== newDigests[id] }), oldValues[id], newValues[id]);
      fields.push({ ...diff,
        fieldId: `${nodeId}:${id}`, rawFieldId: id,
        fieldName: `${issueKey} · ${field.field_name}`, label: field.field_name, issueKey,
        materiality: definition.materiality ?? 'MAJOR',
        scopeChange: !wasTracked ? 'ADDED' : !nowTracked ? 'REMOVED' : null,
        // The saved value may be absent by retention policy. Never present that as empty.
        before: retained && wasTracked ? diff.before : null,
        after: retained && nowTracked ? diff.after : null,
        attribution: [], attributionStatus: 'NOT_COLLECTED', group,
        valueLabels: {}
      });
    }
  }
  return { fromVersion: Number(beforeSnapshot.baseline.version), toVersion: Number(afterSnapshot.baseline.version),
    from: { approvedName: beforeSnapshot.baseline.approved_name ?? null, approvedAt: beforeSnapshot.baseline.transition_at ?? beforeSnapshot.baseline.captured_at ?? null },
    to: { approvedName: afterSnapshot.baseline.approved_name ?? null, approvedAt: afterSnapshot.baseline.transition_at ?? afterSnapshot.baseline.captured_at ?? null },
    fields, groups: groupReview(fields), changedFieldCount: fields.length };
}
