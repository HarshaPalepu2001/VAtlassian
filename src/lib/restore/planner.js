import { FIELD_KIND } from '../content.js';
import { RESTORABLE, specialHandlerFor } from '../diff/fields.js';
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

  for (const fieldDiff of diff.fields) {
    // Formatting-only changes are left alone. Reverting a bolded word is not
    // what "restore the approved state" means to anybody, and doing it would
    // fill the item's history with edits nobody asked for.
    if (!fieldDiff.semanticChange) continue;

    const field = byId.get(fieldDiff.fieldId);
    if (!field) continue;

    const restorable = fieldDiff.restorable;
    const reason = fieldDiff.restorableReason;
    const handler = specialHandlerFor(fieldDiff.fieldId);

    if (restorable === RESTORABLE.NO || restorable === RESTORABLE.NOT_RETAINED) {
      steps.push({
        fieldId: fieldDiff.fieldId,
        fieldName: fieldDiff.fieldName,
        strategy: 'none',
        targetValue: null,
        restorable,
        reason
      });
      cannotRestore.push({ fieldName: fieldDiff.fieldName, reason });
      continue;
    }

    // The RAW stored value, not the normalised one the differ compared. This is
    // the single most important line in the module: normalisation sorts
    // multi-values and strips ADF node ids, so writing the normalised form back
    // would be a silent, uninvited second edit to a field we are supposed to be
    // returning to exactly how it was.
    const target = baselineValues[fieldDiff.fieldId];

    if (handler) {
      steps.push({
        fieldId: fieldDiff.fieldId,
        fieldName: fieldDiff.fieldName,
        strategy: handler,
        targetValue: target,
        restorable: RESTORABLE.SPECIAL,
        reason
      });
      needsHandler.push(fieldDiff.fieldName);
      continue;
    }

    const shaped = writeShape({ field, value: target, editmeta });
    fieldWrites[fieldDiff.fieldId] = shaped;
    steps.push({
      fieldId: fieldDiff.fieldId,
      fieldName: fieldDiff.fieldName,
      strategy: 'field',
      targetValue: shaped,
      restorable: RESTORABLE.YES,
      reason: null
    });
    willRestore.push(fieldDiff.fieldName);
  }

  return {
    issueId: diff.issueId,
    baselineId: diff.baselineId,
    baselineVersion: diff.baselineVersion,
    steps,
    fieldWrites,
    preflight: { willRestore, needsHandler, cannotRestore },
    // Shown as the dialog's headline. A reviewer deciding whether to reject
    // needs the shape of the outcome in one glance, not a list to count.
    summary: describePlan(willRestore, needsHandler, cannotRestore)
  };
}

function describePlan(willRestore, needsHandler, cannotRestore) {
  const parts = [];
  const restorable = willRestore.length + needsHandler.length;
  if (restorable > 0) {
    parts.push(`${restorable} field${restorable === 1 ? '' : 's'} will be returned to the approved value`);
  }
  if (cannotRestore.length > 0) {
    parts.push(`${cannotRestore.length} cannot be restored`);
  }
  if (parts.length === 0) return 'Nothing to restore — every change is formatting only.';
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
