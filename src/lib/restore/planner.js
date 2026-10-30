import { FIELD_KIND } from '../content.js';
import { RESTORABLE, specialHandlerFor, restorability, restorabilityReason } from '../diff/fields.js';
import { shapeFor, ADAPTER_VERSION } from './adapters.js';
import { adfMediaIds } from '../attachmentIdentity.js';

export { ADAPTER_VERSION };

/**
 * Plan a rejection before changing Jira content.
 *
 * The confirmation dialog names every field that cannot be restored and gives
 * its reason before the reviewer signs. It must not imply a complete restore
 * when the plan will leave fields changed.
 *
 * These functions perform no I/O and use no clock or database.
 */

/**
 * Use adapters.js to shape Jira field writes by field identity and schema.
 * The named export returns a bare value for existing callers and
 * test/baseline-restore.test.js. New callers should use shapeFor and handle
 * ok: false.
 */
export function writeShape({ field, value, editmeta }) {
  return shapeFor({ field, value, editmeta }).value;
}

/**
 * Build the plan.
 *
 * @param diff              from lib/diff/index.js diffIssue
 * @param baselineValues    { fieldId: rawValue } from va_baseline_value
 * @param controlledFields  the field definitions, with `writable` from editmeta
 * @param editmeta          `fields` from GET /issue/{key}/editmeta
 *
 * @returns {
 *   steps: [{ fieldId, fieldName, strategy, targetValue, restorable, reason }],
 *   preflight: { willRestore, needsHandler, cannotRestore },
 *   fieldWrites: { fieldId: shapedValue }   // the bulk PUT payload
 * }
 */
export function planRestore({ diff, baselineValues = {}, controlledFields = [], editmeta = {} }) {
  const byId = new Map(controlledFields.map((f) => [f.field_id, f]));
  const steps = [];
  const fieldWrites = {};

  const willRestore = [];
  const needsHandler = [];
  const cannotRestore = [];
  const formattingOnly = [];
  // Preflight names files that rejection permanently deletes and files it
  // re-uploads. attachmentPreflight.js checks vault availability separately
  // because this planner performs no I/O.
  const attachments = { willDelete: [], willRestore: [] };

  for (const fieldDiff of diff.fields) {
    // Restore every changed field, including formatting-only changes.
    // semanticChange affects review presentation, not which values are restored.
    if (fieldDiff.changed === false) continue;
    const formattingOnlyChange = fieldDiff.semanticChange === false;

    const field = byId.get(fieldDiff.fieldId);
    if (!field) continue;

    // Capture-time editability is advisory. Re-evaluate it using the current
    // restore metadata, while preserving irreversible and unretained refusals.
    const currentWritable = field.writable === false && Object.hasOwn(editmeta, fieldDiff.fieldId);
    const currentField = { ...field, writable: true };
    const retained = Object.hasOwn(baselineValues, fieldDiff.fieldId) && baselineValues[fieldDiff.fieldId] !== undefined;
    const restorable = currentWritable ? restorability(currentField, retained) : fieldDiff.restorable;
    const reason = currentWritable ? restorabilityReason(currentField, retained) : fieldDiff.restorableReason;
    const handler = specialHandlerFor(fieldDiff.fieldId);

    if (restorable === RESTORABLE.NO || restorable === RESTORABLE.NOT_RETAINED) {
      steps.push({
        fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: 'none', targetValue: null, restorable, reason
      });
      cannotRestore.push({ fieldName: fieldDiff.fieldName, reason });
      continue;
    }

    // The RAW stored value, not the normalised one the differ compared:
    // normalisation sorts multi-values and strips ADF node ids, so writing the
    // normalised form back would be a silent, uninvited second edit.
    const target = baselineValues[fieldDiff.fieldId];

    let refusal = null;
    if (!Object.hasOwn(baselineValues, fieldDiff.fieldId) || target === undefined) {
      refusal = 'The approved raw value is missing from storage. Restore cannot infer an empty value from missing data.';
    } else if ((!handler || handler === 'parent' || handler === 'sprint')
        && (!Object.hasOwn(editmeta, fieldDiff.fieldId)
          || (editmeta[fieldDiff.fieldId]?.operations && !editmeta[fieldDiff.fieldId].operations.includes('set')))) {
      refusal = 'Jira does not currently permit setting this field through its edit screen. Check field configuration and permissions.';
    }
    if (refusal) {
      steps.push({ fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: 'none', targetValue: null, restorable: RESTORABLE.NO, reason: refusal });
      cannotRestore.push({ fieldName: fieldDiff.fieldName, reason: refusal });
      continue;
    }

    if (handler === 'attachments') {
      const file = x => ({ id: String(x?.id ?? ''), filename: x?.filename ?? '' });
      attachments.willDelete.push(...(fieldDiff.added ?? []).map(file));
      attachments.willRestore.push(...(fieldDiff.removed ?? []).map(file));
    }
    if (handler) {
      if (formattingOnlyChange) formattingOnly.push(fieldDiff.fieldName);
      steps.push({
        fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: handler, targetValue: target,
        restorable: RESTORABLE.SPECIAL, reason
      });
      needsHandler.push(fieldDiff.fieldName);
      continue;
    }

    const shaped = shapeFor({ field, value: target, editmeta });
    if (!shaped.ok) {
      // The adapter refused rather than coercing. Named here so the reviewer
      // reads it in the confirmation dialog, not afterwards in a failure list.
      steps.push({
        fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: 'none', targetValue: null,
        restorable: RESTORABLE.NO, reason: shaped.reason
      });
      cannotRestore.push({ fieldName: fieldDiff.fieldName, reason: shaped.reason });
      continue;
    }

    fieldWrites[fieldDiff.fieldId] = shaped.value;
    if (formattingOnlyChange) formattingOnly.push(fieldDiff.fieldName);
    steps.push({
      fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
      strategy: 'field', targetValue: shaped.value,
      restorable: RESTORABLE.YES, reason: null, adapter: shaped.adapter
    });
    willRestore.push(fieldDiff.fieldName);
  }

  const repoint = attachments.willRestore.length > 0
    ? repointCandidates({ byId, baselineValues, editmeta, planned: new Set(steps.map(step => step.fieldId)) })
    : [];

  return {
    issueId: diff.issueId,
    baselineId: diff.baselineId,
    baselineVersion: diff.baselineVersion,
    adapterVersion: ADAPTER_VERSION,
    steps,
    fieldWrites,
    repoint,
    preflight: { willRestore, needsHandler, cannotRestore, formattingOnly, attachments,
      richTextRepoint: repoint.map(candidate => candidate.fieldName) },
    summary: describePlan(willRestore, needsHandler, cannotRestore, formattingOnly)
  };
}

/**
 * Consider unchanged tracked rich text when restoring files. Deleting a
 * file leaves its description pointer intact, but the restored copy has a
 * new media id. The executor rewrites a candidate only if a pointer changes.
 * List it in preflight because the field may be written.
 */
function repointCandidates({ byId, baselineValues, editmeta, planned }) {
  const candidates = [];
  for (const [fieldId, field] of byId) {
    if (planned.has(fieldId) || !Object.hasOwn(baselineValues, fieldId)) continue;
    const value = baselineValues[fieldId];
    if (!value || typeof value !== 'object' || value.type !== 'doc' || adfMediaIds(value).length === 0) continue;
    if (!Object.hasOwn(editmeta, fieldId) || (editmeta[fieldId]?.operations && !editmeta[fieldId].operations.includes('set'))) continue;
    const shaped = shapeFor({ field: { ...field, writable: true }, value, editmeta });
    if (!shaped.ok) continue;
    candidates.push({ fieldId, fieldName: field.field_name ?? fieldId, targetValue: shaped.value });
  }
  return candidates;
}

function describePlan(willRestore, needsHandler, cannotRestore, formattingOnly = []) {
  const parts = [];
  const restorable = willRestore.length + needsHandler.length;
  if (restorable > 0) {
    parts.push(`${restorable} field${restorable === 1 ? '' : 's'} will be returned to the approved value`);
  }
  if (formattingOnly.length > 0) {
    // Include the field in preflight even when only its media pointer changes.
    parts.push(`${formattingOnly.length} of them differ only in formatting`);
  }
  if (cannotRestore.length > 0) {
    parts.push(`${cannotRestore.length} cannot be restored`);
  }
  if (parts.length === 0) return 'Nothing to restore. This work item matches its approved values.';
  return `${parts.join(', ')}.`;
}

/**
 * Disable rejection if it can restore no fields. Explain the reason, such
 * as disabled value retention, so the reviewer can seek an administrator's help.
 */
export function canRestoreAnything(plan) {
  return plan.steps.some((s) => s.strategy !== 'none');
}
