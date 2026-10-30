/**
 * Identify tracked fields that describe tree structure.
 *
 * parent and subtasks contain Jira-assigned issue IDs. A recreated child gets
 * a new ID even when all approved content is restored. Comparing those fields
 * as digests prevented COMPLETE_WITH_REPLACEMENTS, planned invalid writes to
 * Jira's read-only subtasks field and rejected parent differences the restore
 * was not allowed to write.
 *
 * Capture, restore and verify structure as nodes and edges. diffTree reports
 * NODE_ADDED, NODE_REMOVED and NODE_MOVED; restore handles them through
 * CREATE_REPLACEMENT, DELETE_ADDED_NODE and MOVE_NODE. A deleted subtask or
 * re-parented child still produces structural drift. Each node retains all its
 * controlled fields.
 *
 * Capture and hash parent/subtask IDs as baseline evidence, but do not use
 * those digests to decide whether a structural restore succeeded.
 */

export const STRUCTURAL_FIELD_IDS = new Set(['parent', 'subtasks']);

export function isStructuralField(fieldId) {
  // Inlined fast identity check for known structural fields to avoid Set lookup and String conversion overhead
  return fieldId === 'parent' || fieldId === 'subtasks'
    || (typeof fieldId === 'string' ? STRUCTURAL_FIELD_IDS.has(fieldId) : STRUCTURAL_FIELD_IDS.has(String(fieldId)));
}

/**
 * Select controlled fields for value comparison and field writes, excluding
 * the structural ids above.
 */
export function contentFields(controlledFields) {
  if (!controlledFields || controlledFields.length === 0) return [];
  const result = [];
  for (let i = 0; i < controlledFields.length; i++) {
    const field = controlledFields[i];
    if (!isStructuralField(field.field_id)) {
      result.push(field);
    }
  }
  return result;
}

export function contentFieldIds(controlledFields) {
  if (!controlledFields || controlledFields.length === 0) return [];
  const result = [];
  for (let i = 0; i < controlledFields.length; i++) {
    const fId = controlledFields[i].field_id;
    if (!isStructuralField(fId)) {
      result.push(typeof fId === 'string' ? fId : String(fId));
    }
  }
  return result;
}
