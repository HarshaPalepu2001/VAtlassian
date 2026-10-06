import { identityRecords } from '../db/vaultStore.js';

/**
 * WHICH APPROVED FILE IS THIS?
 *
 * Attachments are compared by Jira id (content.js normaliseAttachments), and
 * that is exact for every file a person attaches: Jira never changes one in
 * place. It stops being enough the moment a rejection puts a removed file
 * back. Jira has no way to restore an attachment under its old id; the app can
 * only upload the vaulted bytes again, and the copy gets a NEW id. Compared by
 * id alone, a correctly restored item would read as drifted for ever.
 *
 * So a restore records, after checking the uploaded bytes against the vault's
 * SHA-256, that the new id STANDS FOR the original (va_attachment_alias, written
 * only by the app). Every read of an issue that feeds a comparison passes its
 * attachments through here first, and a restored copy is read under the id of
 * the file that was approved. `jiraId` keeps the real id for anything that has
 * to act on the file in Jira (download, delete).
 *
 * This is the attachment counterpart of the tree restore's recorded
 * replacements for recreated work items.
 *
 * RICH TEXT POINTS AT THE SAME FILE BY A SECOND ID. A description with an
 * inline image holds the file's MEDIA id (Atlassian's file store), not its
 * Jira id: on VAT-3 `12085` appears in the description only as `5786f451-…`,
 * with no filename and no Jira id (probed 2026-09-24). A restored copy gets a
 * new media id too, so the alias also records media id -> original media id,
 * and every ADF value is read with its pointers mapped back. The approved
 * description then reads byte for byte as signed; only the pointer Jira holds
 * differs, and the ledger says which.
 *
 * AN UNREADABLE ALIAS TABLE FAILS TOWARDS DRIFT. Without it a restored copy is
 * read under its own new id, which differs from the baseline: the item shows a
 * change it does not have, and nothing that changed is ever hidden.
 */

/** Only what a comparison or a restore needs; the URLs Jira adds are dropped. */
function entry(attachment, aliases) {
  if (attachment?.jiraId != null) return attachment;
  const jiraId = String(attachment?.id ?? '');
  return {
    id: aliases?.get(jiraId) ?? jiraId,
    jiraId,
    filename: attachment?.filename ?? '',
    size: attachment?.size ?? null,
    mimeType: attachment?.mimeType ?? null,
    created: attachment?.created ?? null,
    author: attachment?.author?.accountId
      ? { accountId: attachment.author.accountId, displayName: attachment.author.displayName ?? null }
      : null
  };
}

/** Pure. `aliases`: Map(Jira id -> original id) for this one work item. */
export function canonicalAttachments(list, aliases = null) {
  return Array.isArray(list) ? list.map(a => entry(a, aliases)) : list;
}

/** The real Jira id of an attachment read through canonicalAttachments (or not). */
export const jiraIdOf = attachment => String(attachment?.jiraId ?? attachment?.id ?? '');

const hasAttachments = fields => Array.isArray(fields?.attachment) && fields.attachment.length > 0;
const isAdfDoc = value => value && typeof value === 'object' && !Array.isArray(value) && value.type === 'doc';

/** Every media id an ADF value points at. Pure. */
export function adfMediaIds(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { for (const item of value) adfMediaIds(item, found); return found; }
  if ((value.type === 'media' || value.type === 'mediaInline') && value.attrs?.id) found.push(String(value.attrs.id));
  for (const child of value.content ?? []) adfMediaIds(child, found);
  return found;
}

/**
 * A copy of `value` with each media pointer in `map` (id -> id) replaced, and
 * nothing else touched. Returns `value` itself when nothing maps. Pure.
 */
export function rewriteAdfMedia(value, map) {
  if (!map?.size || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(item => { const next = rewriteAdfMedia(item, map); if (next !== item) changed = true; return next; });
    return changed ? out : value;
  }
  let out = value;
  const id = value.attrs?.id == null ? null : String(value.attrs.id);
  if ((value.type === 'media' || value.type === 'mediaInline') && id && map.has(id)) {
    out = { ...value, attrs: { ...value.attrs, id: map.get(id) } };
  }
  if (Array.isArray(value.content)) {
    const content = rewriteAdfMedia(value.content, map);
    if (content !== value.content) out = { ...out, content };
  }
  return out;
}

/**
 * original media id -> the media id rich text should show it by now: the
 * NEWEST restored copy still on the item. `record` is one work item's
 * identityRecords() entry, oldest first; a copy whose Jira id is not in
 * `liveJiraIds` (deleted since it was restored) is passed over. Without
 * `liveJiraIds`, or for a copy whose owner was never recorded, every copy
 * counts as live and the newest wins. Pure.
 */
export function liveCopyMedia(record, liveJiraIds = null) {
  const forward = new Map();
  for (const [copy, original] of record?.media ?? new Map()) {
    const owner = record?.mediaOwner?.get(copy);
    if (liveJiraIds && owner != null && !liveJiraIds.has(String(owner))) continue;
    forward.set(original, copy);
  }
  return forward;
}

/**
 * Media ids that `fields` (as Jira holds them, NOT canonicalised) show but whose
 * file is no longer on the work item — so the image renders broken — limited to
 * the files this app knows: restored copies, and the originals they stand for.
 * A pointer to anything else (an image from another item, a file never
 * restored) is not judged here; the digest comparison already covers it.
 *
 * This is what a digest cannot see. Canonicalisation maps a copy's pointer back
 * to the original's, so "points at the deleted original" and "points at its
 * live copy" have the same digest; only one of them shows the image. Pure.
 */
export function danglingMediaPointers(fields, record, liveJiraIds) {
  if (!record?.media?.size || !liveJiraIds) return [];
  const jiraIdOfMedia = new Map();
  for (const [copy, original] of record.media) {
    const owner = record.mediaOwner?.get(copy);
    if (owner == null) continue;
    jiraIdOfMedia.set(copy, String(owner));
    const originalJiraId = record.files?.get(String(owner));
    if (originalJiraId != null && !jiraIdOfMedia.has(original)) jiraIdOfMedia.set(original, String(originalJiraId));
  }
  const dangling = [];
  for (const [fieldId, value] of Object.entries(fields ?? {})) {
    if (!isAdfDoc(value)) continue;
    for (const mediaId of adfMediaIds(value)) {
      const jiraId = jiraIdOfMedia.get(mediaId);
      if (jiraId != null && !liveJiraIds.has(jiraId)) dangling.push({ fieldId, mediaId, jiraId });
    }
  }
  return dangling;
}

async function recordsFor(issueIds, read) {
  if (issueIds.length === 0) return new Map();
  try {
    return await read(issueIds);
  } catch (error) {
    console.error('attachmentIdentity: aliases unavailable; restored copies will read as changed', error);
    return new Map();
  }
}

/**
 * Canonicalise the attachments of work items as read from Jira, in place: the
 * attachment list, and every media pointer in their rich-text fields.
 * `items`: objects with `id` and `fields` (an issue, or a tree node). One
 * lookup for all of them, and none at all when no item has an attachment.
 * Never throws.
 */
export async function canonicaliseItems(items, { read = identityRecords } = {}) {
  const list = (items ?? []).filter(item => item && hasAttachments(item.fields));
  const byIssue = await recordsFor([...new Set(list.map(item => Number(item.id)))], read);
  for (const item of list) {
    const record = byIssue.get(Number(item.id));
    const files = record instanceof Map ? record : record?.files ?? null;
    const media = record instanceof Map ? null : record?.media ?? null;
    const fields = { ...item.fields, attachment: canonicalAttachments(item.fields.attachment, files) };
    if (media?.size) {
      for (const [fieldId, value] of Object.entries(fields)) {
        if (isAdfDoc(value)) fields[fieldId] = rewriteAdfMedia(value, media);
      }
    }
    item.fields = fields;
  }
  return items;
}

/** One issue, as read from Jira. Returns the same issue. Never throws. */
export async function canonicaliseIssue(issue, options = {}) {
  if (issue) await canonicaliseItems([issue], options);
  return issue;
}

/**
 * The files a baseline recorded, from its retained values and the fields it
 * tracks: [{ id, jiraId, filename }], or null when no tracked field holds
 * attachments. What the vault must copy is exactly this — the set that was
 * signed, not whatever is on the issue when the vault job runs.
 */
export function recordedAttachments(values, fields) {
  const ids = (fields ?? []).filter(f => f.field_kind === 'ATTACHMENTS').map(f => f.field_id);
  if (ids.length === 0) return null;
  const seen = new Map();
  for (const fieldId of ids) {
    for (const a of Array.isArray(values?.[fieldId]) ? values[fieldId] : []) {
      const id = String(a?.id ?? '');
      if (id && !seen.has(id)) seen.set(id, { id, jiraId: jiraIdOf(a), filename: a?.filename ?? '' });
    }
  }
  return [...seen.values()];
}
