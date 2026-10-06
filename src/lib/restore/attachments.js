import { createHash } from 'node:crypto';
import { canonicalAttachments, jiraIdOf, rewriteAdfMedia, liveCopyMedia } from '../attachmentIdentity.js';
import { isReadableCopy, describeLocation } from '../vaultLocation.js';

/**
 * PUTTING A WORK ITEM'S FILES BACK.
 *
 * A rejection returns the attachment list to the one the baseline recorded:
 *
 *   · A recorded file that is missing is RE-UPLOADED from the vault. Its vaulted
 *     bytes are checked against the SHA-256 taken when they were vaulted before
 *     anything is sent to Jira, so a copy altered in Confluence is refused, not
 *     restored. Jira gives the upload a new id; once the upload is read back and
 *     its hash matches, the new id is recorded as standing for the original
 *     (lib/attachmentIdentity.js), and from then on it IS the approved file to
 *     every comparison.
 *
 *   · A file that was added is DELETED — permanently, which is why the reject
 *     dialog names it before anyone signs. Its name, size and content hash go
 *     into the audit ledger first, and the delete happens only if that write
 *     succeeded: losing the audit trail is a reason to keep a file, never a
 *     reason to destroy it quietly. A copy of its bytes is kept in the vault
 *     where one can be.
 *
 * Additions first, then removals, so a refused upload never costs a file.
 *
 * NEVER SILENTLY PARTIAL. A file that cannot be put back — no vaulted copy, a
 * copy that fails its hash, an upload Jira refuses — is named with the reason,
 * the rest still go ahead, and the whole step then reports failure. A failure
 * of the SYSTEM (no response, 5xx, rate limit) is thrown at once instead, so a
 * queued restore retries: every step here is safe to repeat, because a file
 * already restored is found by its alias and not uploaded twice.
 */

export class AttachmentRestoreError extends Error {
  constructor({ status = 422, detail, refused = [], unpointable = [] }) {
    super(detail);
    this.name = 'AttachmentRestoreError';
    this.code = 'ATTACHMENT_RESTORE_FAILED';
    this.operation = 'RESTORE_ATTACHMENTS';
    this.status = status;
    this.detail = detail;
    this.refused = refused;
    this.unpointable = unpointable;
  }
}

/** How many times a restored copy's media id is asked for before it counts as unknown. */
export const MEDIA_ID_ATTEMPTS = 3;
const MEDIA_ID_PAUSE_MS = 400;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A just-uploaded file's media id. Jira can take a moment to hand the file to
 * its media store, so an unknown answer is asked again before it is believed.
 */
async function mediaIdWithRetry(deps, attachmentId) {
  if (!deps.mediaIdOf) return null;
  const sleep = deps.sleep ?? pause;
  for (let attempt = 1; attempt <= MEDIA_ID_ATTEMPTS; attempt++) {
    const mediaId = await deps.mediaIdOf(attachmentId);
    if (mediaId) return mediaId;
    if (attempt < MEDIA_ID_ATTEMPTS) await sleep(MEDIA_ID_PAUSE_MS * attempt);
  }
  return null;
}

/** A failure that says nothing about this file and everything about the next request. */
export function isSystemic(error) {
  const status = Number(error?.status ?? 0);
  return !Number.isFinite(status) || status === 0 || status >= 500 || status === 429 || status === 408;
}

export const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

/**
 * What a restore to `target` does to `current`. Both are canonical lists
 * (lib/attachmentIdentity.js), so a restored copy counts as its original.
 * Pure.
 */
export function planAttachmentChanges({ target, current }) {
  const want = new Map((target ?? []).map(a => [String(a.id), a]));
  const have = new Map((current ?? []).map(a => [String(a.id), a]));
  return {
    missing: [...want.values()].filter(a => !have.has(String(a.id))),
    extra: [...have.values()].filter(a => !want.has(String(a.id)))
  };
}

const describeFile = a => a?.filename || `attachment ${a?.id}`;

/**
 * @param issueKey       the work item to act on
 * @param issueId        its id (aliases are recorded against it)
 * @param sourceIssueId  whose vault holds the files — the same item, except for
 *                       a work item a tree restore recreated under a new id
 * @param target         the baseline's retained attachment list
 * @param deps           I/O, see ./attachmentAdapters.js
 */
export async function restoreAttachments({ issueKey, issueId, sourceIssueId = issueId, target, restoreRef = null, deps }) {
  if (!Array.isArray(target)) {
    throw new AttachmentRestoreError({ detail: 'The approved attachment list was not stored, so the files cannot be restored.' });
  }
  const aliases = (await deps.aliases(Number(issueId))) ?? null;
  const current = canonicalAttachments(await deps.readCurrent(issueKey), aliases);
  const { missing, extra } = planAttachmentChanges({ target: canonicalAttachments(target), current });
  const refused = [];
  const restored = [];
  const removed = [];
  // Restored files whose copy's media id stayed unknown: rich text showing the
  // original cannot be pointed at them (see the executor, which names the
  // fields instead of sending Jira a pointer it would refuse).
  const unpointable = [];
  const refuse = (file, reason) => refused.push({ id: String(file.id), filename: describeFile(file), reason });

  const copies = missing.length
    ? await deps.vaultedCopies({ issueId: Number(sourceIssueId), attachmentIds: missing.map(a => String(a.id)) })
    : new Map();

  for (const file of missing) {
    const copy = copies.get(String(file.id));
    if (!isReadableCopy(copy)) {
      refuse(file, 'No copy of this file is in the vault, so it cannot be put back. Ask whoever removed it to attach it again.');
      continue;
    }
    try {
      let bytes;
      try {
        bytes = await deps.downloadVaulted(copy);
      } catch (error) {
        // Recorded, but gone from where it was kept: a fact about this file,
        // not the system, so it is named rather than retried.
        if (Number(error?.status) === 404) {
          refuse(file, `The vaulted copy is missing from ${describeLocation(copy)}, so it cannot be put back.`);
          continue;
        }
        throw error;
      }
      if (sha256(bytes) !== copy.content_hash) {
        refuse(file, `The vaulted copy no longer matches the hash recorded when it was vaulted, so it was not restored. It may have been changed in ${describeLocation(copy)}.`);
        continue;
      }
      const uploaded = await deps.upload({ issueKey, filename: file.filename || copy.filename, mimeType: file.mimeType, buffer: bytes });
      const newId = String(uploaded?.id ?? '');
      if (!newId) throw new AttachmentRestoreError({ status: 502, detail: 'Jira accepted the upload but returned no attachment id.' });
      // Read back before it may stand for the original: an alias over the
      // wrong bytes would make a wrong file look approved.
      const landed = sha256(await deps.download(newId));
      if (landed !== copy.content_hash) {
        await deps.remove(newId).catch(() => {});
        refuse(file, 'Jira stored different bytes from the vaulted copy, so the upload was removed again.');
        continue;
      }
      // The copy's media id, so rich text that showed the original can point
      // at it. Unknown only if Jira stops answering the way it did when probed;
      // the file is still restored, and a description that needs the pointer
      // is named as not restored, never written with a guess.
      const mediaId = await mediaIdWithRetry(deps, newId);
      if (!mediaId && copy.media_id) unpointable.push({ id: String(file.id), attachmentId: newId, originalMediaId: String(copy.media_id) });
      await deps.recordAlias({ attachmentId: newId, issueId: Number(issueId), standsForId: String(file.id),
        contentHash: copy.content_hash, restoreRef, mediaId, standsForMediaId: copy.media_id ?? null });
      await deps.audit('ATTACHMENT_RESTORED', { issueKey, originalAttachmentId: String(file.id), attachmentId: newId,
        filename: file.filename || copy.filename, contentHash: copy.content_hash, vaultBaselineId: copy.baseline_id ?? null,
        mediaId, originalMediaId: copy.media_id ?? null },
      Number(issueId));
      restored.push({ id: String(file.id), attachmentId: newId, filename: describeFile(file) });
    } catch (error) {
      if (isSystemic(error)) throw error;
      refuse(file, `Jira refused the upload: ${error?.detail ?? error?.message ?? error}`);
    }
  }

  for (const file of extra) {
    const jiraId = jiraIdOf(file);
    try {
      // Evidence before destruction: what is deleted is written to the ledger
      // first, with the hash of its bytes, and a copy kept where the vault can.
      const bytes = await deps.download(jiraId);
      const contentHash = sha256(bytes);
      const kept = await deps.preserve({ issueId: Number(issueId), file, buffer: bytes }).catch(() => null);
      await deps.audit('ATTACHMENT_REMOVED_BY_RESTORE', { issueKey, attachmentId: jiraId, filename: file.filename,
        size: file.size ?? null, contentHash, author: file.author?.accountId ?? null, created: file.created ?? null,
        vaultCopy: kept ? { storage: kept.storage ?? null, confluenceAttachmentId: kept.confluenceAttachmentId ?? null,
          objectKey: kept.objectKey ?? null } : null }, Number(issueId));
      await deps.remove(jiraId);
      removed.push({ id: jiraId, filename: describeFile(file) });
    } catch (error) {
      // Gone before we reached it: the state a removal wants.
      if (Number(error?.status) === 404) { removed.push({ id: jiraId, filename: describeFile(file) }); continue; }
      if (isSystemic(error)) throw error;
      refuse(file, Number(error?.status) === 403
        ? 'The app is not allowed to delete attachments in this project, so this file was left in place.'
        : `The file could not be removed: ${error?.detail ?? error?.message ?? error}`);
    }
  }

  if (refused.length) {
    throw new AttachmentRestoreError({ refused, unpointable,
      detail: refused.map(entry => `${entry.filename}: ${entry.reason}`).join(' ') });
  }
  return { restored, removed, unpointable };
}

/**
 * RICH TEXT, POINTED AT THE FILES THAT ARE THERE.
 *
 * An approved description shows its files by their ORIGINAL media ids. Where
 * a file was put back by a restore, Jira only knows the copy's media id, and
 * refuses a description that points at a file it no longer has
 * (ATTACHMENT_VALIDATION_ERROR). So each ADF value about to be written has
 * those pointers swapped for the copies' — and nothing else changed. Where the
 * original file is still on the item there is nothing to swap, and the
 * description goes back byte for byte.
 *
 * `record`: identityRecords() for this item. `liveJiraIds`: the Jira ids on the
 * item now, so that of two copies of one original — restored, deleted,
 * restored again — the one still there is shown, not the first one recorded
 * (lib/attachmentIdentity.js liveCopyMedia).
 */
export function pointAtLiveFiles(fields, record, { liveJiraIds = null } = {}) {
  const forward = liveCopyMedia(record, liveJiraIds);
  if (!forward.size) return fields;
  const out = {};
  for (const [fieldId, value] of Object.entries(fields ?? {})) out[fieldId] = rewriteAdfMedia(value, forward);
  return out;
}

/** Jira's refusal of rich text that shows a file the item no longer has, in words. */
export function explainRichTextRefusal(detail) {
  return /ATTACHMENT_VALIDATION_ERROR/.test(String(detail ?? ''))
    ? 'The approved text shows a file that is no longer on the work item, and no vaulted copy could take its place, so Jira will not accept it (ATTACHMENT_VALIDATION_ERROR).'
    : detail;
}
