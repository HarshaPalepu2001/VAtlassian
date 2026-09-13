import { canonical, sha256Hex } from './hash.js';
import { controlledAuthenticationMethod } from './approval/levels.js';
import { FailClosed } from './errors.js';

function booleanClassification(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

/**
 * Fingerprint the exact controlled-field catalogue used for capture.
 *
 * The content digest intentionally excludes retention and restore metadata;
 * this second digest freezes those controls without changing what counts as a
 * content edit. Ordering is by Jira field id so database and Jira response
 * ordering cannot create different provenance for the same catalogue.
 */
export function controlledFieldsHash(controlledFields, writable = {}) {
  const entries = (controlledFields ?? []).map(field => {
    const fieldId = String(field.field_id ?? '');
    const capturedWritable = Object.prototype.hasOwnProperty.call(writable, fieldId)
      ? writable[fieldId]
      : field.writable;
    return {
      fieldId,
      fieldKind: field.field_kind == null ? null : String(field.field_kind),
      materiality: field.materiality == null ? null : String(field.materiality),
      schemaType: field.schema_type == null ? null : String(field.schema_type),
      storeValues: booleanClassification(field.store_values),
      writable: booleanClassification(capturedWritable)
    };
  }).sort((left, right) => left.fieldId.localeCompare(right.fieldId));

  return sha256Hex(canonical(entries));
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Require every immutable control fact before a new baseline can publish. */
export function requireBaselineProvenance(baseline) {
  let validAssurance = false;
  try {
    controlledAuthenticationMethod(baseline?.required_assurance);
    validAssurance = true;
  } catch {
    // Converted to the baseline-specific fail-closed reason below.
  }
  if (!present(baseline?.transition_id)
    || !present(baseline?.from_status_id)
    || !present(baseline?.to_status_id)
    || !present(baseline?.required_role)
    || !validAssurance
    || !/^[a-f0-9]{64}$/.test(baseline?.controlled_fields_hash ?? '')) {
    throw new FailClosed('BASELINE_POLICY_INCOMPLETE');
  }
  return baseline;
}

/** Read drift authority only from the immutable baseline row. */
export function baselinePolicy(baseline) {
  requireBaselineProvenance(baseline);
  const version = Number(baseline?.version);
  if (baseline?.baseline_id == null || !Number.isSafeInteger(version) || version < 1) {
    throw new FailClosed('BASELINE_POLICY_INCOMPLETE');
  }
  return Object.freeze({
    baselineId: baseline.baseline_id,
    version,
    transitionId: String(baseline.transition_id),
    reviewStatusId: String(baseline.from_status_id),
    destinationStatusId: String(baseline.to_status_id),
    requiredRole: baseline.required_role,
    requiredAssurance: baseline.required_assurance,
    controlledFieldsHash: baseline.controlled_fields_hash
  });
}
