import { identityRecords, recordAttachmentAlias, vaultedCopies } from '../../db/vaultStore.js';
import { readMediaId } from '../mediaIdentity.js';
import { readForIssue, tryAppend } from '../../db/store.js';
import { defaultVaultObjectStore } from '../vaultObjectStore.js';
import { EVENT } from '../ledger.js';

/**
 * A multipart Content-Disposition filename sits inside a quoted-string header
 * value. An attachment's filename is attacker-influenceable, so bare `"` or CR/LF
 * are stripped rather than merely escaped.
 */
export function sanitizeMultipartFilename(filename) {
  return String(filename).replace(/[\r\n]/g, '').replace(/"/g, "'");
}

/**
 * The Jira, Object Store and database side of ./attachments.js, which stays
 * free of I/O so it can be tested exhaustively.
 *
 * Everything acts as the APP: the vault is private to it, and on a project
 * whose attachment deletion is locked (lib/vaultProvision.js) only the app's
 * own account keeps the grant to delete.
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
  objectStore = null, readLedger = readForIssue }) {
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

    /** From the Forge Object Store (lib/vaultLocation.js). */
    async downloadVaulted(copy) {
      if (copy?.storage === 'CONFLUENCE') {
        throw failure('DOWNLOAD_VAULTED', 404, 'stored in Confluence, which is no longer supported');
      }
      return (await vaultStore()).getContent(copy.object_key);
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

    /**
     * Whether a restore already wrote evidence for this copy: a retry that
     * recovers its own upload must not record the same restoration twice.
     * Throws: the evidence decision waits on it.
     */
    async restoredEvidence({ issueId, attachmentId, originalAttachmentId }) {
      try {
        return (await readLedger(Number(issueId))).some(row => {
          if (row.event_type !== EVENT.ATTACHMENT_RESTORED) return false;
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          return String(payload?.attachmentId) === String(attachmentId)
            && String(payload?.originalAttachmentId) === String(originalAttachmentId);
        });
      } catch (error) {
        throw failure('AUDIT', 503, `Earlier restore evidence could not be read: ${error?.message ?? error}`);
      }
    },

    // Strict: a delete waits on this entry, so an entry that was not written
    // is a failure (503, retried), never a silent gap in the audit trail.
    async audit(eventType, payload, issueId) {
      const written = await append({ actorAccountId, issueId: Number(issueId), approvalId,
        eventType: EVENT[eventType] ?? eventType, payload });
      if (!written) throw failure('AUDIT', 503, `The ${eventType} audit entry could not be written.`);
      return written;
    }
  };
}
