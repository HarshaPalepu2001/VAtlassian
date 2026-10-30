/**
 * Copy captured baseline attachments through va-vault-queue.
 *
 * applyApproval in usecases/drift.js queues one job for the approved baseline
 * and each child baseline. Copying runs outside the approval's 25-second
 * budget. The worker hashes each file, stores its bytes in Forge Object Store
 * and records the baseline association in va_vault_attachment.
 *
 * Copy only the files recorded in body.attachments when the baseline tracks
 * attachments. Current issue attachments do not prove baseline membership;
 * without body.attachments the worker copies nothing. If a recorded file has
 * already been removed, reuse an earlier vaulted copy of the same Jira ID or
 * report it as not vaulted. Jira attachment bytes do not change in place.
 *
 * Store canonical attachment IDs from lib/attachmentIdentity.js and canonical
 * media IDs from lib/mediaIdentity.js. Restore uses the media ID to map each
 * approved description pointer to its vaulted file.
 *
 * Queues deliver at least once. Skip files already recorded for the baseline,
 * audit each failure and continue with the remaining files. Temporary failures
 * request redelivery; the next delivery skips successful copies.
 */
import api, { route } from '@forge/api';
import { InvocationError, InvocationErrorCode } from '@forge/events';
import { createHash } from 'node:crypto';
import { isAttachmentVaulted, insertVaultAttachment,
  vaultedCopies, identityRecords } from '../db/vaultStore.js';
import { readMediaId } from '../lib/mediaIdentity.js';
import { canonicalAttachments, jiraIdOf } from '../lib/attachmentIdentity.js';
import { tryAppend } from '../db/store.js';
import { STORAGE, isReadableCopy } from '../lib/vaultLocation.js';
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
  if (!res.ok) throw Object.assign(new Error(`Failed to download attachment ${id}: ${res.status}`), { status: res.status });
  return Buffer.from(await res.arrayBuffer());
}

// Forge keeps redelivering for as long as the retention window lasts (a day or
// more), so the worker sets its own limit, as the restore worker does.
const MAX_VAULT_RETRIES = 5;
// retryData is capped at 4 KB by Forge; ids beyond this are re-audited at worst.
const MAX_CARRIED_IDS = 200;
const retryCountOf = event => Number(event?.retryContext?.retryCount ?? 0);
const retry = (event, retryData) => new InvocationError({
  retryAfter: Math.min(60, 5 * 2 ** Math.min(retryCountOf(event), 4)),
  retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
  ...(retryData ? { retryData } : {})
});

export async function runVaultWorker(eventOrBody, overrides = {}) {
  try { return await vaultFiles(eventOrBody, overrides); }
  catch (error) {
    console.error('vaultWorker: could not read the baseline files', error);
    if (retryCountOf(eventOrBody) < MAX_VAULT_RETRIES) return retry(eventOrBody);
    // Out of retries: say so in the ledger rather than vanish from the queue.
    const body = eventOrBody?.body ?? eventOrBody;
    if (body?.issueId && body?.baselineId) {
      await (overrides.tryAppend ?? tryAppend)({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULT_FAILED,
        payload: { baselineId: body.baselineId, jiraAttachmentId: null, error: String(error?.message ?? error) } })
        .catch(failure => console.error('vaultWorker: could not record copy failure', failure));
    }
    return { state: 'FAILED', reason: 'UNAVAILABLE', error: String(error?.message ?? error) };
  }
}

async function vaultFiles(eventOrBody, overrides) {
  const body = eventOrBody?.body ?? eventOrBody;
  const deps = {
    isAttachmentVaulted, insertVaultAttachment, vaultedCopies, identityRecords,
    mediaIdOf: attachment => readMediaId({ api, route, attachmentId: jiraIdOf(attachment) }),
    readIssueAttachments: defaultReadIssueAttachments,
    downloadAttachment: defaultDownloadAttachment,
    putContent: async args => (await defaultVaultObjectStore()).putContent(args),
    hasContent: async key => (await defaultVaultObjectStore()).hasContent(key),
    tryAppend, now: Date.now,
    ...overrides
  };
  if (!body?.baselineId || !body?.issueId || !body?.issueKey || !body?.projectId) {
    return { state: 'FAILED', reason: 'INVALID_BODY' };
  }
  if (!Array.isArray(body.attachments)) return { state: 'SKIPPED', reason: 'NO_BASELINE_ATTACHMENTS' };
  if (body.attachments.length === 0) return { state: 'COMPLETE', storage: STORAGE.OBJECT_STORE, vaulted: 0, skipped: 0, failed: 0 };

  const record = await deps.identityRecords([Number(body.issueId)])
    .then(map => map.get(Number(body.issueId)) ?? null);
  const onIssue = canonicalAttachments(await deps.readIssueAttachments(body.issueKey), record?.files ?? null);
  const byId = new Map(onIssue.map(a => [String(a.id), a]));
  const targets = body.attachments.map(recorded => ({ recorded, current: byId.get(String(recorded.id)) ?? null }));
  const earlier = await deps.vaultedCopies({ issueId: body.issueId, attachmentIds: body.attachments.map(a => String(a.id)) });
  const results = { vaulted: 0, skipped: 0, failed: 0 };
  let retryable = false;
  // Carried between deliveries: failures already in the ledger are not written
  // again, and a file that failed for good is not tried again.
  const carried = eventOrBody?.retryContext?.retryData ?? {};
  const audited = new Set(Array.isArray(carried.audited) ? carried.audited.map(String) : []);
  const settled = new Set(Array.isArray(carried.settled) ? carried.settled.map(String) : []);
  const finalAttempt = retryCountOf(eventOrBody) >= MAX_VAULT_RETRIES;

  for (const { recorded, current } of targets) {
    const jiraAttachmentId = String(recorded.id);
    const filename = current?.filename ?? recorded.filename;
    if (await deps.isAttachmentVaulted({ baselineId: body.baselineId, jiraAttachmentId })) {
      results.skipped += 1;
      continue;
    }
    if (settled.has(jiraAttachmentId)) {
      results.failed += 1;
      continue;
    }
    try {
      let contentHash, mediaId = null, carriedForward = false;
      let objectKey = null;
      const copy = earlier.get(jiraAttachmentId);
      if (isReadableCopy(copy) && await deps.hasContent(copy.object_key)) {
        // Jira attachment bytes are immutable. Reuse an earlier baseline's
        // object instead of pulling the same file through Jira and Forge again.
        contentHash = copy.content_hash;
        mediaId = copy.media_id ?? null;
        if (!mediaId && current) {
          const liveMedia = await deps.mediaIdOf(current);
          mediaId = liveMedia ? record?.media?.get(liveMedia) ?? liveMedia : null;
        }
        objectKey = copy.object_key;
        carriedForward = true;
      } else if (current) {
        // Checked from Jira's own size, before the bytes are pulled into memory.
        if (tooLarge(current.size)) throw Object.assign(new Error(`TOO_LARGE: ${current.size} bytes; the vault takes files up to ${MAX_VAULT_BYTES} bytes`), { status: 413 });
        const buffer = await deps.downloadAttachment(current);
        contentHash = createHash('sha256').update(buffer).digest('hex');
        const liveMedia = await deps.mediaIdOf(current);
        mediaId = liveMedia ? record?.media?.get(liveMedia) ?? liveMedia : null;
        const put = await deps.putContent({ buffer, hash: contentHash });
        objectKey = put.objectKey;
      } else {
        // Recorded by the baseline, gone from the issue before this ran.
        throw Object.assign(new Error('The file was removed from the work item before it could be vaulted, and no earlier readable copy exists'), { status: 404 });
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
      const status = Number(error?.status ?? 0);
      if (!status || status >= 500 || status === 408 || status === 429) retryable = true;
      else settled.add(jiraAttachmentId);
      if (!audited.has(jiraAttachmentId)) {
        const written = await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULT_FAILED,
          payload: { baselineId: body.baselineId, jiraAttachmentId, filename, error: String(error?.message ?? error) } })
          .catch(error => { console.error('vaultWorker: could not record copy failure', error); return null; });
        if (written) audited.add(jiraAttachmentId);
      }
      results.failed += 1;
    }
  }

  if (retryable && !finalAttempt) {
    return retry(eventOrBody, { ...results, audited: [...audited].slice(0, MAX_CARRIED_IDS),
      settled: [...settled].slice(0, MAX_CARRIED_IDS) });
  }
  return { state: results.failed ? 'PARTIAL' : 'COMPLETE', storage: STORAGE.OBJECT_STORE, ...results };
}

export async function handler(event) {
  return withRequestCache(() => runVaultWorker(event));
}
