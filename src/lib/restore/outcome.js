import { canonical, sha256Hex } from '../hash.js';
import { normaliseField } from '../content.js';

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
export function digestOf(field, value) {
  let normalised;
  try {
    normalised = normaliseField(field.field_kind, value);
  } catch {
    // An unknown kind must not stop a restore. Hashing the raw value means the
    // suppression may miss and the restore is recorded as drift — noisy, but
    // recoverable, where refusing to write is not.
    normalised = value ?? null;
  }
  return sha256Hex(canonical({ f: field.field_id, k: field.field_kind, v: normalised }));
}

/**
 * Roll per-field outcomes into the counters va_restore stores.
 *
 * A FIELD THAT WAS WRITTEN BUT NOT VERIFIED COUNTS AS FAILED. There is
 * deliberately no third category: the whole value of the verification pass is
 * that "succeeded" means something, and a soft middle state is exactly how that
 * erodes. A 204 from Jira means the request was accepted, not that the field
 * holds the value we sent — values get coerced, screens drop fields they do not
 * carry, and post-functions overwrite things a moment later.
 */
export function tally(detail) {
  const counters = { attempted: detail.length, succeeded: 0, failed: 0, skipped: 0, irreversible: 0 };
  for (const d of detail) {
    if (d.outcome === OUTCOME.SUCCEEDED && d.verified) counters.succeeded++;
    else if (d.outcome === OUTCOME.IRREVERSIBLE) counters.irreversible++;
    else if (d.outcome === OUTCOME.SKIPPED) counters.skipped++;
    else counters.failed++;
  }

  const state = counters.failed > 0
    ? (counters.succeeded > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.FAILED)
    : (counters.irreversible > 0 || counters.skipped > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.COMPLETE);

  return { counters, state };
}
