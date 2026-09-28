import api, { route } from '@forge/api';

const ATTACHMENT_DELETE_PERMISSIONS = ['DELETE_OWN_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS'];

/**
 * `expand=permissions`: without it Jira returns the scheme's name and id and
 * NOT its grants, so the lockdown found nothing to remove.
 */
export async function getProjectPermissionScheme(projectId, forgeApi = api) {
  const res = await forgeApi.asApp().requestJira(route`/rest/api/3/project/${projectId}/permissionscheme?expand=permissions,projectRole`);
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

/**
 * The project role Jira puts every installed app's account in. Apps reach a
 * project through it, and on mgtechdemo (2026-09-24) it held Delete all
 * attachments in the default scheme. Jira refused (400) to grant that
 * permission to the app's own account directly, so this role is how the app
 * keeps the right to delete a file a rejection must remove.
 */
export const APP_ROLE_NAME = 'atlassian-addons-project-access';

const heldBy = (grant, accountId) => accountId != null && grant?.holder?.type === 'user'
  && (String(grant.holder.value ?? '') === String(accountId) || String(grant.holder.parameter ?? '') === String(accountId));
const heldByAppRole = grant => grant?.holder?.type === 'projectRole' && grant.holder.projectRole?.name === APP_ROLE_NAME;
const keptForApps = (grant, accountId) => heldBy(grant, accountId) || heldByAppRole(grant);

/**
 * Every attachment-delete grant on the scheme EXCEPT those that let the app
 * itself delete: its own account's, and the app role's. A rejection removes
 * files added after approval (lib/restore/attachments.js), so the app must
 * keep that right. What this leaves open, said plainly: every installed app
 * is in the app role, so other apps can still delete attachments. No person
 * can, unless an administrator grants it back.
 */
export function attachmentDeleteGrantIds(scheme, { keepAccountId = null } = {}) {
  return (scheme?.permissions ?? [])
    .filter((p) => ATTACHMENT_DELETE_PERMISSIONS.includes(p.permission))
    .filter((p) => !keptForApps(p, keepAccountId))
    .map((p) => p.id);
}

/** Whether the app can still delete any attachment once the lockdown has run. */
export function hasAppDeleteGrant(scheme, accountId) {
  return (scheme?.permissions ?? []).some((p) => p.permission === 'DELETE_ALL_ATTACHMENTS' && keptForApps(p, accountId));
}

/** The app's own Jira account, which is what acts on every asApp() request. */
export async function appJiraAccountId(forgeApi = api) {
  const res = await forgeApi.asApp().requestJira(route`/rest/api/3/myself`);
  if (!res.ok) throw new Error(`Failed to read the app's own Jira account: ${res.status}`);
  const me = await res.json();
  if (!me?.accountId) throw new Error("Jira did not report the app's account id");
  return me.accountId;
}

/** Grant Delete all attachments to the app's own account on `schemeId`. */
export async function grantAppAttachmentDelete({ schemeId, accountId }, forgeApi = api) {
  const res = await forgeApi.asApp().requestJira(route`/rest/api/3/permissionscheme/${schemeId}/permission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ holder: { type: 'user', parameter: accountId, value: accountId }, permission: 'DELETE_ALL_ATTACHMENTS' })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to grant the app Delete all attachments on scheme ${schemeId}: ${res.status} ${detail}`.trim());
  }
  return res.json().catch(() => ({}));
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
