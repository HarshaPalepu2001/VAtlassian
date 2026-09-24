/**
 * THE ATTACHMENT VAULTING WORKER — consumer of va-vault-queue.
 *
 * applyApproval (usecases/drift.js) enqueues one job per captured baseline, so
 * this runs off the approval's own 25-second budget. It copies the issue's
 * CURRENT attachments onto that issue's page in the site vault
 * (lib/vaultConfluence.js), hashing each one and recording it against the
 * baseline in va_vault_attachment.
 *
 * Forge queues deliver at least once: an attachment already recorded for this
 * baseline is skipped, and a page left behind by an earlier failed run is found
 * by title rather than created again. One attachment failing never stops the
 * rest — each failure is audited, and the next baseline re-sends the whole set.
 */
import api, { route } from '@forge/api';
import { createHash } from 'node:crypto';
import { ensureVaultSpace } from '../lib/vaultProvision.js';
import { getVaultPage, insertVaultPage, isAttachmentVaulted, insertVaultAttachment } from '../db/vaultStore.js';
import { findPageByTitle, createVaultPage, uploadAttachmentToPage } from '../lib/vaultConfluence.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
import { withRequestCache } from '../lib/cache.js';

async function defaultReadIssueAttachments(issueKey) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment`);
  if (!res.ok) throw new Error(`Failed to read attachments for ${issueKey}: ${res.status}`);
  const data = await res.json();
  return data.fields?.attachment ?? [];
}

async function defaultDownloadAttachment(attachment) {
  const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachment.id}?redirect=false`);
  if (!res.ok) throw new Error(`Failed to download attachment ${attachment.id}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function runVaultWorker(eventOrBody, overrides = {}) {
  const body = eventOrBody?.body ?? eventOrBody;
  const deps = {
    ensureVaultSpace, getVaultPage, insertVaultPage, findPageByTitle, createVaultPage,
    isAttachmentVaulted, insertVaultAttachment, uploadAttachmentToPage,
    readIssueAttachments: defaultReadIssueAttachments,
    downloadAttachment: defaultDownloadAttachment,
    tryAppend, now: Date.now,
    ...overrides
  };
  if (!body?.baselineId || !body?.issueId || !body?.issueKey || !body?.projectId) {
    return { state: 'FAILED', reason: 'INVALID_BODY' };
  }

  const vault = await deps.ensureVaultSpace(body.projectId);

  let page = await deps.getVaultPage(body.issueId);
  if (!page) {
    const found = await deps.findPageByTitle({ spaceId: vault.spaceId, title: body.issueKey })
      ?? await deps.createVaultPage({ spaceId: vault.spaceId, parentId: vault.projectPageId, issueKey: body.issueKey });
    await deps.insertVaultPage({ issueId: body.issueId, projectId: body.projectId, confluencePageId: String(found.id), now: deps.now() });
    page = { confluence_page_id: String(found.id) };
  }

  const attachments = await deps.readIssueAttachments(body.issueKey);
  const results = { vaulted: 0, skipped: 0, failed: 0 };

  for (const attachment of attachments) {
    if (await deps.isAttachmentVaulted({ baselineId: body.baselineId, jiraAttachmentId: String(attachment.id) })) {
      results.skipped += 1;
      continue;
    }
    try {
      const buffer = await deps.downloadAttachment(attachment);
      const contentHash = createHash('sha256').update(buffer).digest('hex');
      // Prefixed with the Jira attachment id: two different files may share a
      // name on one issue, and on the page they must stay two attachments.
      const uploaded = await deps.uploadAttachmentToPage({
        pageId: page.confluence_page_id, filename: `${attachment.id}-${attachment.filename}`, buffer
      });
      await deps.insertVaultAttachment({
        baselineId: body.baselineId, issueId: body.issueId, jiraAttachmentId: String(attachment.id),
        filename: attachment.filename, contentHash, confluenceAttachmentId: String(uploaded.id), now: deps.now()
      });
      await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULTED,
        payload: { baselineId: body.baselineId, jiraAttachmentId: String(attachment.id), filename: attachment.filename, contentHash } });
      results.vaulted += 1;
    } catch (error) {
      console.error('vaultWorker: failed to vault attachment', attachment.id, error);
      await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULT_FAILED,
        payload: { baselineId: body.baselineId, jiraAttachmentId: String(attachment.id), error: String(error?.message ?? error) } });
      results.failed += 1;
    }
  }

  return { state: 'COMPLETE', ...results };
}

export async function handler(event) {
  return withRequestCache(() => runVaultWorker(event));
}
