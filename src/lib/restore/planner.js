import { FIELD_KIND } from '../content.js';
import { RESTORABLE, specialHandlerFor, restorability, restorabilityReason } from '../diff/fields.js';
import { shapeFor, ADAPTER_VERSION } from './adapters.js';

export { ADAPTER_VERSION };

/**
 * Deciding what a rejection will do, BEFORE it does any of it.
 *
 * THE RULE THIS MODULE ENFORCES: there is no path where a reviewer clicks
 * Reject and discovers afterwards that two fields were quietly left drifted.
 * Everything that cannot be restored is named in the confirmation dialog, with
 * a reason, before they confirm. An app whose promise is "one click puts it
 * back exactly" has to be exact about what it cannot put back — and the
 * temptation to soften that, to make the button feel more powerful, is
 * precisely the thing that would make it untrustworthy.
 *
 * Pure. No I/O, no clock, no database.
 */

/**
 * How each field kind is written back to Jira.
 *
 * The rules live in ./adapters.js so they can be tested exhaustively without
 * the planner, and so field IDENTITY — not just `schema.type` — decides the
 * adapter. See that module's header for why the previous schema-type switch
 * wrote "[object Object]" into description fields.
 *
 * Kept as a named export returning the bare value because existing callers and
 * test/baseline-restore.test.js read it that way. New code should call
 * `shapeFor` and honour `ok: false`.
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

  for (const fieldDiff of diff.fields) {
    // EVERY entry in diff.fields is integrity drift: lib/diff/index.js only
    // pushes a field whose normalised value differs from the baseline. A
    // formatting-only change is still a change to the record, so it is still
    // restored — `semanticChange` decides what the reviewer is TOLD, never
    // what is written. Skipping here is how a restore reported COMPLETE while
    // a tracked field was still wrong.
    if (fieldDiff.changed === false) continue;
    if (fieldDiff.semanticChange === false) formattingOnly.push(fieldDiff.fieldName);

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

    if (handler) {
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
    steps.push({
      fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
      strategy: 'field', targetValue: shaped.value,
      restorable: RESTORABLE.YES, reason: null, adapter: shaped.adapter
    });
    willRestore.push(fieldDiff.fieldName);
  }

  return {
    issueId: diff.issueId,
    baselineId: diff.baselineId,
    baselineVersion: diff.baselineVersion,
    adapterVersion: ADAPTER_VERSION,
    steps,
    fieldWrites,
    preflight: { willRestore, needsHandler, cannotRestore, formattingOnly },
    summary: describePlan(willRestore, needsHandler, cannotRestore, formattingOnly)
  };
}

function describePlan(willRestore, needsHandler, cannotRestore, formattingOnly = []) {
  const parts = [];
  const restorable = willRestore.length + needsHandler.length;
  if (restorable > 0) {
    parts.push(`${restorable} field${restorable === 1 ? '' : 's'} will be returned to the approved value`);
  }
  if (formattingOnly.length > 0) {
    // Said out loud rather than silently skipped. The field IS being written —
    // the reviewer just deserves to know the visible difference is small.
    parts.push(`${formattingOnly.length} of them differ only in formatting`);
  }
  if (cannotRestore.length > 0) {
    parts.push(`${cannotRestore.length} cannot be restored`);
  }
  if (parts.length === 0) return 'Nothing to restore — this work item matches its approved values.';
  return `${parts.join(', ')}.`;
}

/**
 * Is rejecting worth offering at all?
 *
 * A reject that can restore nothing is not a reject, and presenting the button
 * as though it does something would be the app lying about its own capability.
 * The panel disables it and explains why — usually that no field has value
 * retention turned on, which is an administrator's decision the reviewer cannot
 * fix from here and should not be blamed for.
 */
export function canRestoreAnything(plan) {
  return plan.steps.some((s) => s.strategy !== 'none');
}
