/**
 * The changelog: attribution, and only attribution.
 *
 * THE DIVISION OF LABOUR THIS WHOLE APP RESTS ON.
 *
 *   The changelog is authoritative for WHO and WHEN, and lossy for WHAT.
 *   The baseline versus the live issue is authoritative for WHAT, and silent
 *   about WHO.
 *
 * Drift detection is deliberately NOT derived from the event changelog: the
 * changelog is unreliable — it varies by field and is sometimes absent
 * entirely. This module does not contradict that rule. Nothing here is ever
 * used to decide WHETHER something changed, or what its value is; values come
 * from the projection. This module answers the other question — "who did it,
 * and when" — and it is the only source that can.
 *
 * Concretely: `fromString`/`toString` on a description change are a flattened,
 * lossy rendering of ADF. Trusting them for VALUE would produce a diff that is
 * subtly wrong. Trusting them for ATTRIBUTION is exact, because the author and
 * timestamp on a changelog entry are facts about the edit, not renderings of it.
 */

/** Where a change came from, derived from the changelog author. */
export const SOURCE = {
  USER: 'USER',
  /** Automation for Jira, or another rules engine acting as an app. */
  AUTOMATION: 'AUTOMATION',
  /** A Forge or Connect app, including this one. */
  APP: 'APP',
  /** A JSM portal customer. */
  CUSTOMER: 'CUSTOMER',
  /** Baseline's own restore writes. Set by the collector, not by this module. */
  BASELINE: 'BASELINE',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Display names Atlassian uses for its own automation actor. Matched
 * case-insensitively and only as a REFINEMENT of accountType === 'app' — never
 * as the primary signal, because a display name is user-visible text that a
 * site admin can change and another app could imitate.
 */
const AUTOMATION_NAMES = [/^automation for jira$/i, /^automation$/i, /\bautomation\b.*\brule/i];

export function classifySource(author) {
  if (!author) return SOURCE.UNKNOWN;
  const type = author.accountType;

  if (type === 'app') {
    const name = String(author.displayName ?? '');
    return AUTOMATION_NAMES.some((re) => re.test(name)) ? SOURCE.AUTOMATION : SOURCE.APP;
  }
  if (type === 'customer') return SOURCE.CUSTOMER;
  if (type === 'atlassian') return SOURCE.USER;
  return SOURCE.UNKNOWN;
}

/**
 * Read an issue's changelog, newest page last, following pagination.
 *
 * @param request  async ({ startAt, maxResults }) => Response — injected so
 *                 this is testable without a Jira client.
 * @param sinceMs  stop paging once entries are older than this. The API returns
 *                 oldest-first, so this cannot short-circuit the fetch; it
 *                 filters. Kept as a parameter anyway because the filter is the
 *                 caller's intent and doing it here keeps the intent in one
 *                 place.
 * @param maxPages hard bound. A work item with tens of thousands of changelog
 *                 entries exists in the wild, and a resolver that walks all of
 *                 them will time out. Paging stops and `truncated` is set, and
 *                 every caller renders that honestly rather than presenting a
 *                 partial history as complete.
 */
export async function fetchChangelog(request, { sinceMs = 0, maxPages = 10, pageSize = 100 } = {}) {
  const entries = [];
  let startAt = 0;
  let truncated = false;

  const startTime = Date.now();
  for (let page = 0; page < maxPages; page++) {
    // Enforce a strict 5-second budget for changelog fetching. The panel resolver
    // has a hard 25-second limit overall, and we need to leave time for the LLM
    // report generation.
    if (Date.now() - startTime > 5000) {
      console.warn('changelog: fetch exceeded 5-second budget, truncating early');
      truncated = true;
      break;
    }

    let res;
    try {
      res = await request({ startAt, maxResults: pageSize });
    } catch (e) {
      console.error('changelog: fetch failed', e);
      return { entries, truncated: true, failed: true };
    }
    if (!res || !res.ok) {
      console.error('changelog: fetch returned', res && res.status);
      return { entries, truncated: true, failed: true };
    }

    const body = await res.json();
    const values = body.values ?? body.histories ?? [];
    for (const v of values) {
      const at = Date.parse(v.created);
      entries.push({
        changelogId: String(v.id),
        at: Number.isFinite(at) ? at : 0,
        authorId: v.author?.accountId ?? null,
        authorName: v.author?.displayName ?? 'Unknown',
        source: classifySource(v.author),
        items: (v.items ?? []).map((it) => ({
          fieldId: it.fieldId ?? it.field,
          fieldName: it.field,
          fieldType: it.fieldtype ?? null,
          from: it.from ?? null,
          fromString: it.fromString ?? null,
          to: it.to ?? null,
          toString: it.toString ?? null
        }))
      });
    }

    const total = body.total ?? entries.length;
    startAt += values.length;
    if (values.length === 0 || startAt >= total) break;
    if (page === maxPages - 1) truncated = true;
  }

  // The API is documented oldest-first but this is not worth trusting: a single
  // out-of-order page would silently corrupt every "who changed it last"
  // answer, and sorting a few hundred entries costs nothing.
  entries.sort((a, b) => a.at - b.at || (a.changelogId < b.changelogId ? -1 : 1));

  return { entries: entries.filter((e) => e.at >= sinceMs), truncated, failed: false };
}

/**
 * Group changelog entries into a per-field timeline.
 *
 * @param entries    from fetchChangelog
 * @param fieldIds   only these fields; everything else is dropped
 * @returns { [fieldId]: Array<{ changelogId, at, authorId, authorName, source,
 *            fromString, toString }> } — ordered oldest to newest.
 *
 * This is the object that makes the panel able to say "changed three times:
 * Priya raised it, Automation lowered it again, then Sam raised it back" rather
 * than a bare before/after. A reviewer's second question is always "how did we
 * get here", and a two-column diff cannot answer it.
 */
export function attributionByField(entries, fieldIds) {
  const wanted = new Set(fieldIds);
  const byField = {};

  for (const entry of entries) {
    for (const item of entry.items) {
      if (!wanted.has(item.fieldId)) continue;
      (byField[item.fieldId] ??= []).push({
        changelogId: entry.changelogId,
        at: entry.at,
        authorId: entry.authorId,
        authorName: entry.authorName,
        source: entry.source,
        fieldName: item.fieldName,
        fromString: item.fromString,
        toString: item.toString,
        from: item.from,
        to: item.to
      });
    }
  }
  return byField;
}

/**
 * A flat, chronological timeline suitable for the AI payload and the panel's
 * activity strip: one row per (author, moment), listing the fields they touched
 * together.
 *
 * SESSIONISED, because a single save that changes four fields produces one
 * changelog entry with four items and must read as one action. Presenting it as
 * four separate changes overstates how much happened.
 */
export function timeline(entries, fieldIds) {
  const wanted = new Set(fieldIds);
  const rows = [];

  for (const entry of entries) {
    const fields = entry.items.filter((i) => wanted.has(i.fieldId));
    if (fields.length === 0) continue;
    rows.push({
      at: entry.at,
      changelogId: entry.changelogId,
      authorId: entry.authorId,
      authorName: entry.authorName,
      source: entry.source,
      fields: fields.map((f) => ({ fieldId: f.fieldId, fieldName: f.fieldName }))
    });
  }
  return rows;
}

/**
 * Which fields, of those we care about, changed after `sinceMs` — and who
 * touched each one last.
 *
 * Used by the collector to attribute a drift row it detected by hash. The hash
 * comparison says a field is different; this says who made it different. When
 * the changelog has nothing to offer (team-managed projects, some field types,
 * a failed fetch) the drift row is still written with a null author and
 * `detected_via: 'SWEEP'`. An unattributed change is worth recording; a
 * change dropped because we could not name its author is not.
 */
export function lastTouchByField(entries, fieldIds, sinceMs = 0) {
  const byField = attributionByField(entries.filter((e) => e.at >= sinceMs), fieldIds);
  const out = {};
  for (const [fieldId, list] of Object.entries(byField)) {
    const last = list[list.length - 1];
    out[fieldId] = {
      ...last,
      occurrences: list.length,
      firstAt: list[0].at,
      authors: [...new Set(list.map((l) => l.authorId).filter(Boolean))]
    };
  }
  return out;
}

/**
 * The largest changelog id seen, as a number where possible.
 *
 * va_review.last_changelog_id is the reconcile job's watermark. Ids are
 * numeric strings in practice but are compared as numbers here and stored as
 * strings, so a future non-numeric id degrades to "reconcile everything since
 * the baseline" rather than to a silently wrong watermark.
 */
export function highestChangelogId(entries) {
  let best = null;
  for (const e of entries) {
    const n = Number(e.changelogId);
    if (!Number.isFinite(n)) continue;
    if (best === null || n > best) best = n;
  }
  return best === null ? null : String(best);
}
