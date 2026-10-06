import { identityRecords, recordAttachmentAlias, vaultedCopies, getVaultPage } from '../../db/vaultStore.js';
import { readMediaId } from '../mediaIdentity.js';
import { downloadVaultAttachment, uploadAttachmentToPage, sanitizeMultipartFilename } from '../vaultConfluence.js';
import { jiraIdOf } from '../attachmentIdentity.js';
import { tryAppend } from '../../db/store.js';
import { STORAGE } from '../vaultLocation.js';
import { defaultVaultObjectStore } from '../vaultObjectStore.js';
import { EVENT } from '../ledger.js';

/**
 * The Jira, Confluence and database side of ./attachments.js, which stays
 * free of I/O so it can be tested exhaustively.
 *
 * Everything acts as the APP: the vault is private to it, and on a project
 * whose attachment deletion is locked (lib/vaultProvision.js) only the app's
 * own account keeps the grant to delete. Each failure carries Jira's or
 * Confluence's HTTP status, which is how ./attachments.js tells a refusal of
 * one file from a failure of the whole system.
 */

function failure(operation, status, detail) {
  const error = new Error(`${operation} failed${status ? ` (${status})` : ''}: ${detail}`);
  error.operation = operation;
  error.status = status;
  error.detail = detail;
  return error;
}

async function detailOf(response) {
  try {
    const body = await response.json();
    const messages = [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})].map(String);
    return messages.join('; ') || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * @param actorAccountId, approvalId  who rejected, and the signed rejection,
 *                      recorded on every ledger entry this writes.
 */
export function createAttachmentRestoreDeps({ api, route, actorAccountId = 'system', approvalId = null, append = tryAppend,
  objectStore = null }) {
  const jira = (path, options) => api.asApp().requestJira(path, options);
  let store = objectStore;
  const vaultStore = async () => (store ??= await defaultVaultObjectStore());
  return {
    async aliases(issueId) {
      try {
        return (await identityRecords([issueId])).get(Number(issueId))?.files ?? null;
      } catch (error) {
        // Without the aliases a restored copy would look like an added file and
        // be deleted. Retry later rather than act on a wrong picture.
        throw failure('READ_ATTACHMENT_ALIASES', 503, String(error?.message ?? error));
      }
    },

    async readCurrent(issueKey) {
      const response = await jira(route`/rest/api/3/issue/${issueKey}?fields=attachment`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw failure('READ_ATTACHMENTS', response.status, await detailOf(response));
      const list = (await response.json())?.fields?.attachment;
      if (!Array.isArray(list)) throw failure('READ_ATTACHMENTS', 502, 'Jira omitted the work item\'s attachments; no file was changed.');
      return list;
    },

    vaultedCopies,

    /** From wherever the copy was vaulted (lib/vaultLocation.js). */
    async downloadVaulted(copy) {
      if ((copy.storage ?? STORAGE.CONFLUENCE) === STORAGE.OBJECT_STORE) return (await vaultStore()).getContent(copy.object_key);
      return downloadVaultAttachment({ pageId: copy.confluence_page_id, attachmentId: copy.confluence_attachment_id }, api);
    },

    async upload({ issueKey, filename, mimeType, buffer }) {
      const boundary = '----VAtlassianRestore' + Math.random().toString(36).slice(2);
      const type = typeof mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sanitizeMultipartFilename(filename)}"\r\nContent-Type: ${type}\r\n\r\n`, 'utf8'),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ]);
      const response = await jira(route`/rest/api/3/issue/${issueKey}/attachments`, {
        method: 'POST',
        headers: { 'X-Atlassian-Token': 'no-check', 'Content-Type': `multipart/form-data; boundary=${boundary}`, Accept: 'application/json' },
        body
      });
      if (!response.ok) throw failure('UPLOAD_ATTACHMENT', response.status, await detailOf(response));
      const created = await response.json();
      return Array.isArray(created) ? created[0] : created;
    },

    async download(jiraId) {
      const response = await jira(route`/rest/api/3/attachment/content/${jiraId}?redirect=false`);
      if (!response.ok) throw failure('DOWNLOAD_ATTACHMENT', response.status, `attachment ${jiraId}`);
      return Buffer.from(await response.arrayBuffer());
    },

    async remove(jiraId) {
      const response = await jira(route`/rest/api/3/attachment/${jiraId}`, { method: 'DELETE' });
      // Already gone is the state a removal wants.
      if (!response.ok && response.status !== 404) throw failure('DELETE_ATTACHMENT', response.status, await detailOf(response));
    },

    recordAlias: alias => recordAttachmentAlias(alias),

    mediaIdOf: attachmentId => readMediaId({ api, route, attachmentId }),

    /** Restored copies on this item, for pointing rich text at them. Throws: a write waits on it. */
    async identity(issueId) {
      try {
        return (await identityRecords([issueId])).get(Number(issueId)) ?? null;
      } catch (error) {
        throw failure('READ_ATTACHMENT_ALIASES', 503, String(error?.message ?? error));
      }
    },

    // Strict: a delete waits on this entry, so an entry that was not written
    // is a failure (503, retried), never a silent gap in the audit trail.
    async audit(eventType, payload, issueId) {
      const written = await append({ actorAccountId, issueId: Number(issueId), approvalId,
        eventType: EVENT[eventType] ?? eventType, payload });
      if (!written) throw failure('AUDIT', 503, `The ${eventType} audit entry could not be written.`);
      return written;
    },

    /**
     * Keep the bytes of a file about to be deleted: on the item's vault page
     * when it has one, otherwise in the Object Store.
     */
    async preserve({ issueId, file, buffer }) {
      const page = await getVaultPage(issueId).catch(() => null);
      if (page?.confluence_page_id) {
        try {
          const uploaded = await uploadAttachmentToPage({ pageId: page.confluence_page_id,
            filename: `rejected-${jiraIdOf(file)}-${file.filename ?? 'file'}`, buffer }, api);
          return { storage: STORAGE.CONFLUENCE, confluenceAttachmentId: String(uploaded?.id ?? '') || null };
        } catch (error) {
          console.error('restore: could not keep the removed file in Confluence; using the Object Store', error);
        }
      }
      const put = await (await vaultStore()).putContent({ buffer });
      return { storage: STORAGE.OBJECT_STORE, objectKey: put.objectKey };
    }
  };
}
