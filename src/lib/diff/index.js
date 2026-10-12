import { normaliseField, digestsEquivalent } from '../content.js';
import { canonical, sha256Hex } from '../hash.js';
import { diffField, presentationKind, withAttachmentDetails, extractMediaMap } from './fields.js';
import { classify, maxMateriality, MATERIALITY } from '../materiality.js';
import { attributionByField, timeline } from '../changelog.js';

export * from './fields.js';
export * from './text.js';
export * from './adf.js';

/**
 * The join that makes this a traceability tool rather than a diff tool.
 *
 *   VALUE comes from the baseline versus the live issue — exact, typed, and
 *   silent about who did it.
 *   ATTRIBUTION comes from the changelog — exact about who and when, and lossy
 *   about what.
 *
 * Neither source can answer a reviewer's real question on its own. "The
 * estimate went from 5 to 13" is a diff. "The estimate went from 5 to 13, in
 * two steps, first by an automation rule and then by the delivery lead, nine
 * days after you approved it" is something a reviewer can act on.
 */

/**
 * Build the complete diff for one work item against its standing baseline.
 *
 * PURE. Every input is supplied by the caller; there is no I/O, no clock and no
 * database here, so the whole behaviour of the reviewer's screen is testable
 * without a Jira. Same discipline as `observe()` in lib/interception.js, and
 * for the same reason: this decides what a reviewer is told.
 *
 * @param baseline          va_baseline row
 * @param baselineValues    { fieldId: value } from va_baseline_value
 * @param currentFields     `fields` from GET /issue/{key}
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
  changelogEntries = []
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
    // NOT IN THE BASELINE IS NOT DRIFT. A field that was not in scope when
    // the baseline was taken has no approved value to compare against.
    // Showing it as "changed (contents not retained)" incorrectly forces it
    // into the UI. Skip it.
    if (Object.keys(bDigests).length > 0 && !Object.prototype.hasOwnProperty.call(bDigests, field.field_id)) {
      continue;
    }

    const retained = Object.prototype.hasOwnProperty.call(baselineValues, field.field_id);

    const beforeRaw = baselineValues[field.field_id];
    const afterRaw = currentFields[field.field_id];
    const displayKind = presentationKind(field.field_kind, beforeRaw, afterRaw);

    // Compared NORMALISED, written back RAW. Normalisation sorts multi-values
    // and strips ADF localIds, so comparing raw values would report phantom
    // changes on every read; but writing a normalised value back into Jira
    // would itself be a silent second edit. The differ therefore sees
    // normalised values and the restore planner reads the raw ones.
    const before = retained ? safeNormalise(displayKind, beforeRaw) : undefined;
    const after = safeNormalise(displayKind, afterRaw);

    let digestChanged = true;
    if (!retained) {
      const currentDigest = sha256Hex(canonical({ f: field.field_id, k: field.field_kind, v: after }));
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

      // WHAT THE IDENTIFIERS MEAN.
      //
      // The differ compares NORMALISED values, and normalising a scalar yields
      // Jira's identifier — "10000", not "Critical". That is correct for
      // comparison and useless for review: nobody can audit "Priority 10000 →
      // 3". The raw values still carry the display name, so it travels with the
      // comparison as a lookup.
      //
      // A LOOKUP RATHER THAN A SUBSTITUTION, because in a signed record the
      // stored identifier IS the evidence. The panel shows the name AND the id
      // it resolves; it never silently replaces one with the other, and an id
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

      // WENT AWAY AND CAME BACK. A field edited three times that ends where it
      // started is not drift a reviewer needs to act on, but it IS something
      // they should know happened — it usually means two people disagreed.
      // Neither a bare diff nor a bare changelog surfaces this.
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

    // Keys the report cache. Any change to the evidence produces a different
    // hash and therefore a fresh report; no change produces a cache hit
    // forever, which is right for an item sitting in a queue for a week.
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
 * Normalisation must never be the reason a panel fails to render.
 *
 * normaliseField throws on an unknown kind, which is correct where a hash is
 * being computed — a silently mis-hashed field is a correctness failure. Here
 * it is not: the value is only being displayed, and falling back to the raw
 * value shows the reviewer something rather than nothing.
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
 * { identifier: display name } for the values on both sides of one field.
 *
 * Built from the RAW values, because they are the only place the name survives
 * — normalisation keeps the identifier and discards everything around it. Both
 * sides are walked: the approved value's name is as necessary as the current
 * one's, and after a change the current issue no longer contains it.
 *
 * An entry is written only when the name genuinely differs from the identifier,
 * so a label field ("urgent") does not produce a pointless "urgent" → "urgent"
 * mapping for the panel to render twice.
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
 * The reviewer-facing headline, computed without the model.
 *
 * ALWAYS AVAILABLE, and that is the point: when Forge LLMs is unavailable, over
 * quota, or returns something unparseable, the panel still opens with a
 * truthful one-line summary and the full deterministic diff underneath. The AI
 * is the fastest path to understanding, never the only one.
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
