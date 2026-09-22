import api, { route } from '@forge/api';

const ATTACHMENT_DELETE_PERMISSIONS = ['DELETE_OWN_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS'];

export async function getProjectPermissionScheme(projectId, forgeApi = api) {
  const res = await forgeApi.asApp().requestJira(route`/rest/api/3/project/${projectId}/permissionscheme`);
  if (!res.ok) throw new Error(`Failed to read permission scheme for project ${projectId}: ${res.status}`);
  return res.json();
}

export function attachmentDeleteGrantIds(scheme) {
  return (scheme?.permissions ?? [])
    .filter((p) => ATTACHMENT_DELETE_PERMISSIONS.includes(p.permission))
    .map((p) => p.id);
}

export async function removeAttachmentDeleteGrants({ schemeId, grantIds }, forgeApi = api) {
  for (const grantId of grantIds) {
    const res = await forgeApi.asApp().requestJira(
      route`/rest/api/3/permissionscheme/${schemeId}/permission/${grantId}`, { method: 'DELETE' }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to remove permission grant ${grantId} from scheme ${schemeId}: ${res.status}`);
    }
  }
}
