/**
 * Read who changed an issue and when.
 *
 * Changelog entries supply attribution. Baseline/live-issue comparisons supply
 * changed values. Do not derive drift or field values from the changelog:
 * entries vary by field and may be absent.
 *
 * For example, a description's fromString/toString is a flattened, lossy
 * rendering of ADF. Its author and timestamp describe the edit, but its strings
 * cannot replace the values from the content projection.
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
 * Atlassian automation display names, matched case-insensitively only after
 * accountType === 'app'. Never use the name as the primary signal: an
 * administrator can rename it and another app can imitate it.
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
 * Read all available changelog pages, returning the newest page last.
 *
 * @param request Injected async ({ startAt, maxResults }) => Response.
 * @param sinceMs Filter entries older than this timestamp. The oldest-first API
 *                still requires fetching every page before applying the filter.
 * @param maxPages Bound pagination to the resolver budget. Reaching this limit
 *                 sets truncated; callers must disclose the incomplete history.
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
 * Build a per-field timeline ordered oldest to newest. This lets the panel
 * show successive edits and their authors rather than only before/after values.
 *
 * @param entries Entries from fetchChangelog.
 * @param fieldIds Keep only these fields.
 * @returns { [fieldId]: Array<{ changelogId, at, authorId, authorName, source,
 *            fromString, toString }> }
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
 * Build a chronological timeline for the AI payload and panel activity strip.
 * Each row groups fields changed by the same author at the same moment. A single
 * save with four changed fields should appear as one action, not four.
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
 * Find fields changed after sinceMs and each field's latest editor.
 *
 * The collector uses this after detecting drift by hash. If the changelog is
 * unavailable or lacks attribution, still record the drift with a null author
 * and detected_via: 'SWEEP'. Missing attribution must not suppress a change.
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
