/**
 * Retention and pruning policy for 21 CFR 11.10(c).
 *
 * "Protection of records to enable their accurate and ready retrieval
 * throughout the records retention period."
 *
 * The requirement calls for retention and retrieval, not deletion afterwards.
 * An unconfigured instance retains all records indefinitely. Part 11 defers
 * the retention period to the applicable predicate rule: 21 CFR 211.180 uses
 * expiry plus a year, 820.180 uses device lifetime with a two-year minimum,
 * and 312.62 uses two years past approval. No single default fits every customer.
 *
 * A proposed 90-day period came from the separate device-check interval.
 * To guard against that mistake, a period below one year requires an explicit
 * acknowledgement and produces a warning on each run until acknowledged.
 *
 * A segment may be pruned only after sealing, export and verification of the
 * export's hash by read-back, and after its retention period has elapsed.
 * va_chain_segment records export_sha256, verified_at and pruned_at.
 *
 * This module contains pure policy functions; jobs/seal.js performs the I/O.
 */

/** va_config keys. */
export const RETENTION_DAYS_CFG = 'retention.days';
export const RETENTION_ACK_CFG = 'retention.acknowledgedShortPeriod';

/** Below this, a configured period is treated as probably-a-mistake. */
export const RETENTION_FLOOR_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export const PRUNE_REFUSAL = {
  /** No period configured. The default, and not an error. */
  NO_POLICY: 'NO_POLICY',
  /** Configured under the floor without an explicit acknowledgement. */
  BELOW_FLOOR_UNACKNOWLEDGED: 'BELOW_FLOOR_UNACKNOWLEDGED',
  /** The segment has not been sealed. */
  NOT_SEALED: 'NOT_SEALED',
  /** Sealed but never exported anywhere. */
  NOT_EXPORTED: 'NOT_EXPORTED',
  /** Exported, but the copy's hash was never read back and checked. */
  NOT_VERIFIED: 'NOT_VERIFIED',
  /** Everything is in place; the records are simply not old enough yet. */
  WITHIN_RETENTION: 'WITHIN_RETENTION',
  /** Already pruned. */
  ALREADY_PRUNED: 'ALREADY_PRUNED',
  INVALID_EVIDENCE: 'INVALID_EVIDENCE',
  VALUES_NOT_COVERED: 'VALUES_NOT_COVERED',
  CURRENT_BASELINE: 'CURRENT_BASELINE'
};

/**
 * Interpret whatever is in va_config.
 *
 * Anything unparseable is treated as unconfigured, never as zero. A retention
 * period of zero days would mean "delete everything immediately", and that must
 * not be reachable by a typo.
 */
export function retentionPolicy(config = {}) {
  const raw = config[RETENTION_DAYS_CFG];
  const days = /^\d+$/.test(String(raw ?? '').trim()) ? Number(raw) : NaN;
  const configured = Number.isSafeInteger(days) && days > 0 && days <= Number.MAX_SAFE_INTEGER / DAY_MS;
  const acknowledged = String(config[RETENTION_ACK_CFG]) === 'true';
  const belowFloor = configured && days < RETENTION_FLOOR_DAYS;

  return {
    configured,
    days: configured ? days : null,
    belowFloor,
    acknowledged,
    // Pruning is off unless someone deliberately turned it on, and a short
    // period needs a second deliberate act on top of that.
    mayPrune: configured && (!belowFloor || acknowledged),
    warning: belowFloor && !acknowledged
      ? `Retention is set to ${days} days, below the ${RETENTION_FLOOR_DAYS}-day floor. GxP predicate rules are measured in years, so a period this short is usually an operational number entered into a legal field. Nothing will be pruned until an administrator acknowledges this deliberately.`
      : null
  };
}

/**
 * Require sealing, export and verified read-back before checking a segment's
 * age. Age alone never permits pruning from va_audit.
 */
export function prunable(segment, policy, now = Date.now()) {
  if (!policy?.mayPrune) {
    return {
      prune: false,
      reason: policy?.configured ? PRUNE_REFUSAL.BELOW_FLOOR_UNACKNOWLEDGED : PRUNE_REFUSAL.NO_POLICY
    };
  }
  if (!segment) return { prune: false, reason: PRUNE_REFUSAL.NOT_SEALED };
  if (segment.pruned_at != null) return { prune: false, reason: PRUNE_REFUSAL.ALREADY_PRUNED };
  if (segment.sealed_at == null) return { prune: false, reason: PRUNE_REFUSAL.NOT_SEALED };
  if (!segment.export_ref || !segment.export_sha256) {
    return { prune: false, reason: PRUNE_REFUSAL.NOT_EXPORTED };
  }
  if (segment.verified_at == null) {
    // Exported is not the same as retrievable. Until the copy has been read
    // back and its hash matched, deleting the original trades a record we have
    // for a record we assume.
    return { prune: false, reason: PRUNE_REFUSAL.NOT_VERIFIED };
  }

  if (!Number.isFinite(Number(segment.sealed_at)) || Number(segment.sealed_at) < 0 ||
      !Number.isFinite(Number(segment.verified_at)) || Number(segment.verified_at) < Number(segment.sealed_at) ||
      Number(segment.verified_at) > now || !Number.isFinite(now) ||
      !/^[a-f0-9]{64}$/i.test(segment.export_sha256)) {
    return { prune: false, reason: PRUNE_REFUSAL.INVALID_EVIDENCE };
  }

  // `<=`, not `<`: exactly at the period is still within it. When two readings
  // of a boundary differ by one day and one of them deletes records, the other
  // is the correct one.
  const ageMs = now - Number(segment.sealed_at);
  if (ageMs <= policy.days * DAY_MS) {
    return { prune: false, reason: PRUNE_REFUSAL.WITHIN_RETENTION, retainedUntil: Number(segment.sealed_at) + policy.days * DAY_MS };
  }
  return { prune: true };
}

/** How the policy should read in the console. Words, not a nullable number:
 *  "Retained indefinitely" is a deliberate posture, and an empty field would
 *  read as an unfinished setting rather than the safe default it is. */
export function describeRetention(policy) {
  if (!policy.configured) return 'Retained indefinitely. Nothing is pruned.';
  if (!policy.mayPrune) return `Configured at ${policy.days} days. Awaiting acknowledgement before taking effect.`;
  return `${policy.days} days after sealing, once exported and verified`;
}

/** A ledger export alone does not archive field contents. Coverage must name
 * the exact immutable version and digest and attest that values were included.
 * The current version always stays available for drift comparison/restoration.
 */
export function prunableValues(baseline, evidence, policy, now = Date.now(), currentVersion) {
  if (!Number.isSafeInteger(Number(currentVersion)) || Number(baseline?.version) >= Number(currentVersion)) {
    return { prune: false, reason: PRUNE_REFUSAL.CURRENT_BASELINE };
  }
  const verdict = prunable(evidence, policy, now);
  if (!verdict.prune) return verdict;
  if (evidence.includesValues !== true || String(evidence.issueId) !== String(baseline.issue_id) ||
      Number(evidence.version) !== Number(baseline.version) || !baseline.content_hash ||
      evidence.contentHash !== baseline.content_hash) {
    return { prune: false, reason: PRUNE_REFUSAL.VALUES_NOT_COVERED };
  }
  return { prune: true };
}

// Evidence is written only by a verified archive integration, never on download.
export const VALUE_EXPORT_PREFIX = 'retention.valueExport.';
export const REPORT_RETENTION_DAYS = 90;
export const RECEIPT_RETENTION_DAYS = 30;
