/**
 * How much a reviewer should care about a change.
 *
 * This module is what stops Baseline from being muted. An app that pages a
 * reviewer because somebody bolded a word will be switched off within a week,
 * and it will take the genuinely important alerts with it. So the ladder below
 * is deliberately opinionated, and cosmetic changes are suppressed by default
 * rather than merely ranked low.
 *
 * Pure: no I/O, no clock, no database. The caller supplies the field, the
 * configured rule and the two values; this returns a level.
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
 * The out-of-the-box ladder, applied to any field an admin has not given an
 * explicit materiality.
 *
 * The reasoning behind each level, since these are product decisions rather
 * than mechanics:
 *
 *   CRITICAL — the field changes what "done" means. If description, due date,
 *   priority or security level move after approval, the approval is stale and
 *   the reviewer needs to see it now.
 *
 *   MAJOR — the field changes who does it, when, or where it lands. Worth a
 *   review, not worth an interruption.
 *
 *   MINOR — the field is metadata. Recorded for the trail, queued at the
 *   bottom.
 *
 * Anything not listed defaults to MINOR, not MAJOR: an unrecognised custom
 * field is far more likely to be a team's own bookkeeping than a scope control,
 * and defaulting unknown fields high is the other reliable way to get an app
 * muted.
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
 * @param configured   the admin's va_controlled_field.materiality, or null
 * @param before       normalised baseline value
 * @param after        normalised current value
 * @param opts.semanticChange
 *        Supplied by the diff engine for rich text: false means the rendered
 *        text is identical and only formatting moved. When the diff engine has
 *        not run (the trigger path, which works on digests alone) this is
 *        undefined and no cosmetic determination is made — the queue is
 *        recomputed with the diff on panel open, which is where a cosmetic
 *        change gets demoted. Being briefly over-cautious between an edit and a
 *        panel open is the right way round: a change that turns out to be
 *        cosmetic costs one queue row, a change wrongly suppressed costs the
 *        product its purpose.
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
 * Two fields where the DIRECTION of a change decides how much it matters.
 *
 * Priority dropping after approval is housekeeping; priority rising is somebody
 * quietly reclassifying work that was already agreed. Estimates and due dates
 * behave the same way — moving in is a team going faster, moving out is scope
 * or schedule slipping past the point where it was signed off.
 *
 * Only ever DEMOTES. A rule that could promote a change above the level an
 * admin explicitly configured would make the configuration screen a lie.
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
