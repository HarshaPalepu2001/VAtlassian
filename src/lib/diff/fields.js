import { FIELD_KIND } from '../content.js';
import { diffAdf, describeAdfDiff } from './adf.js';
import { diffText, isWhitespaceOnly, magnitude as textMagnitude, coalesce, OP } from './text.js';
import { adfPlainText } from '../valuestore.js';

/**
 * Compare fields by kind and report whether rejection can restore each one.
 * All differs return the same shape for the panel, AI payload and restore
 * planner. Unknown field kinds fall back to canonical JSON comparison.
 */

export const DIFF_KIND = {
  ADF: 'adf',
  TEXT: 'text',
  SCALAR: 'scalar',
  MULTI: 'multi',
  LINKS: 'links',
  ATTACHMENTS: 'attachments',
  UNKNOWN: 'unknown'
};

/** Can a rejection actually write this field back? */
export const RESTORABLE = {
  /** A plain field write on PUT /issue/{key}. */
  YES: 'YES',
  /** Needs a dedicated handler for links, sprint, parent or status. */
  SPECIAL: 'SPECIAL',
  /** Jira cannot undo it: other people's comments, their work logs. */
  NO: 'NO',
  /** We never stored the value, so there is nothing to write back. */
  NOT_RETAINED: 'NOT_RETAINED'
};

/** Jira can return an ADF document for a field whose saved admin kind is TEXT. */
export function presentationKind(configuredKind, before, after) {
  const values = [before, after].filter(value => value != null);
  if (values.length && values.every(value => value?.type === 'doc' && Array.isArray(value.content))) return FIELD_KIND.ADF;
  return configuredKind;
}

/**
 * Fields a PUT cannot restore, with reasons shown before the reviewer
 * confirms rejection.
 */
const IRREVERSIBLE = {
  comment: 'Comments are append-only. Baseline never deletes or rewrites what somebody wrote.',
  worklog: 'Work logs belong to the person who recorded them and are not restored.'
};

/**
 * Fields that need their own API call rather than a field write.
 *
 * `attachment` is here, not in IRREVERSIBLE, because the vault keeps a hashed
 * copy of every baselined file: a removed file is uploaded again from it and
 * an added one deleted (lib/restore/attachments.js). A file the vault never
 * received still cannot come back, and the reject dialog names it.
 */
const SPECIAL_HANDLERS = {
  attachment: 'attachments',
  issuelinks: 'links',
  parent: 'parent',
  status: 'transition',
  sprint: 'sprint'
};

/**
 * Extract a mapping of mediaId -> filename and attachmentId -> filename from raw value sets.
 */
export function extractMediaMap(...valueSets) {
  const map = new Map();
  const inspect = (item) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      for (const el of item) inspect(el);
      return;
    }
    const filename = item.filename ?? item.name;
    const mediaId = item.mediaId ?? item.standsForMediaId;
    const jiraId = item.jiraAttachmentId ?? item.jiraId ?? item.id;
    if (filename) {
      if (mediaId) map.set(String(mediaId), String(filename));
      if (jiraId) map.set(String(jiraId), String(filename));
    }
    if (item.attachment) inspect(item.attachment);
    if (item.allAttachments) inspect(item.allAttachments);
    if (item.fields?.attachment) inspect(item.fields.attachment);
  };
  for (const set of valueSets) {
    if (!set) continue;
    if (Array.isArray(set)) {
      inspect(set);
    } else if (typeof set === 'object') {
      inspect(set.attachment);
      inspect(set.allAttachments);
      inspect(set.fields?.attachment);
      for (const val of Object.values(set)) {
        if (Array.isArray(val) && val.some(x => x && typeof x === 'object' && ('filename' in x || 'mediaId' in x))) {
          inspect(val);
        }
      }
    }
  }
  return map;
}

/**
 * Diff one field.
 *
 * @param field    { field_id, field_name, field_kind, store_values, writable }
 * @param before   the baseline's retained value, or undefined if not retained
 * @param after    the live value
 * @param retained whether this field's contents were stored at all
 * @param mediaMap optional Map of mediaId/attachmentId -> filename
 */
export function diffField({ field, before, after, retained, digestChanged = true, mediaMap = null }) {
  const base = {
    fieldId: field.field_id,
    fieldName: field.field_name ?? field.field_id,
    fieldKind: field.field_kind,
    restorable: restorability(field, retained),
    restorableReason: restorabilityReason(field, retained)
  };

  // Without a retained baseline value, report the change but offer no before
  // value or restoration. The panel must distinguish this from an empty diff.
  if (!retained) {
    return {
      ...base,
      kind: DIFF_KIND.UNKNOWN,
      changed: digestChanged,
      semanticChange: digestChanged,
      retained: false,
      before: null,
      after: null,
      ops: [],
      summary: digestChanged ? 'changed (contents not retained)' : 'unchanged',
      magnitude: 0
    };
  }

  switch (field.field_kind) {
    case FIELD_KIND.ADF: return diffAdfField(base, before, after, mediaMap);
    case FIELD_KIND.TEXT: return diffTextField(base, before, after);
    case FIELD_KIND.SCALAR: return diffScalarField(base, before, after);
    case FIELD_KIND.MULTI: return diffMultiField(base, before, after);
    case FIELD_KIND.LINKS: return diffLinksField(base, before, after);
    case FIELD_KIND.ATTACHMENTS: return diffAttachmentsField(base, before, after);
    default: return diffUnknownField(base, before, after);
  }
}

function diffAdfField(base, before, after, mediaMap = null) {
  const result = diffAdf(before, after, { mediaMap });
  const beforeText = adfPlainText(before);
  const afterText = adfPlainText(after);

  return {
    ...base,
    kind: DIFF_KIND.ADF,
    retained: true,
    changed: result.blocks.some((b) => b.op !== 'equal'),
    semanticChange: result.semanticChange,
    before,
    after,
    blocks: result.blocks,
    // Flat word-level ops over the whole document, for the AI payload and for
    // any surface that wants a simple rendering. The block structure above is
    // what the panel actually draws.
    ops: coalesce(diffText(beforeText, afterText)),
    summary: describeAdfDiff(result),
    magnitude: result.magnitude
  };
}

function diffTextField(base, before, after) {
  const ops = coalesce(diffText(before, after));
  const changed = ops.some((o) => o.op !== OP.EQUAL);
  return {
    ...base,
    kind: DIFF_KIND.TEXT,
    retained: true,
    changed,
    semanticChange: changed && !isWhitespaceOnly(before, after),
    before: before ?? null,
    after: after ?? null,
    ops,
    summary: changed ? `“${short(before)}” → “${short(after)}”` : 'unchanged',
    magnitude: textMagnitude(ops)
  };
}

function diffScalarField(base, before, after) {
  const b = scalarLabel(before);
  const a = scalarLabel(after);
  const changed = b !== a;
  return {
    ...base,
    kind: DIFF_KIND.SCALAR,
    retained: true,
    changed,
    semanticChange: changed,
    before: before ?? null,
    after: after ?? null,
    ops: changed ? [{ op: OP.DELETE, text: b }, { op: OP.INSERT, text: a }] : [],
    summary: changed ? `${b || '(empty)'} → ${a || '(empty)'}` : 'unchanged',
    // Treat changed scalars as a whole change so priority edits are not ranked
    // below text edits because they contain fewer characters.
    magnitude: changed ? 1 : 0
  };
}

/**
 * Compare labels, components, versions and multi-selects as sets.
 * Report added and removed members.
 */
function diffMultiField(base, before, after) {
  const b = toSet(before);
  const a = toSet(after);
  const added = [...a].filter((x) => !b.has(x)).sort();
  const removed = [...b].filter((x) => !a.has(x)).sort();
  const changed = added.length > 0 || removed.length > 0;

  const parts = [];
  if (added.length) parts.push(`+${added.join(', +')}`);
  if (removed.length) parts.push(`−${removed.join(', −')}`);

  return {
    ...base,
    kind: DIFF_KIND.MULTI,
    retained: true,
    changed,
    semanticChange: changed,
    before: [...b].sort(),
    after: [...a].sort(),
    added,
    removed,
    ops: [
      ...removed.map((item) => ({ op: 'removed', item })),
      ...added.map((item) => ({ op: 'added', item }))
    ],
    summary: changed ? parts.join('  ') : 'unchanged',
    magnitude: b.size + a.size === 0 ? 0 : Math.min(1, (added.length + removed.length) / Math.max(1, b.size + a.size))
  };
}

function diffLinksField(base, before, after) {
  const key = (l) => `${l.type ?? '?'}:${l.inward ?? ''}:${l.outward ?? ''}`;
  const b = new Map((before ?? []).map((l) => [key(l), l]));
  const a = new Map((after ?? []).map((l) => [key(l), l]));
  const added = [...a.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const changed = added.length > 0 || removed.length > 0;

  return {
    ...base,
    kind: DIFF_KIND.LINKS,
    retained: true,
    changed,
    semanticChange: changed,
    before: before ?? [],
    after: after ?? [],
    added: added.map((k) => a.get(k)),
    removed: removed.map((k) => b.get(k)),
    ops: [
      ...removed.map((k) => ({ op: 'removed', item: k })),
      ...added.map((k) => ({ op: 'added', item: k }))
    ],
    summary: changed
      ? `${added.length} link(s) added, ${removed.length} removed`
      : 'unchanged',
    magnitude: changed ? 1 : 0
  };
}

function diffAttachmentsField(base, before, after) {
  const b = new Map((before ?? []).map((x) => [x.id, x]));
  const a = new Map((after ?? []).map((x) => [x.id, x]));
  const added = [...a.values()].filter((x) => !b.has(x.id));
  const removed = [...b.values()].filter((x) => !a.has(x.id));

  // No "replaced in place": Jira never changes a file under its id, so a
  // file swapped for different bytes under the same name is an add and a
  // remove, and is shown as exactly that.
  const replaced = [];

  const changed = added.length > 0 || removed.length > 0;
  const names = (list) => list.map((x) => x.filename || x.id).join(', ');
  const parts = [];
  if (added.length) parts.push(`added ${names(added)}`);
  if (removed.length) parts.push(`removed ${names(removed)}`);

  return {
    ...base,
    kind: DIFF_KIND.ATTACHMENTS,
    retained: true,
    changed,
    semanticChange: changed,
    before: before ?? [],
    after: after ?? [],
    added,
    removed,
    replaced,
    ops: [
      ...removed.map((x) => ({ op: 'removed', item: x.filename })),
      ...added.map((x) => ({ op: 'added', item: x.filename }))
    ],
    summary: changed ? parts.join('; ') : 'unchanged',
    magnitude: changed ? 1 : 0
  };
}

/** Add display metadata from retained Jira values without changing canonical file equality. */
export function withAttachmentDetails(diff, beforeRaw, afterRaw) {
  if (diff?.kind !== DIFF_KIND.ATTACHMENTS) return diff;
  const details = (items, raw) => {
    const originals = new Map((Array.isArray(raw) ? raw : []).map(file => [String(file.id), file]));
    return (items ?? []).map(item => {
      const file = originals.get(String(item.id)) ?? {};
      return { ...item,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.created ? { created: file.created } : {}),
        ...(file.author?.displayName ? { authorName: file.author.displayName } : {}),
        ...(file.jiraId && String(file.jiraId) !== String(item.id) ? { jiraId: String(file.jiraId) } : {})
      };
    });
  };
  return { ...diff, added: details(diff.added, afterRaw), removed: details(diff.removed, beforeRaw) };
}

/**
 * Compare unknown custom field types as canonical JSON so unrecognized
 * schemas still produce a change in the review.
 */
function diffUnknownField(base, before, after) {
  const b = JSON.stringify(before ?? null);
  const a = JSON.stringify(after ?? null);
  const changed = b !== a;
  return {
    ...base,
    kind: DIFF_KIND.UNKNOWN,
    retained: true,
    changed,
    semanticChange: changed,
    before: before ?? null,
    after: after ?? null,
    ops: changed ? [{ op: OP.DELETE, text: short(b) }, { op: OP.INSERT, text: short(a) }] : [],
    summary: changed ? `${short(b)} → ${short(a)}` : 'unchanged',
    magnitude: changed ? 1 : 0
  };
}

// ── Restorability ────────────────────────────────────────────────────────────

export function restorability(field, retained) {
  if (IRREVERSIBLE[field.field_id]) return RESTORABLE.NO;
  if (!retained) return RESTORABLE.NOT_RETAINED;
  if (SPECIAL_HANDLERS[field.field_id]) return RESTORABLE.SPECIAL;
  // writable comes from editmeta at capture. If false, tell the reviewer
  // before rejection that Jira would refuse the field write.
  if (field.writable === false) return RESTORABLE.NO;
  return RESTORABLE.YES;
}

export function restorabilityReason(field, retained) {
  if (IRREVERSIBLE[field.field_id]) return IRREVERSIBLE[field.field_id];
  if (!retained) {
    return 'This field\'s contents are not retained, so its previous value is not stored and cannot be written back. An administrator can turn retention on for it in Baseline\'s field settings.';
  }
  if (field.writable === false) {
    return 'Jira does not allow this field to be edited on this project\'s screens, so it cannot be written back.';
  }
  if (field.field_id === 'attachment') {
    return 'Removed files are uploaded again from the vault, checked against the hash taken when they were vaulted. Added files are deleted.';
  }
  if (SPECIAL_HANDLERS[field.field_id]) {
    return 'Restored through a dedicated Jira API rather than a field update.';
  }
  return null;
}

export function specialHandlerFor(fieldId) {
  return SPECIAL_HANDLERS[fieldId] ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSet(v) {
  if (v == null) return new Set();
  const arr = Array.isArray(v) ? v : [v];
  return new Set(arr.map((x) => (x && typeof x === 'object' ? String(x.name ?? x.value ?? x.id) : String(x))));
}

function scalarLabel(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.name ?? v.value ?? v.displayName ?? v.key ?? v.id ?? '');
  return String(v);
}

function short(s, max = 80) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  const flat = str.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
