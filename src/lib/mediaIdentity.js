/**
 * Which media file a Jira attachment is.
 *
 * Rich text points at an attachment by its media id, and Jira's attachment
 * API does not return it. The download does: `GET /attachment/content/{id}`
 * answers 303 with a Location of `https://api.media.atlassian.com/file/{mediaId}/binary`,
 * and Forge hands that Location back when asked not to follow it (probed on
 * mgtechdemo 2026-09-24). Null when Jira answers any other way: callers treat
 * an unknown media id as "cannot point rich text at this copy", never guess.
 */
export function mediaIdFromLocation(location) {
  const match = String(location ?? '').match(/\/file\/([0-9a-f-]{36})\//i);
  return match ? match[1].toLowerCase() : null;
}

export async function readMediaId({ api, route, attachmentId }) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`, { redirect: 'manual' });
    return mediaIdFromLocation(res?.headers?.get?.('location'));
  } catch (error) {
    console.error('mediaIdentity: could not read the media id of attachment', attachmentId, error);
    return null;
  }
}
