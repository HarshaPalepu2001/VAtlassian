import api, { route } from '@forge/api';

const ATTACHMENT_DELETE_PERMISSIONS = ['DELETE_OWN_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS'];

export async function getProjectPermissionScheme(projectId, forgeApi = api) {
  const res = await forgeApi.asApp().requestJira(route`/rest/api/3/project/${projectId}/permissionscheme`);
  if (!res.ok) throw new Error(`Failed to read permission scheme for project ${projectId}: ${res.status}`);
  return res.json();
}

export async function getProjectsUsingPermissionScheme(schemeId, projectIdToExclude = null, forgeApi = api) {
  const { lookupProjects } = await import('./directory.js');
  const projectsMap = await lookupProjects();
  if (projectsMap.size === 0) return [];
  
  const allProjects = Array.from(projectsMap.entries())
    .map(([id, info]) => ({ id, key: info.key }))
    .filter(p => String(p.id) !== String(projectIdToExclude));
    
  const matches = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < allProjects.length; i += CONCURRENCY) {
    const batch = allProjects.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (project) => {
      try {
        const res = await forgeApi.asApp().requestJira(route`/rest/api/3/project/${project.id}/permissionscheme`);
        if (res.ok) {
          const ps = await res.json();
          if (String(ps.id) === String(schemeId)) return project.key;
        }
      } catch (e) {
        // ignore
      }
      return null;
    }));
    matches.push(...results.filter(Boolean));
  }
  return matches;
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
