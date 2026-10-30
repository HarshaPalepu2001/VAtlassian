import { FIELD_KIND } from '../content.js';

/**
 * Shape baseline values for PUT /rest/api/3/issue/{key}. Choose adapters by
 * field identity, then refine by schema. Jira labels description and environment
 * as strings while accepting ADF. A generic string conversion would write
 * "[object Object]" instead of the approved document.
 *
 * Return { ok, value, adapter, reason }. Do not coerce values lossily.
 * The planner presents ok: false as a preflight reason before rejection.
 * This module performs no I/O and reads no clock or database.
 */

/** Bumped whenever these rules change, so a restore can record which ran. */
export const ADAPTER_VERSION = 2;

const ADF_SYSTEM_FIELDS = new Set(['description', 'environment']);
const ADF_CUSTOM_SUFFIXES = [':textarea'];

export function isAdfField({ field, schema }) {
  if (field?.field_kind === FIELD_KIND.ADF) return true;
  if (schema?.type === 'doc') return true;
  if (schema?.system && ADF_SYSTEM_FIELDS.has(schema.system)) return true;
  if (typeof schema?.custom === 'string'
      && ADF_CUSTOM_SUFFIXES.some((s) => schema.custom.endsWith(s))) return true;
  return false;
}

const ok = (value, adapter) => ({ ok: true, value, adapter, reason: null });
const refuse = (adapter, reason) => ({ ok: false, value: null, adapter, reason });

export function shapeFor({ field, value, editmeta = {} }) {
  const meta = editmeta?.[field.field_id];
  const schema = meta?.schema ?? { type: inferType(field.field_kind) };
  const { type, items } = schema;

  // ── ADF first, before any schema.type dispatch ───────────────────────────
  if (isAdfField({ field, schema })) {
    if (value === null || value === undefined) return ok(null, 'adf');
    if (typeof value !== 'object') {
      return refuse('adf', 'The approved value for this rich-text field was not stored as a document, so writing it back would change its formatting. Restore it by hand from the diff.');
    }
    // Verbatim. Writing a normalised document back would strip the localIds
    // Jira put there and count as a second edit.
    return ok(value, 'adf');
  }

  if (value === null || value === undefined) {
    // Jira accepts null for most fields and an empty array for multi-valued
    // ones; sending null to an array field is a 400.
    return ok(type === 'array' ? [] : null, 'clear');
  }

  switch (type) {
    case 'string':
      if (typeof value === 'string') return ok(value, 'string');
      if (typeof value === 'number' || typeof value === 'boolean') return ok(String(value), 'string');
      return refuse('string', 'Jira reports this field as plain text but the approved value is a structured value. Writing it would store a placeholder instead of the content.');

    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return refuse('number', 'The approved value is not a number Jira will accept.');
      return ok(n, 'number');
    }

    case 'date':
      // YYYY-MM-DD. An ISO datetime is rejected by a date field.
      if (typeof value !== 'string') return refuse('date', 'The approved value is not a date Jira will accept.');
      return ok(value.slice(0, 10), 'date');

    case 'datetime':
      if (typeof value !== 'string') return refuse('datetime', 'The approved value is not a timestamp Jira will accept.');
      return ok(value, 'datetime');

    case 'user': {
      const id = idOf(value, 'accountId');
      return id == null
        ? refuse('user', 'The approved value does not carry an account id, so the user cannot be identified.')
        : ok(id, 'user');
    }

    case 'option-with-child': {
      const parent = idOf(value, 'id');
      if (parent == null) return refuse('cascading', 'The approved value does not carry an option id.');
      const hasChild = value && typeof value === 'object' && value.child != null;
      if (!hasChild) return ok(parent, 'cascading');
      const childId = value.child?.id ?? null;
      if (childId == null) {
        return refuse('cascading', 'The approved value records a child option with no id, so restoring the parent alone would silently lose the second selection.');
      }
      return ok({ ...parent, child: { id: String(childId) } }, 'cascading');
    }

    case 'priority':
    case 'resolution':
    case 'issuetype':
    case 'securitylevel':
    case 'option': {
      const id = idOf(value, 'id');
      return id == null
        ? refuse('option', 'The approved value does not carry an option id.')
        : ok(id, 'option');
    }

    case 'timetracking':
      return ok({
        originalEstimate: value.originalEstimate ?? undefined,
        remainingEstimate: value.remainingEstimate ?? undefined
      }, 'timetracking');

    case 'array': {
      const arr = Array.isArray(value) ? value : [value];
      // Labels are bare strings; everything else entity-backed wants ids.
      if (items === 'string' || field.field_id === 'labels') {
        if (arr.some(v => typeof v !== 'string')) return refuse('labels', 'The approved list contains non-text entries; converting them to labels would lose content.');
        return ok(arr, 'labels');
      }
      const key = items === 'user' ? 'accountId' : 'id';
      const mapped = arr.map((v) => idOf(v, key));
      if (mapped.some((v) => v == null)) {
        return refuse('array', `One or more approved entries do not carry ${items === 'user' ? 'an account id' : 'an id'}, so the list cannot be restored exactly.`);
      }
      return ok(mapped, key === 'accountId' ? 'multi-user' : 'multi-entity');
    }

    default:
      // An unrecognised schema is written as-is. It may fail, and if it does
      // the executor's per-field retry reports exactly which field and why,
      // which is more useful than refusing to try.
      return ok(value, 'passthrough');
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
    const id = value[key];
    return id == null || !['string', 'number'].includes(typeof id) || String(id) === '' ? null : { [key]: String(id) };
  }
  return { [key]: String(value) };
}
