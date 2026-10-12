import { canonical, sha256Hex } from '../hash.js';
import { FailClosed } from '../errors.js';
import { planTreeRestore } from '../tree/restorePlan.js';

/**
 * PER-FIELD DRIFT DECISIONS (docs/superpowers/specs/2026-10-07-drift-field-decision-design.md).
 *
 * A reviewer chooses APPROVE or REJECT for every changed field. Rather than
 * teaching the restore planner and verifier a second vocabulary, the choice is
 * expressed as a TARGET TREE: the approved baseline, with each APPROVED field's
 * digest replaced by the live one. Restoring the live tree to that target
 * touches exactly the rejected fields, and verifying against it checks exactly
 * the rejected fields at their approved value and the approved fields still at
 * the value the reviewer saw.
 *
 * Pure. No I/O, no clock, no database.
 */

export const MIXED_INTENT = 'DRIFT_MIXED';
const CHOICES = new Set(['APPROVE', 'REJECT']);
const CANNOT_RESTORE = new Set(['NO', 'NOT_RETAINED']);
const bad = reason => { throw new FailClosed(reason); };
const isStructure = field => field?.group?.kind === 'STRUCTURE' || String(field?.fieldId ?? '').startsWith('tree:');

/** Sorted by stable field identity so order can never change the meaning. */
export function canonicalDecisions(decisions) {
  if (!Array.isArray(decisions)) bad('DECISION_MAP_INVALID');
  const seen = new Set();
  const out = decisions.map(entry => {
    const fieldId = entry?.fieldId;
    if (typeof fieldId !== 'string' || !fieldId || !CHOICES.has(entry?.decision) || seen.has(fieldId)) bad('DECISION_MAP_INVALID');
    seen.add(fieldId);
    return { fieldId, decision: entry.decision };
  });
  return out.sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0));
}

export const decisionMapHash = canon => sha256Hex(canonical(canon));

/**
 * Exact one-to-one coverage of the AUTHORITATIVE review fields, and no REJECT on
 * anything that cannot be written back. `reviewFields` is the server's own
 * reviewDiff.fields; the browser's list is never consulted.
 */
export function validateDecisions({ decisions, reviewFields }) {
  if ((reviewFields ?? []).some(isStructure)) bad('MIXED_STRUCTURE_UNSUPPORTED');
  const canon = canonicalDecisions(decisions);
  const byId = new Map((reviewFields ?? []).map(field => [field.fieldId, field]));
  if (canon.length !== byId.size || canon.some(entry => !byId.has(entry.fieldId))) bad('DECISION_MAP_MISMATCH');
  const approved = [], rejected = [];
  for (const { fieldId, decision } of canon) {
    const field = byId.get(fieldId);
    if (decision === 'REJECT') {
      if (CANNOT_RESTORE.has(field.restorable) || field.retained === false) bad('FIELD_NOT_RESTORABLE');
      rejected.push(field);
    } else approved.push(field);
  }
  return { decisions: canon, approved, rejected };
}

/** The approved baseline with each APPROVED field's digest replaced by the live one. */
export function targetTreeFor({ baselineTree, currentTree, approved }) {
  const overlay = {};
  const live = new Map((currentTree?.nodes ?? []).map(node => [node.logicalNodeId, node]));
  for (const field of approved) {
    const digest = live.get(field.logicalNodeId)?.digests?.[field.rawFieldId];
    if (digest === undefined) bad('DECISION_MAP_MISMATCH');
    (overlay[field.logicalNodeId] ??= {})[field.rawFieldId] = digest;
  }
  return { targetTree: applyOverlay({ baselineTree, overlay }), overlay };
}

/**
 * Rebuilds the target from a FROZEN overlay. The restore worker uses this so an
 * edit to an approved field after signing fails verification instead of being
 * silently accepted as part of the target.
 */
export function applyOverlay({ baselineTree, overlay }) {
  const nodes = (baselineTree?.nodes ?? []).map(node => {
    const changes = Object.entries(overlay?.[node.logicalNodeId] ?? {});
    if (changes.length === 0) return node;
    // Tree nodes expose planning aliases such as `digests` as non-enumerable,
    // read-only properties. Recreate the object with the replacement value in
    // its descriptor instead of assigning through that read-only property.
    const descriptors = Object.getOwnPropertyDescriptors(node);
    if (descriptors.digests) descriptors.digests = {
      ...descriptors.digests,
      value: { ...node.digests, ...Object.fromEntries(changes) }
    };
    else descriptors.digests = {
      value: { ...node.digests, ...Object.fromEntries(changes) }, enumerable: false,
      writable: false, configurable: false
    };
    return Object.create(Object.getPrototypeOf(node), descriptors);
  });
  return { ...baselineTree, nodes };
}

export function planMixed({ decisions, reviewFields, baselineTree, currentTree, controlledFields, fieldsFor }) {
  const valid = validateDecisions({ decisions, reviewFields });
  const { targetTree, overlay } = targetTreeFor({ baselineTree, currentTree, approved: valid.approved });
  let restore;
  try {
    restore = planTreeRestore({ baselineTree: targetTree, currentTree, controlledFields, fieldsFor });
  } catch (error) {
    if (error?.reason === 'BASELINE_VALUES_REQUIRED') bad('FIELD_NOT_RESTORABLE');
    throw error;
  }
  const mapHash = decisionMapHash(valid.decisions);
  return { ...valid, mapHash, overlay, targetTree, restore,
    planHash: sha256Hex(canonical({ mapHash, steps: restore.steps.map(step => step.stepKey) })) };
}

/**
 * The mixed decision as `prepareApproval` hands it to the rest of the approval
 * path: ids and hashes only, never values. Refuses a baseline that is not a
 * tree, since only a tree has the per-node digests the target is built from.
 */
export function mixedPrepared({ decisions, prepared }) {
  if (!prepared?.baselineTree || !prepared?.currentTree) bad('MIXED_UNAVAILABLE');
  const plan = planMixed({ decisions, reviewFields: prepared.reviewDiff?.fields ?? [],
    baselineTree: prepared.baselineTree, currentTree: prepared.currentTree,
    controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor });
  return { planHash: plan.planHash, mapHash: plan.mapHash, decisions: plan.decisions,
    approvedIds: plan.approved.map(field => field.fieldId), rejectedIds: plan.rejected.map(field => field.fieldId),
    overlay: plan.overlay, restore: plan.restore };
}

/**
 * What the evidence payload tells the client about the mixed workflow.
 * `authoritativeCount` is the unfiltered field count; when the viewer's
 * visibility filter removed some, an exact map cannot be built from what they
 * can see, so the workflow is withheld rather than revealing the hidden items.
 */
export function mixedEligibility({ baseline, baselineTree = null, reviewFields, authoritativeCount = null }) {
  // A child written by a parent capture has an ordinary field-level baseline
  // row, but panelAccess may have reconstructed its authoritative subtree from
  // that row's capture provenance. Capability follows that effective evidence,
  // not the storage shape of the clicked node's row.
  if (!baseline?.tree_hash && !baselineTree?.nodes?.length) {
    return { eligible: false, reason: 'NOT_TREE_BASELINE', fields: [] };
  }
  if ((reviewFields ?? []).some(isStructure)) return { eligible: false, reason: 'STRUCTURE_CHANGED', fields: [] };
  if (authoritativeCount != null && Number(authoritativeCount) !== (reviewFields ?? []).length) {
    return { eligible: false, reason: 'HIDDEN_CHANGES', fields: [] };
  }
  return { eligible: true, reason: null, fields: (reviewFields ?? []).map(field => ({
    fieldId: field.fieldId, restorable: field.restorable ?? null, retained: field.retained !== false })) };
}
