/**
 * Classify the importance of a tracked-field change for review.
 *
 * Cosmetic changes are suppressed by default so formatting edits do not trigger
 * the same notifications as changes that affect approval.
 *
 * These functions do no I/O. The caller supplies the field, configured rule
 * and both values; the result is a materiality level.
 */

export const MATERIALITY = {
  CRITICAL: 'CRITICAL',
  MAJOR: 'MAJOR',
  MINOR: 'MINOR',
  /** Same content, different representation. Recorded, never queued. */
  COSMETIC: 'COSMETIC'
};

const ORDER = { COSMETIC: 0, MINOR: 1, MAJOR: 2, CRITICAL: 3 };

export function rank(m) {
  return ORDER[m] ?? 0;
}

export function maxMateriality(values) {
  let hi = MATERIALITY.COSMETIC;
  for (const m of values ?? []) {
    if (rank(m) > rank(hi)) hi = m;
  }
  return hi;
}

/**
 * Default materiality for fields without an explicit administrator setting.
 *
 * CRITICAL covers changes to what completion means, including description,
 * due date, priority and security. MAJOR covers responsibility, timing or
 * destination and needs review without an interruption. MINOR covers metadata,
 * recorded and queued last.
 *
 * Unlisted custom fields default to MINOR to avoid treating team bookkeeping
 * as a critical scope change.
 */
export const DEFAULT_LADDER = {
  description: MATERIALITY.CRITICAL,
  duedate: MATERIALITY.CRITICAL,
  priority: MATERIALITY.CRITICAL,
  security: MATERIALITY.CRITICAL,
  summary: MATERIALITY.MAJOR,
  assignee: MATERIALITY.MAJOR,
  labels: MATERIALITY.MAJOR,
  components: MATERIALITY.MAJOR,
  fixVersions: MATERIALITY.MAJOR,
  versions: MATERIALITY.MAJOR,
  issuelinks: MATERIALITY.MAJOR,
  timetracking: MATERIALITY.MAJOR,
  timeoriginalestimate: MATERIALITY.MAJOR,
  parent: MATERIALITY.MAJOR,
  attachment: MATERIALITY.MAJOR,
  environment: MATERIALITY.MINOR,
  reporter: MATERIALITY.MINOR
};

export const DEFAULT_MATERIALITY = MATERIALITY.MINOR;

/**
 * Classify one field change.
 *
 * @param fieldId
 * @param configured Administrator's va_controlled_field.materiality, or null.
 * @param before Normalised baseline value.
 * @param after Normalised current value.
 * @param opts.semanticChange false when the rich-text diff finds identical
 *        rendered text with only formatting changes.
 *
 * Digest-only trigger checks have no semanticChange value and cannot classify
 * formatting. Recompute the queue after the panel's full diff. Temporary extra
 * review rows are preferable to suppressing a material change.
 */
export function classify(fieldId, configured, before, after, opts = {}) {
  // Same value, no change at all. Callers should not reach here, but a
  // classifier that can return "there was no change" is easier to reason about
  // than one that assumes its caller was correct.
  if (opts.semanticChange === false) return MATERIALITY.COSMETIC;

  // An admin's explicit setting wins over everything below. They know their
  // workflow; the ladder is a starting point, not a policy.
  if (configured && ORDER[configured] !== undefined) {
    return applyDirection(fieldId, configured, before, after);
  }

  const base = DEFAULT_LADDER[fieldId] ?? DEFAULT_MATERIALITY;
  return applyDirection(fieldId, base, before, after);
}

/**
 * Use change direction to demote priority, estimate and due-date changes.
 * Lower priority or earlier completion can be less material; higher priority
 * or later completion can change agreed scope or timing.
 *
 * Never promote above the administrator's configured materiality.
 */
function applyDirection(fieldId, level, before, after) {
  if (fieldId === 'priority') {
    // Jira priority ids sort with 1 as the highest. A NUMERICALLY LOWER id is
    // therefore an INCREASE in urgency, which is the counter-intuitive detail
    // worth writing down rather than rediscovering.
    const b = numeric(before);
    const a = numeric(after);
    if (b != null && a != null && a > b) return demote(level);
    return level;
  }

  if (fieldId === 'duedate') {
    const b = Date.parse(String(before ?? ''));
    const a = Date.parse(String(after ?? ''));
    // Pulled in: the team committed to more, sooner. Not a scope concern.
    if (Number.isFinite(b) && Number.isFinite(a) && a < b) return demote(level);
    return level;
  }

  if (fieldId === 'timeoriginalestimate' || fieldId === 'timetracking') {
    const b = numeric(before?.originalEstimateSeconds ?? before);
    const a = numeric(after?.originalEstimateSeconds ?? after);
    if (b != null && a != null && a < b) return demote(level);
    return level;
  }

  return level;
}

function demote(level) {
  if (level === MATERIALITY.CRITICAL) return MATERIALITY.MAJOR;
  if (level === MATERIALITY.MAJOR) return MATERIALITY.MINOR;
  return level;
}

function numeric(v) {
  if (v === null || v === undefined) return null;
  const n = Number(typeof v === 'object' ? (v.id ?? v.value) : v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Does this change need a reviewer's decision, or is it formatting only?
 *
 * This is a label, not a filter: every drifted item enters the queue and is
 * held by the validator whatever its materiality (lib/collect.js). It decides
 * only whether the queue row says "N changes need a decision" or "Formatting
 * only", by the same rule the panel counts with (usecases/panelSummary.js).
 */
export function needsDecision(materiality) {
  return materiality !== MATERIALITY.COSMETIC;
}

/** Human label for the panel and the queue. */
export function label(m) {
  switch (m) {
    case MATERIALITY.CRITICAL: return 'Critical';
    case MATERIALITY.MAJOR: return 'Major';
    case MATERIALITY.MINOR: return 'Minor';
    case MATERIALITY.COSMETIC: return 'Formatting only';
    default: return 'Unknown';
  }
}
