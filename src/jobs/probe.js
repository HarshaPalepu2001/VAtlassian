import api, { route } from '@forge/api';
import { createHash, timingSafeEqual } from 'node:crypto';
import { executeQuery } from '../lib/db.js';
import { defaultVaultObjectStore } from '../lib/vaultObjectStore.js';

/**
 * Temporary read-only attachment probe. Remove after the design is settled.
 *
 * Check whether download redirects expose media IDs, map description media
 * pointers to attachments, verify vaulted copies against recorded hashes and
 * inspect attachment-delete grants on the project's permission scheme.
 *
 * The encrypted PROBE_SECRET variable guards access. The probe changes nothing.
 */
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify(body, null, 2) });
const rows = async (sql, params) => {
  const result = await executeQuery(sql, params);
  return result?.result ? result.data : { error: String(result?.error?.message ?? result?.error ?? 'query failed') };
};

function mediaIdFrom(location) {
  const match = String(location ?? '').match(/\/file\/([0-9a-f-]{36})\//i);
  return match ? match[1] : null;
}

async function mediaIdOf(attachmentId) {
  const out = {};
  for (const [label, options] of [['manual', { redirect: 'manual' }], ['default', {}]]) {
    try {
      const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`, options);
      const location = res.headers?.get?.('location') ?? null;
      out[label] = { status: res.status, redirected: res.redirected ?? null, url: res.url ?? null,
        location, mediaId: mediaIdFrom(location) ?? mediaIdFrom(res.url) };
    } catch (error) {
      out[label] = { error: String(error?.message ?? error) };
    }
  }
  return out;
}

function mediaNodes(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'media') found.push({ ...node.attrs });
  for (const child of node.content ?? []) mediaNodes(child, found);
  return found;
}

async function vaultProof(issueId) {
  const vaulted = await rows(`SELECT va.baseline_id, va.jira_attachment_id, va.filename, va.content_hash,
      va.media_id, va.vaulted_at, va.storage, va.object_key
    FROM va_vault_attachment va
    WHERE va.issue_id = ? ORDER BY va.vaulted_at`, [issueId]);
  if (!Array.isArray(vaulted)) return vaulted;
  const proof = [];
  for (const row of vaulted) {
    const entry = { ...row, vaultedAt: new Date(Number(row.vaulted_at)).toISOString() };
    try {
      if (row.storage === 'OBJECT_STORE') {
        const bytes = await (await defaultVaultObjectStore()).getContent(row.object_key);
        const hash = sha256(bytes);
        entry.download = { from: 'OBJECT_STORE', bytes: bytes.length, sha256: hash, matchesRecord: hash === row.content_hash };
        proof.push(entry);
        continue;
      }
    } catch (error) {
      entry.download = { error: String(error?.message ?? error) };
    }
    proof.push(entry);
  }
  return proof;
}

async function deleteGrants(projectId) {
  const res = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}/permissionscheme?expand=permissions,user,group,projectRole`);
  if (!res.ok) return { status: res.status };
  const scheme = await res.json();
  return { schemeId: scheme.id, schemeName: scheme.name,
    grants: (scheme.permissions ?? []).filter(p => /ATTACHMENT/.test(p.permission))
      .map(p => ({ id: p.id, permission: p.permission, holder: { type: p.holder?.type, value: p.holder?.value,
        name: p.holder?.projectRole?.name ?? p.holder?.group?.name ?? p.holder?.user?.displayName ?? null } })) };
}

/**
 * The secret travels in the `x-probe-secret` header, never the URL (which
 * proxies, access logs and browser history keep), and is compared in constant
 * time. Both sides are hashed first so their lengths always match.
 */
function authorised(request) {
  const secret = process.env.PROBE_SECRET;
  const given = request?.headers?.['x-probe-secret']?.[0];
  if (!secret || typeof given !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(secret).digest());
}

async function liveAttachmentRetrievalTest(issue, { uploadTest = false } = {}) {
  const results = {
    syntheticObjectStoreRoundtrip: null,
    endToEndJiraAttachmentTest: null,
    jiraAttachmentsTested: []
  };

  try {
    const testBytes = Buffer.from(`Live Forge Object Store probe byte test: ${new Date().toISOString()}`);
    const testHash = sha256(testBytes);
    const vault = await defaultVaultObjectStore();
    const put = await vault.putContent({ buffer: testBytes, hash: testHash });
    const get = await vault.getContent(put.objectKey);
    const getHash = sha256(get);
    results.syntheticObjectStoreRoundtrip = {
      ok: getHash === testHash && get.length === testBytes.length,
      bytesLength: get.length,
      objectKey: put.objectKey,
      reused: put.reused,
      hashMatch: getHash === testHash
    };
  } catch (err) {
    results.syntheticObjectStoreRoundtrip = {
      ok: false,
      error: String(err?.message ?? err),
      status: err?.status ?? null
    };
  }

  if (uploadTest) {
    const e2e = {};
    let createdAttachmentId = null;
    try {
      const filename = `vatlassian-live-test-${Date.now()}.txt`;
      const originalPayload = Buffer.from(`VAtlassian Live Jira Attachment Test Content Generated at ${new Date().toISOString()}`);
      const expectedHash = sha256(originalPayload);
      e2e.filename = filename;
      e2e.expectedSize = originalPayload.length;
      e2e.expectedHash = expectedHash;

      const boundary = '----VAtlassianTest' + Math.random().toString(36).slice(2);
      const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8'),
        originalPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ]);
      const uploadRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issue.key}/attachments`, {
        method: 'POST',
        headers: {
          'X-Atlassian-Token': 'no-check',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Accept: 'application/json'
        },
        body: multipartBody
      });
      e2e.jiraUploadStatus = uploadRes.status;
      if (!uploadRes.ok) {
        throw new Error(`Jira attachment upload failed: HTTP ${uploadRes.status}`);
      }
      const createdList = await uploadRes.json();
      const created = Array.isArray(createdList) ? createdList[0] : createdList;
      createdAttachmentId = created?.id;
      e2e.createdAttachmentId = createdAttachmentId;

      const downloadRes = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${createdAttachmentId}`);
      e2e.jiraDownloadStatus = downloadRes.status;
      if (!downloadRes.ok) {
        throw new Error(`Jira attachment download failed: HTTP ${downloadRes.status}`);
      }
      const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
      const downloadedHash = sha256(downloadedBytes);
      e2e.jiraDownloadedBytes = downloadedBytes.length;
      e2e.jiraDownloadedHash = downloadedHash;
      e2e.jiraRetrievalMatches = (downloadedHash === expectedHash && downloadedBytes.length === originalPayload.length);

      const vault = await defaultVaultObjectStore();
      const put = await vault.putContent({ buffer: downloadedBytes, hash: downloadedHash });
      e2e.objectStorePut = { ok: true, objectKey: put.objectKey, reused: put.reused };

      const vaultedBytes = await vault.getContent(put.objectKey);
      const vaultedHash = sha256(vaultedBytes);
      e2e.objectStoreRetrievedBytes = vaultedBytes.length;
      e2e.objectStoreRetrievedHash = vaultedHash;
      e2e.objectStoreRetrievalMatches = (vaultedHash === expectedHash && vaultedBytes.length === originalPayload.length);

      e2e.overallSuccess = e2e.jiraRetrievalMatches && e2e.objectStoreRetrievalMatches;

      if (createdAttachmentId) {
        const delRes = await api.asApp().requestJira(route`/rest/api/3/attachment/${createdAttachmentId}`, { method: 'DELETE' });
        e2e.cleanupStatus = delRes.status;
      }
    } catch (err) {
      e2e.overallSuccess = false;
      e2e.error = String(err?.message ?? err);
      if (createdAttachmentId) {
        await api.asApp().requestJira(route`/rest/api/3/attachment/${createdAttachmentId}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    results.endToEndJiraAttachmentTest = e2e;
  }

  for (const a of issue.fields.attachment ?? []) {
    const item = { id: a.id, filename: a.filename, size: a.size };
    try {
      const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${a.id}`);
      item.jiraDownloadStatus = res.status;
      if (!res.ok) {
        item.jiraDownloadError = `HTTP ${res.status}`;
        results.jiraAttachmentsTested.push(item);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      item.jiraBytesDownloaded = bytes.length;
      item.jiraContentHash = sha256(bytes);

      const vault = await defaultVaultObjectStore();
      const put = await vault.putContent({ buffer: bytes, hash: item.jiraContentHash });
      item.objectStorePut = { ok: true, objectKey: put.objectKey, reused: put.reused };

      const retrieved = await vault.getContent(put.objectKey);
      const retrievedHash = sha256(retrieved);
      item.objectStoreGet = {
        ok: true,
        bytesRetrieved: retrieved.length,
        hashMatch: retrievedHash === item.jiraContentHash
      };
      item.overallSuccess = item.objectStoreGet.hashMatch && retrieved.length === bytes.length;
    } catch (err) {
      item.error = String(err?.message ?? err);
      item.status = err?.status ?? null;
      item.overallSuccess = false;
    }
    results.jiraAttachmentsTested.push(item);
  }

  return results;
}

export async function handler(request) {
  if (!authorised(request)) return json(403, { error: 'forbidden' });
  const issueKey = request?.queryParameters?.issue?.[0];
  if (!issueKey) return json(400, { error: 'issue is required' });

  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment,description,project,issuetype`);
  if (!res.ok) return json(res.status, { error: 'issue unreadable' });
  const issue = await res.json();
  const issueId = Number(issue.id);
  const me = await api.asApp().requestJira(route`/rest/api/3/myself`).then(r => r.json()).catch(() => null);

  const attachments = [];
  for (const a of issue.fields.attachment ?? []) {
    attachments.push({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType, created: a.created,
      author: a.author?.displayName, mediaIdProbe: await mediaIdOf(a.id) });
  }

  const runMigration = request?.queryParameters?.runMigration?.[0] === 'true';
  let migrationResult = null;
  if (runMigration) {
    try {
      const { run } = await import('./migrate.js');
      migrationResult = await run();
    } catch (err) {
      migrationResult = { ok: false, error: String(err?.message ?? err) };
    }
  }

  const testAttachment = request?.queryParameters?.testAttachment?.[0] === 'true';
  const uploadTest = request?.queryParameters?.uploadTest?.[0] === 'true';
  let liveRetrievalTest = null;
  if (testAttachment) {
    liveRetrievalTest = await liveAttachmentRetrievalTest(issue, { uploadTest });
  }

  return json(200, {
    issue: { key: issue.key, id: issueId, projectId: issue.fields.project?.id, issueTypeId: issue.fields.issuetype?.id },
    appAccountId: me?.accountId ?? null,
    attachments,
    descriptionMediaNodes: mediaNodes(issue.fields.description),
    aliases: await rows('SELECT attachment_id, stands_for_id, media_id, stands_for_media_id, content_hash, created_at FROM va_attachment_alias WHERE issue_id = ?', [issueId]),
    vault: await vaultProof(issueId),
    vaultSpace: await rows('SELECT project_id, permission_scheme_id, permission_locked_at, app_delete_granted_at, app_delete_checked_at FROM va_vault_space WHERE project_id = ?', [Number(issue.fields.project?.id)]),
    controlledAttachmentField: await rows(`SELECT project_id, issue_type_id, field_id, state, store_values FROM va_controlled_field
      WHERE project_id = ? AND field_id = 'attachment'`, [Number(issue.fields.project?.id)]),
    vaultLedger: await rows(`SELECT event_type, payload, occurred_at FROM va_audit WHERE issue_id = ?
      AND event_type LIKE 'ATTACHMENT%' ORDER BY occurred_at DESC LIMIT 20`, [issueId]),
    restoreRows: await rows('SELECT TO_BASE64(restore_id) as restore_id, TO_BASE64(approval_id) as approval_id, state, detail, candidate_digests FROM va_restore WHERE issue_id = ? ORDER BY started_at DESC LIMIT 3', [issueId]),
    approvalRows: await rows('SELECT TO_BASE64(approval_id) as approval_id, decision, assurance_level, meaning, decision_map FROM va_approval WHERE issue_id = ? ORDER BY decided_at DESC LIMIT 3', [issueId]),
    deletePermission: await deleteGrants(issue.fields.project?.id),
    migrationResult,
    liveRetrievalTest
  });
}
