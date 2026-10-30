import { normaliseField, fieldDigest } from '../content.js';
import { governedLinks } from '../linkPolicy.js';

/**
 * Pure restore outcome and digest functions. Keep them separate from
 * executor.js, which imports @forge/api and requires the Forge runtime.
 */

export const OUTCOME = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  IRREVERSIBLE: 'irreversible'
};

export const RESTORE_STATE = {
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED'
};

/**
 * Compute the digest Jira's stored value should produce. Match content.js
 * project() exactly so the collector recognizes restore writes instead of
 * recording them as fresh drift. project() hashes a full projection, while
 * this function hashes one field. Update both if the formula changes.
 * test/restore.test.js compares them for every field kind.
 */
export function digestOf(field, value, context = {}) {
  if (field.field_kind === 'LINKS') value = governedLinks(value, context);
  let normalised;
  try {
    normalised = normaliseField(field.field_kind, value);
  } catch {
    // Hash unknown kinds as raw values so a restore can continue. Write
    // suppression may miss and report fresh drift, but the write is not refused.
    normalised = value ?? null;
  }
  return fieldDigest(field, normalised, context);
}

/**
 * Build va_restore counters from field outcomes. Written but unverified
 * fields count as failed. unmatched includes every tracked field that fails
 * read-back, including fields this restore did not write. COMPLETE requires
 * the entire tracked projection to match the baseline.
 */
export function tally(detail, unmatched = []) {
  const counters = {
    attempted: detail.length, succeeded: 0, failed: 0, skipped: 0,
    irreversible: 0, unmatched: unmatched.length
  };
  for (const d of detail) {
    if (d.outcome === OUTCOME.SUCCEEDED && d.verified) counters.succeeded++;
    else if (d.outcome === OUTCOME.IRREVERSIBLE) counters.irreversible++;
    else if (d.outcome === OUTCOME.SKIPPED) counters.skipped++;
    else counters.failed++;
  }

  let state = counters.failed > 0
    ? (counters.succeeded > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.FAILED)
    : (counters.irreversible > 0 || counters.skipped > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.COMPLETE);

  // The whole-baseline gate. Nothing else in this file may promote a state to
  // COMPLETE, and this may only demote.
  if (counters.unmatched > 0 && state === RESTORE_STATE.COMPLETE) {
    state = counters.succeeded > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.FAILED;
  }

  return { counters, state };
}
