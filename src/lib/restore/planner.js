import { FIELD_KIND } from '../content.js';
import { RESTORABLE, specialHandlerFor } from '../diff/fields.js';

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
 * Derived from the STORED SCHEMA plus live editmeta, never guessed from the
 * value's runtime shape: a `null` tells you nothing about whether the field
 * wants `{ id }` or a bare string, and getting it wrong produces a 400 that
 * looks like a permissions problem.
 */
export function writeShape({ field, value, editmeta }) {
  const meta = editmeta?.[field.field_id];
  const schema = meta?.schema ?? { type: inferType(field.field_kind) };
  const { type, items } = schema;

  if (value === null || value === undefined) {
    // Explicitly clearing. Jira accepts null for most fields and an empty array
    // for multi-valued ones; sending null to an array field is a 400.
    return type === 'array' ? [] : null;
  }

  switch (type) {
    case 'doc':
      // ADF is written verbatim. This is the one field type where the stored
      // RAW value matters absolutely: writing back a normalised document would
      // strip localIds Jira put there and count as a second edit.
      return value;

    case 'string':
      return typeof value === 'string' ? value : String(value);

    case 'number':
      return typeof value === 'number' ? value : Number(value);

    case 'date':
      // YYYY-MM-DD. An ISO datetime is rejected by a date field.
      return typeof value === 'string' ? value.slice(0, 10) : null;

    case 'datetime':
      return typeof value === 'string' ? value : null;

    case 'user':
      return idOf(value, 'accountId');

    case 'priority':
    case 'resolution':
    case 'issuetype':
    case 'securitylevel':
    case 'option':
    case 'option-with-child':
      return idOf(value, 'id');

    case 'timetracking':
      return {
        originalEstimate: value.originalEstimate ?? undefined,
        remainingEstimate: value.remainingEstimate ?? undefined
      };

    case 'array': {
      const arr = Array.isArray(value) ? value : [value];
      // Labels are bare strings; everything else entity-backed wants ids.
      if (items === 'string' || field.field_id === 'labels') return arr.map(String);
      if (items === 'user') return arr.map((v) => idOf(v, 'accountId'));
      return arr.map((v) => idOf(v, 'id'));
    }

    default:
      // An unrecognised schema is written as-is. It may fail, and if it does the
      // executor's per-field retry reports exactly which field and why —
      // which is far more useful than refusing to try and telling the reviewer
      // nothing.
      return value;
  }
}

function inferType(kind) {
  switch (kind) {
    case FIELD_KIND.ADF: return 'doc';
    case FIELD_KIND.TEXT: return 'string';
    case FIELD_KIND.MULTI: return 'array';
    default: return 'string';
  }
}

function idOf(value, key) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const id = value[key] ?? value.id ?? value.value ?? value.key;
    return id == null ? null : { [key]: String(id) };
  }
  return { [key]: String(value) };
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
