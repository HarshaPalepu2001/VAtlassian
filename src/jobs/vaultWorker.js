/**
 * THE ATTACHMENT VAULTING WORKER — consumer of va-vault-queue.
 *
 * applyApproval (usecases/drift.js) enqueues one job per captured baseline —
 * the approved item's and every child its capture baselined — so this runs off
 * the approval's own 25-second budget. It copies files to the Forge Object
 * Store, hashing each one and recording it against the baseline in
 * va_vault_attachment.
 *
 * WHICH FILES. When the baseline tracks attachments the job carries the files
 * it recorded (`body.attachments`), and exactly those are copied: the set that
 * was signed, not whatever is on the issue by the time this runs. A recorded
 * file already gone from the issue is carried forward from an earlier vaulted
 * copy of the same Jira id (the same bytes, since Jira never changes a file),
 * or reported as not vaulted. Without `body.attachments` — a baseline that does
 * not track attachments, or a job queued before this — the issue's current
 * files are copied, as before. Files are recorded under their CANONICAL id
 * (lib/attachmentIdentity.js), so a restored copy is filed as the original.
 *
 * AND UNDER THE ID RICH TEXT USES. Each file's media id is recorded with it
 * (lib/mediaIdentity.js), canonical too: a description that shows this file
 * points at that id, and a restore needs it to know which vaulted file each
 * pointer in an approved description is.
 *
 * Forge queues deliver at least once: an attachment already recorded for this
 * baseline is skipped. One attachment failing never stops the rest — each
 * failure is audited, and the next baseline re-sends the whole set.
 */
import api, { route } from '@forge/api';
import { createHash } from 'node:crypto';
import { isAttachmentVaulted, insertVaultAttachment,
  vaultedCopies, identityRecords } from '../db/vaultStore.js';
import { readMediaId } from '../lib/mediaIdentity.js';
import { canonicalAttachments, jiraIdOf } from '../lib/attachmentIdentity.js';
import { tryAppend } from '../db/store.js';
import { STORAGE } from '../lib/vaultLocation.js';
import { defaultVaultObjectStore, tooLarge, MAX_VAULT_BYTES } from '../lib/vaultObjectStore.js';
import { EVENT } from '../lib/ledger.js';
import { withRequestCache } from '../lib/cache.js';
import { harnessLog } from '../lib/harnessLogger.js';

async function defaultReadIssueAttachments(issueKey) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment`);
  if (!res.ok) throw new Error(`Failed to read attachments for ${issueKey}: ${res.status}`);
  const data = await res.json();
  return data.fields?.attachment ?? [];
}

async function defaultDownloadAttachment(attachment) {
  const id = jiraIdOf(attachment);
  const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${id}?redirect=false`);
  if (!res.ok) throw new Error(`Failed to download attachment ${id}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function runVaultWorker(eventOrBody, overrides = {}) {
  const body = eventOrBody?.body ?? eventOrBody;
  const deps = {
    isAttachmentVaulted, insertVaultAttachment, vaultedCopies, identityRecords,
    mediaIdOf: attachment => readMediaId({ api, route, attachmentId: jiraIdOf(attachment) }),
    readIssueAttachments: defaultReadIssueAttachments,
    downloadAttachment: defaultDownloadAttachment,
    putContent: async args => (await defaultVaultObjectStore()).putContent(args),
    tryAppend, now: Date.now,
    ...overrides
  };
  if (!body?.baselineId || !body?.issueId || !body?.issueKey || !body?.projectId) {
    return { state: 'FAILED', reason: 'INVALID_BODY' };
  }

  const record = await deps.identityRecords([Number(body.issueId)])
    .then(map => map.get(Number(body.issueId)) ?? null)
    .catch(() => null);
  const onIssue = canonicalAttachments(await deps.readIssueAttachments(body.issueKey), record?.files ?? null);
  const exact = Array.isArray(body.attachments);
  const byId = new Map(onIssue.map(a => [String(a.id), a]));
  const targets = exact
    ? body.attachments.map(recorded => ({ recorded, current: byId.get(String(recorded.id)) ?? null }))
    : onIssue.map(current => ({ recorded: { id: current.id, filename: current.filename }, current }));
  const results = { vaulted: 0, skipped: 0, failed: 0 };

  for (const { recorded, current } of targets) {
    const jiraAttachmentId = String(recorded.id);
    const filename = current?.filename ?? recorded.filename;
    if (await deps.isAttachmentVaulted({ baselineId: body.baselineId, jiraAttachmentId })) {
      results.skipped += 1;
      continue;
    }
    try {
      let contentHash, mediaId = null, carriedForward = false;
      let objectKey = null;
      if (current) {
        // Checked from Jira's own size, before the bytes are pulled into memory.
        if (tooLarge(current.size)) throw new Error(`TOO_LARGE: ${current.size} bytes; the vault takes files up to ${MAX_VAULT_BYTES} bytes`);
        const buffer = await deps.downloadAttachment(current);
        contentHash = createHash('sha256').update(buffer).digest('hex');
        const liveMedia = await deps.mediaIdOf(current);
        mediaId = liveMedia ? record?.media?.get(liveMedia) ?? liveMedia : null;
        const put = await deps.putContent({ buffer, hash: contentHash });
        objectKey = put.objectKey;
      } else {
        // Recorded by the baseline, gone from the issue before this ran.
        const copy = (await deps.vaultedCopies({ issueId: body.issueId, attachmentIds: [jiraAttachmentId] }))
          .get(jiraAttachmentId);
        if (!copy) throw new Error('The file was removed from the work item before it could be vaulted, and no earlier copy exists');
        contentHash = copy.content_hash;
        mediaId = copy.media_id ?? null;
        objectKey = copy.object_key;
        carriedForward = true;
      }
      await deps.insertVaultAttachment({
        baselineId: body.baselineId, issueId: body.issueId, jiraAttachmentId,
        filename, contentHash, mediaId, storage: STORAGE.OBJECT_STORE, objectKey, now: deps.now()
      });
      await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULTED,
        payload: { baselineId: body.baselineId, jiraAttachmentId, filename, contentHash, mediaId,
          storage: STORAGE.OBJECT_STORE, objectKey,
          ...(current && current.jiraId !== jiraAttachmentId ? { restoredCopyId: current.jiraId } : {}),
          ...(carriedForward ? { carriedForward: true } : {}) } });
      harnessLog('VAULT', 'vault:copied', { issueKey: body.issueKey, baselineId: body.baselineId, jiraAttachmentId,
        filename, contentHash, mediaId, storage: STORAGE.OBJECT_STORE, objectKey, carriedForward,
        fallback: false });
      results.vaulted += 1;
    } catch (error) {
      console.error('vaultWorker: failed to vault attachment', jiraAttachmentId, error);
      await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULT_FAILED,
        payload: { baselineId: body.baselineId, jiraAttachmentId, filename, error: String(error?.message ?? error) } });
      results.failed += 1;
    }
  }

  return { state: 'COMPLETE', storage: STORAGE.OBJECT_STORE, ...results };
}

export async function handler(event) {
  return withRequestCache(() => runVaultWorker(event));
}
