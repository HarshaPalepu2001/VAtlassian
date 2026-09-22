import api, { route } from '@forge/api';

export function deriveSpaceKey(projectKey) {
  const cleaned = String(projectKey ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) throw new Error('Cannot derive a vault space key from an empty project key');
  return `VLT${cleaned}`.slice(0, 64);
}

export async function findSpaceByKey(spaceKey, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${spaceKey}`);
  if (!res.ok) throw new Error(`Failed to look up Confluence space ${spaceKey}: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? null;
}

export async function createSpace({ spaceKey, name }, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: spaceKey, name })
  });
  if (res.status === 409) {
    const existing = await findSpaceByKey(spaceKey, forgeApi);
    if (existing) return existing;
    throw new Error(`Confluence reported space key ${spaceKey} already exists but it could not be found`);
  }
  if (!res.ok) throw new Error(`Failed to create Confluence space ${spaceKey}: ${res.status}`);
  return res.json();
}

/**
 * A freshly created space's only grants are Confluence's own defaults, so
 * removing all of them (rather than filtering by subject) is safe here
 * specifically — this must never be called against a pre-existing space.
 *
 * VERIFY AGAINST THE LIVE TEST SITE: confirm the legacy permission-list shape
 * below matches what a new space actually receives, and that DELETE removes
 * access rather than erroring when the last grant for an operation is removed.
 */
export async function restrictSpacePermissions(spaceKey, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/rest/api/space/${spaceKey}/permission`);
  if (!res.ok) throw new Error(`Failed to read permissions for space ${spaceKey}: ${res.status}`);
  const data = await res.json();
  for (const grant of data.results ?? []) {
    const delRes = await forgeApi.asApp().requestConfluence(
      route`/wiki/rest/api/space/${spaceKey}/permission/${grant.id}`, { method: 'DELETE' }
    );
    if (!delRes.ok && delRes.status !== 404) {
      throw new Error(`Failed to remove space permission ${grant.id} on ${spaceKey}: ${delRes.status}`);
    }
  }
}

export async function createVaultPage({ spaceId, issueKey }, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spaceId, status: 'current', title: issueKey,
      body: { representation: 'storage', value: `<p>Vaulted attachment evidence for ${issueKey}.</p>` }
    })
  });
  if (!res.ok) throw new Error(`Failed to create vault page for ${issueKey}: ${res.status}`);
  return res.json();
}

export async function uploadAttachmentToPage({ pageId, filename, buffer }, forgeApi = api) {
  const boundary = '----VAtlassianVault' + Math.random().toString(36).slice(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/child/attachment`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'nocheck', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error(`Failed to upload attachment ${filename} to page ${pageId}: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? data;
}
