import { normaliseField, digestsEquivalent, fieldDigest } from '../content.js';
import { baselineLinkPolicy, governedLinks } from '../linkPolicy.js';
import { canonical, sha256Hex } from '../hash.js';
import { diffField, presentationKind, withAttachmentDetails, extractMediaMap } from './fields.js';
import { classify, maxMateriality, MATERIALITY } from '../materiality.js';
import { attributionByField, timeline } from '../changelog.js';

export * from './fields.js';
export * from './text.js';
export * from './adf.js';

/**
 * Combine typed baseline/live value comparisons with changelog attribution.
 * The comparison supplies exact values. The changelog supplies authors and
 * times but may omit value details.
 */

/**
 * Build the diff for one work item against its baseline.
 * All inputs come from the caller. This function performs no I/O and reads
 * neither the clock nor the database.
 *
 * @param baseline          va_baseline row
 * @param baselineValues    { fieldId: value } from va_baseline_value
 * @param currentFields     fields from GET /issue/{key}
 * @param controlledFields  [{ field_id, field_kind, store_values, writable, materiality }]
 * @param driftRows         va_drift rows for this baseline version
 * @param changelogEntries  from lib/changelog.js
 */
export function diffIssue({
  baseline,
  baselineValues = {},
  currentFields = {},
  controlledFields = [],
  driftRows = [],
  changelogEntries = [], issue = null, linkPolicy = baselineLinkPolicy(baseline)
}) {
  const fieldIds = controlledFields.map((f) => f.field_id);
  const attribution = attributionByField(changelogEntries, fieldIds);
  const driftByField = groupBy(driftRows, (d) => d.field_id);
  const mediaMap = extractMediaMap(baselineValues, currentFields);
  let bDigests = {};
  try {
    bDigests = baseline?.field_digests ? (typeof baseline.field_digests === 'string' ? JSON.parse(baseline.field_digests) : baseline.field_digests) : {};
  } catch (e) {
    bDigests = {};
  }

  const fields = [];

  for (const field of controlledFields) {
    // Skip fields outside the baseline's scope. They have no approved value to
    // compare and must not appear as changed unretained content.
    if (Object.keys(bDigests).length > 0 && !Object.prototype.hasOwnProperty.call(bDigests, field.field_id)) {
      continue;
    }

    const retained = Object.prototype.hasOwnProperty.call(baselineValues, field.field_id);

    const filter = value => field.field_kind === 'LINKS' && value !== undefined
      ? governedLinks(value, { linkPolicy, issue: issue ?? { fields: currentFields } }) : value;
    const beforeRaw = filter(baselineValues[field.field_id]);
    const afterRaw = filter(currentFields[field.field_id]);
    const displayKind = presentationKind(field.field_kind, beforeRaw, afterRaw);

    // Compare normalised values to ignore multi-value ordering and ADF localIds.
    // Restore from raw values so normalisation does not introduce a second edit.
    const before = retained ? safeNormalise(displayKind, beforeRaw) : undefined;
    const after = safeNormalise(displayKind, afterRaw);

    let digestChanged = true;
    if (!retained) {
      const currentDigest = fieldDigest(field, after, { linkPolicy });
      digestChanged = !digestsEquivalent(field.field_id, bDigests[field.field_id], currentDigest);
    }

    const diff = withAttachmentDetails(diffField({ field: { ...field, field_kind: displayKind }, before, after, retained, digestChanged, mediaMap }), beforeRaw, afterRaw);
    if (!diff.changed) continue;

    const events = (driftByField.get(field.field_id) ?? [])
      .sort((a, b) => a.occurred_at - b.occurred_at);
    const touches = attribution[field.field_id] ?? [];
    // Collector evidence still carries useful attribution if Jira history is
    // missing. Sweep timestamps describe detection, not necessarily the edit.
    const trace = touches.length ? touches : events.map(e => ({
      at: Number(e.occurred_at), authorId: e.actor_account_id ?? null,
      authorName: e.actor_name ?? null, source: e.source ?? 'UNKNOWN',
      detected: ['SWEEP', 'RECONCILE'].includes(e.detected_via) && !e.changelog_id, fromString: null, toString: null
    }));
    const confirmed = trace.filter(t => !t.detected);

    const materiality = classify(
      field.field_id,
      field.materiality,
      before,
      after,
      { semanticChange: diff.semanticChange }
    );

    fields.push({
      ...diff,
      materiality,

      // Normalised scalars retain Jira ids, such as "10000". Keep the raw values'
      // display names in a separate lookup. The panel can show both the stored id
      // and its name without substituting one for the other.
      valueLabels: {
        ...Object.fromEntries(mediaMap.entries()),
        ...valueLabels(beforeRaw, afterRaw)
      },

      // The ordered account of how this field got here. `touches` is the raw
      // changelog view; `events` is what Baseline recorded and is what the AI
      // report must cite. Both are exposed because they answer different
      // questions: touches includes edits from before the baseline if the
      // caller asked for them, events are strictly post-approval.
      attribution: trace.map((t) => ({
        at: t.at,
        authorId: t.authorId,
        authorName: t.authorName,
        source: t.source,
        detected: t.detected ?? false,
        fromString: t.fromString,
        toString: t.toString
      })),
      driftIds: events.map((e) => e.key),
      occurrences: Math.max(touches.length, events.length),
      firstChangedAt: confirmed[0]?.at ?? null,
      lastChangedAt: confirmed.at(-1)?.at ?? null,
      lastChangedBy: confirmed.at(-1)?.authorName ?? null,

      // Report edits that returned to the approved value as history, without
      // asking the reviewer to decide them as drift.
      churned: touches.length > 1 && !diff.changed
    });
  }

  // Most material first, then largest. Ranking is presentation only; nothing
  // downstream depends on the order, and a reviewer scrolling to the bottom
  // sees exactly the same set.
  fields.sort((a, b) =>
    materialityRank(b.materiality) - materialityRank(a.materiality)
    || b.magnitude - a.magnitude
    || a.fieldName.localeCompare(b.fieldName)
  );

  const material = fields.filter((f) => f.semanticChange && f.materiality !== MATERIALITY.COSMETIC);

  return {
    issueId: baseline?.issue_id ?? null,
    baselineId: baseline?.baseline_id ?? null,
    baselineVersion: baseline?.version ?? null,
    baselineAt: baseline?.transition_at ?? null,
    approvedBy: baseline?.approved_by ?? null,
    approvedName: baseline?.approved_name ?? null,
    fidelity: baseline?.fidelity ?? null,

    fields,
    changedFieldCount: fields.length,
    materialFieldCount: material.length,
    maxMateriality: maxMateriality(fields.map((f) => f.materiality)),

    // A flat "who did what, when", sessionised so that one save touching four
    // fields reads as one action rather than four.
    timeline: timeline(changelogEntries, fieldIds),

    // Hash the evidence to invalidate cached reports only when it changes.
    evidenceHash: evidenceHash(baseline, driftRows, '', Object.fromEntries(
      controlledFields.map(field => [field.field_id, sha256Hex(canonical({
        f: field.field_id, k: field.field_kind,
        v: safeNormalise(field.field_kind, currentFields[field.field_id])
      }))])
    ))
  };
}

/**
 * sha256 over the baseline, drift ids and normalized live field digests.
 *
 * Sorted, so that the order rows come back in cannot change the hash and
 * silently invalidate a perfectly good cached report.
 */
export function evidenceHash(baseline, driftRows, model = '', liveDigests = null) {
  return sha256Hex(canonical({
    baselineId: baseline?.baseline_id ? String(baseline.baseline_id) : null,
    version: baseline?.version ?? null,
    drift: (driftRows ?? []).map((d) => String(d.key ?? d.drift_id)).sort(),
    model,
    ...(liveDigests == null ? {} : { liveDigests })
  }));
}

/**
 * Fall back to the raw value if display normalisation rejects its kind.
 * Hashing must still reject unknown kinds to avoid incorrect digests.
 */
function safeNormalise(kind, value) {
  try {
    return normaliseField(kind, value);
  } catch {
    return value ?? null;
  }
}

function materialityRank(m) {
  return { CRITICAL: 3, MAJOR: 2, MINOR: 1, COSMETIC: 0 }[m] ?? 0;
}

/**
 * Build an identifier-to-name lookup from raw values on both sides.
 * Normalisation discards names, and current values no longer contain names
 * for removed values. Add an entry only if the name differs from its id.
 */
export function valueLabels(...raws) {
  const map = {};
  for (const raw of raws) {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (!item || typeof item !== 'object') continue;
      // Extract rich labels for issuelinks
      if (item.type && (item.inwardIssue || item.outwardIssue)) {
        if (item.type.id && item.type.name) {
          map[String(item.type.id)] = String(item.type.name);
        }
        const linked = item.inwardIssue ?? item.outwardIssue;
        if (linked?.id) {
          const key = linked.key ?? '';
          const summary = linked.fields?.summary ?? linked.summary ?? '';
          const label = key && summary ? `${key} - ${summary}` : (key || summary || String(linked.id));
          map[String(linked.id)] = label;
          if (key) map[String(key)] = label;
        }
      }
      if (item.filename) {
        const fname = String(item.filename);
        if (item.mediaId) map[String(item.mediaId)] = fname;
        if (item.standsForMediaId) map[String(item.standsForMediaId)] = fname;
        if (item.jiraId) map[String(item.jiraId)] = fname;
        if (item.jiraAttachmentId) map[String(item.jiraAttachmentId)] = fname;
        if (item.id) map[String(item.id)] = fname;
      }
      const id = item.accountId ?? item.id ?? item.value ?? item.key;
      const name = readableName(item);
      if (id == null || name == null) continue;
      if (String(id) !== String(name)) map[String(id)] = String(name);
    }
  }
  return map;
}

function readableName(item) {
  const direct = item.name ?? item.displayName ?? item.filename ?? item.value;
  if (direct != null) return direct;
  const key = item.key;
  const summary = item.fields?.summary ?? item.summary;
  if (key != null && summary != null) return `${key} - ${summary}`;
  if (key != null) return key;
  return null;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list ?? []) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * Compute the review headline without an LLM so the panel retains a summary
 * and full deterministic diff when Forge LLMs fails or is unavailable.
 */
export function ruleBasedSummary(diff) {
  if (!diff || diff.changedFieldCount === 0) {
    return 'No changes since this work item was approved.';
  }
  if (diff.materialFieldCount === 0) {
    return `${diff.changedFieldCount} formatting-only change${diff.changedFieldCount === 1 ? '' : 's'} since approval. Nothing a reader would notice.`;
  }

  const named = diff.fields
    .filter((f) => f.semanticChange && f.materiality !== MATERIALITY.COSMETIC)
    .slice(0, 3)
    .map((f) => f.fieldName);

  const others = diff.materialFieldCount - named.length;
  const list = others > 0 ? `${named.join(', ')} and ${others} more` : named.join(', ');

  const people = [...new Set(
    diff.fields.flatMap((f) => f.attribution.map((a) => a.authorName)).filter(Boolean)
  )];
  const who = people.length === 0
    ? ''
    : people.length === 1
      ? ` All by ${people[0]}.`
      : ` By ${people.slice(0, 2).join(' and ')}${people.length > 2 ? ` and ${people.length - 2} others` : ''}.`;

  return `${list} changed since approval.${who}`;
}
