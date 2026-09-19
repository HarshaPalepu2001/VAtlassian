/**
 * Which tracked fields describe the SHAPE of a tree rather than its contents.
 *
 * ─── WHY THIS DISTINCTION HAD TO BE MADE EXPLICIT ────────────────────────────
 *
 * `parent` and `subtasks` are tracked like any other field, and they should be:
 * a baseline that did not cover an item's place in the hierarchy would not
 * cover the hierarchy at all. But their VALUES are Jira-assigned issue ids, and
 * an id is not content. That difference is not academic — it produced three
 * separate failures on one work item:
 *
 *   · A restore that recreated a deleted child put every approved value back,
 *     and the parent's `subtasks` list then held the replacement's NEW id. The
 *     digest could never equal the approved one again, so verification refused
 *     to say COMPLETE — for ever, on every retry. COMPLETE_WITH_REPLACEMENTS
 *     existed in the state machine and was unreachable.
 *
 *   · The planner turned that same difference into a field write, and
 *     `subtasks` is read-only in Jira: the PUT is refused, which aborted the
 *     batch, which left the item in ERROR, which made the workflow gate deny
 *     every subsequent transition.
 *
 *   · `parent` was filtered out of field writes by hand — the right call — but
 *     the verifier still demanded its digest match, so a difference nothing was
 *     allowed to fix decided the outcome.
 *
 * ─── THE RULE, AND WHY IT LOSES NOTHING ──────────────────────────────────────
 *
 * Shape is captured, restored and verified STRUCTURALLY: as nodes and edges.
 * diffTree already reports NODE_ADDED, NODE_REMOVED and NODE_MOVED, and the
 * restore already acts on them through CREATE_REPLACEMENT, DELETE_ADDED_NODE
 * and MOVE_NODE. Comparing `parent` and `subtasks` as digests measured the same
 * fact a second time, in the one representation that a legitimate restore is
 * guaranteed to change.
 *
 * So this narrows nothing. A deleted subtask is still caught — as NODE_REMOVED,
 * which names the item instead of reporting an opaque list difference on its
 * parent. A re-parented child is still caught — as NODE_MOVED, which says where
 * it came from and where it went. Every subtask is still baselined in full,
 * with all of its own controlled fields, because it is a node of the tree.
 *
 * These ids are still CAPTURED and still hashed into the baseline. They are
 * simply not the thing that decides whether a restore succeeded.
 */

export const STRUCTURAL_FIELD_IDS = new Set(['parent', 'subtasks']);

export function isStructuralField(fieldId) {
  return STRUCTURAL_FIELD_IDS.has(String(fieldId));
}

/**
 * The controlled fields whose VALUES a tree diff compares and a tree restore
 * writes back — everything except the structural ids above.
 */
export function contentFields(controlledFields) {
  return (controlledFields ?? []).filter(field => !isStructuralField(field.field_id));
}

export function contentFieldIds(controlledFields) {
  return contentFields(controlledFields).map(field => String(field.field_id));
}
