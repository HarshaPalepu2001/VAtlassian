import api, { route } from '@forge/api';

/** Confluence storage format is XHTML; escape before interpolating any value into it. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A multipart Content-Disposition filename sits inside a quoted-string header
 * value. An attachment's filename is attacker-influenceable (anyone who can
 * attach a file to a Jira issue controls it), so a bare `"` or a CR/LF could
 * break out of the field and inject additional multipart headers/parts.
 * Stripped rather than merely escaped: CR/LF have no legitimate place in a
 * filename and stripping avoids relying on the receiving parser's unescaping.
 */
function sanitizeMultipartFilename(filename) {
  return String(filename).replace(/[\r\n]/g, '').replace(/"/g, "'");
}

export async function findSpaceByKey(spaceKey, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${spaceKey}`);
  if (!res.ok) throw new Error(`Failed to look up Confluence space ${spaceKey}: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? null;
}

/**
 * ONE VAULT FOR THE WHOLE SITE. Every project's evidence lives in this single
 * space, as a project page with one child page per work item — a site with a
 * thousand controlled projects still has exactly one vault, not a thousand
 * spaces cluttering anyone's directory.
 */
export const SITE_VAULT_KEY = 'VATVAULT';
export const SITE_VAULT_NAME = 'VAtlassian Vault';

/** The account the app itself acts as in Confluence. */
export async function appAccountId(forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/rest/api/user/current`);
  if (!res.ok) throw new Error(`Failed to read the app's own Confluence account: ${res.status}`);
  const user = await res.json();
  if (!user?.accountId) throw new Error("Confluence did not report the app's account id");
  return user.accountId;
}

/**
 * Creates the space PRIVATE to the app (`createPrivateSpace`): the creator is
 * the only principal with access, and here the creator is the app. No person
 * — not even a Confluence admin browsing the directory — sees it or finds its
 * content in search. Access is granted to a named person only when an audit
 * needs it; a site admin can always recover it from Confluence administration.
 *
 * This replaced creating an ordinary space and deleting its grants afterwards,
 * which left the space open until the deletes ran and would have removed the
 * app's own access along with everyone else's.
 *
 * On a key collision (a half-finished earlier attempt) the existing space is
 * adopted ONLY if this app created it. A same-key space someone else made
 * could be readable by anyone; evidence must never be written into it.
 */
export async function createSpace({ spaceKey, name, ownerAccountId }, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: spaceKey,
      name,
      createPrivateSpace: true,
      description: { value: 'Tamper-evident copies of attachments on approved Jira work items, kept by VAtlassian. Managed by the app — do not edit.', representation: 'plain' }
    })
  });
  if (res.ok) {
    const data = await res.json();
    return { ...data, created: true, adopted: false };
  }
  if (res.status === 409 || res.status === 400) {
    const existing = await findSpaceByKey(spaceKey, forgeApi);
    if (existing) {
      if (!ownerAccountId || existing.authorId !== ownerAccountId) {
        throw new Error(`Confluence space ${spaceKey} already exists but was not created by this app; refusing to store evidence in it`);
      }
      return { ...existing, created: false, adopted: true };
    }
  }
  throw new Error(`Failed to create Confluence space ${spaceKey}: ${res.status}`);
}

export async function findPageByTitle({ spaceId, title }, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(
    route`/wiki/api/v2/pages?space-id=${spaceId}&title=${title}&status=current&limit=1`
  );
  if (!res.ok) throw new Error(`Failed to look up vault page "${title}": ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? null;
}

async function createPage({ spaceId, parentId, title, html }, forgeApi) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spaceId, status: 'current', title,
      ...(parentId ? { parentId } : {}),
      body: { representation: 'storage', value: html }
    })
  });
  if (!res.ok) throw new Error(`Failed to create vault page "${title}": ${res.status}`);
  return res.json();
}

/** The per-project parent page every issue page of that project sits under. */
export async function createProjectPage({ spaceId, parentId, title }, forgeApi = api) {
  return createPage({ spaceId, parentId, title,
    html: `<p>Vaulted attachment evidence for work items in ${escapeHtml(title)}.</p>` }, forgeApi);
}

export async function createVaultPage({ spaceId, parentId, issueKey }, forgeApi = api) {
  return createPage({ spaceId, parentId, title: issueKey,
    html: `<p>Vaulted attachment evidence for ${escapeHtml(issueKey)}.</p>` }, forgeApi);
}

/**
 * PUT, not POST: PUT creates the attachment or adds a new VERSION of one with
 * the same name, where POST refuses a name already on the page — which every
 * second baseline of the same file would hit. `minorEdit` is a required form
 * field on this endpoint.
 */
export async function uploadAttachmentToPage({ pageId, filename, buffer }, forgeApi = api) {
  const boundary = '----VAtlassianVault' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sanitizeMultipartFilename(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="minorEdit"\r\n\r\ntrue`, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ]);
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/child/attachment`, {
    method: 'PUT',
    headers: { 'X-Atlassian-Token': 'nocheck', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error(`Failed to upload attachment ${filename} to page ${pageId}: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? data;
}
