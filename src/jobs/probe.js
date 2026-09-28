import api, { route } from '@forge/api';
import { createHash } from 'node:crypto';
import { executeQuery } from '../lib/db.js';

/**
 * TEMPORARY, READ-ONLY LIVE PROBE — remove once the attachment design is settled.
 *
 * Answers, against the real site, what the attachment design depends on:
 *   1. Can a Forge function learn an attachment's media file id (the id a
 *      rich-text field points at) from the download redirect?
 *   2. Which media ids does the description point at, and which attachment is each?
 *   3. What does the vault hold for this issue, and do those Confluence copies
 *      still hash to what was recorded? (the proof a file sits in Confluence)
 *   4. Who holds attachment-delete permission on the project's scheme?
 *
 * Guarded by the encrypted PROBE_SECRET variable. It changes nothing.
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
      va.confluence_attachment_id, va.media_id, va.vaulted_at, vp.confluence_page_id
    FROM va_vault_attachment va LEFT JOIN va_vault_page vp ON vp.issue_id = va.issue_id
    WHERE va.issue_id = ? ORDER BY va.vaulted_at`, [issueId]);
  if (!Array.isArray(vaulted)) return vaulted;
  const proof = [];
  for (const row of vaulted) {
    const entry = { ...row, vaultedAt: new Date(Number(row.vaulted_at)).toISOString() };
    try {
      const res = await api.asApp().requestConfluence(
        route`/wiki/rest/api/content/${row.confluence_page_id}/child/attachment/${row.confluence_attachment_id}/download`);
      if (!res.ok) entry.download = { status: res.status };
      else {
        const bytes = Buffer.from(await res.arrayBuffer());
        const hash = sha256(bytes);
        entry.download = { status: res.status, bytes: bytes.length, sha256: hash, matchesRecord: hash === row.content_hash };
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

export async function handler(request) {
  const secret = process.env.PROBE_SECRET;
  const given = request?.queryParameters?.secret?.[0];
  if (!secret || given !== secret) return json(403, { error: 'forbidden' });
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
  return json(200, {
    issue: { key: issue.key, id: issueId, projectId: issue.fields.project?.id, issueTypeId: issue.fields.issuetype?.id },
    appAccountId: me?.accountId ?? null,
    attachments,
    descriptionMediaNodes: mediaNodes(issue.fields.description),
    aliases: await rows('SELECT attachment_id, stands_for_id, media_id, stands_for_media_id, content_hash, created_at FROM va_attachment_alias WHERE issue_id = ?', [issueId]),
    vault: await vaultProof(issueId),
    vaultSpace: await rows('SELECT project_id, project_page_id, permission_scheme_id, permission_locked_at, app_delete_granted_at FROM va_vault_space WHERE project_id = ?', [Number(issue.fields.project?.id)]),
    controlledAttachmentField: await rows(`SELECT project_id, issue_type_id, field_id, state, store_values FROM va_controlled_field
      WHERE project_id = ? AND field_id = 'attachment'`, [Number(issue.fields.project?.id)]),
    vaultLedger: await rows(`SELECT event_type, payload, occurred_at FROM va_audit WHERE issue_id = ?
      AND event_type LIKE 'ATTACHMENT%' ORDER BY occurred_at DESC LIMIT 20`, [issueId]),
    deletePermission: await deleteGrants(issue.fields.project?.id)
  });
}
