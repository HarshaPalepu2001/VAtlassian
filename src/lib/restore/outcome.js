import { normaliseField, fieldDigest } from '../content.js';
import { governedLinks } from '../linkPolicy.js';

/**
 * The pure half of a restore: what an outcome means, and what digest a written
 * value will produce.
 *
 * SEPARATE FROM executor.js ON PURPOSE. The executor imports @forge/api, so
 * anything in that file is unreachable outside the Forge runtime — including,
 * until this split, the two functions that most need testing. Correctness rules
 * belong somewhere a test can reach them without a platform — the same
 * reasoning that keeps lib/interception.js and lib/decision.js pure.
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
 * The digest a written value WILL produce once Jira stores it.
 *
 * THE SUPPRESSION CONTRACT. This must match exactly what content.js's project()
 * computes when the collector next reads the issue, or the write-suppression
 * entry will not match and the restore will be recorded as fresh drift — which
 * leaves the item DRIFTED immediately after being restored, with the reviewer's
 * own reversion sitting in their queue. A loop.
 *
 * The two are deliberately duplicated in STRUCTURE rather than in code, because
 * project() hashes a whole projection and this hashes one field. If project()'s
 * digest formula ever changes, this must change with it — and
 * test/restore.test.js asserts they agree, for every field kind, so the pair
 * cannot silently drift apart.
 */
export function digestOf(field, value, context = {}) {
  if (field.field_kind === 'LINKS') value = governedLinks(value, context);
  let normalised;
  try {
    normalised = normaliseField(field.field_kind, value);
  } catch {
    // An unknown kind must not stop a restore. Hashing the raw value means the
    // suppression may miss and the restore is recorded as drift — noisy, but
    // recoverable, where refusing to write is not.
    normalised = value ?? null;
  }
  return fieldDigest(field, normalised, context);
}

/**
 * Roll per-field outcomes into the counters va_restore stores.
 *
 * A FIELD THAT WAS WRITTEN BUT NOT VERIFIED COUNTS AS FAILED. There is
 * deliberately no third category: the whole value of the verification pass is
 * that "succeeded" means something.
 *
 * `unmatched` carries fields the verifier re-read and found NOT equal to the
 * baseline, whether or not this restore tried to write them. A tracked field a
 * post-function rewrote mid-restore lands here, and it is why COMPLETE cannot
 * be derived from the write outcomes alone: "complete" has to mean the whole
 * tracked projection matches, not that every attempt succeeded.
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
