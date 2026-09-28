import api, { route } from '@forge/api';
import {
  getVaultSite, insertVaultSite, getVaultSpace, insertVaultSpace, setVaultProjectPage, markPermissionLocked,
  markAppDeleteGranted
} from '../db/vaultStore.js';
import {
  SITE_VAULT_KEY, SITE_VAULT_NAME, appAccountId, createSpace, findPageByTitle, createProjectPage
} from './vaultConfluence.js';
import {
  getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants, getProjectsUsingPermissionScheme,
  appJiraAccountId, hasAppDeleteGrant, grantAppAttachmentDelete
} from './vaultPermissions.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

async function defaultProjectFor(projectId) {
  const res = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`);
  if (!res.ok) throw new Error(`Failed to read project ${projectId}: ${res.status}`);
  const project = await res.json();
  return { key: project.key, name: project.name };
}

/**
 * THE site vault: one private space, created on first need and recorded in
 * va_vault_site. Two first-time provisions can race here; the loser's insert
 * fails on the primary key and it re-reads the winner's row, and the space
 * itself is adopted rather than duplicated (createSpace's key check).
 */
async function ensureSiteVault(d) {
  const existing = await d.getVaultSite();
  if (existing) return existing;
  const space = await d.createSpace({ spaceKey: SITE_VAULT_KEY, name: SITE_VAULT_NAME, ownerAccountId: await d.appAccountId() });
  const row = { space_id: String(space.id), space_key: space.key ?? SITE_VAULT_KEY, homepage_id: space.homepageId == null ? null : String(space.homepageId) };
  try {
    await d.insertVaultSite({ spaceId: row.space_id, spaceKey: row.space_key, homepageId: row.homepage_id,
      createdBy: d.actorAccountId, now: d.now() });
  } catch (error) {
    const winner = await d.getVaultSite();
    if (winner) return winner;
    throw error;
  }
  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.VAULT_SPACE_CREATED,
    payload: { spaceId: row.space_id, spaceKey: row.space_key, adopted: space.adopted === true, private: true } });
  return row;
}

/**
 * Makes sure `projectId` has its page in the site vault, and returns where
 * that project's issue pages go. Idempotent: a finished project costs one
 * read, and a page orphaned by an earlier failed attempt is found by title
 * rather than created twice.
 */
export async function ensureVaultSpace(projectId, deps = {}) {
  const d = {
    getVaultSite, insertVaultSite, getVaultSpace, insertVaultSpace, setVaultProjectPage,
    appAccountId, createSpace, findPageByTitle, createProjectPage,
    projectFor: defaultProjectFor, tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const existing = await d.getVaultSpace(projectId);
  if (existing?.project_page_id) {
    return { spaceId: existing.space_id, spaceKey: existing.space_key, projectPageId: existing.project_page_id };
  }

  const site = await ensureSiteVault(d);
  const project = await d.projectFor(projectId);
  const title = `${project.key} — ${project.name}`;
  const page = await d.findPageByTitle({ spaceId: site.space_id, title })
    ?? await d.createProjectPage({ spaceId: site.space_id, parentId: site.homepage_id, title });
  const projectPageId = String(page.id);

  if (existing) {
    await d.setVaultProjectPage({ projectId, spaceId: site.space_id, spaceKey: site.space_key, projectPageId });
  } else {
    await d.insertVaultSpace({ projectId, spaceId: site.space_id, spaceKey: site.space_key, projectPageId,
      createdBy: d.actorAccountId, now: d.now() });
  }
  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.VAULT_PROJECT_ADDED,
    payload: { projectId, projectKey: project.key, spaceId: site.space_id, projectPageId } });
  return { spaceId: site.space_id, spaceKey: site.space_key, projectPageId };
}

/**
 * Removes every attachment-delete grant on the project's scheme except the
 * app's own, which it makes sure exists: a rejection deletes files added after
 * approval, and on a locked project nothing else may. The app's grant is added
 * FIRST, so there is no moment at which the lockdown has removed it.
 *
 * A PROJECT "LOCKED" BEFORE 2026-09-24 WAS NOT. The scheme used to be read
 * without `expand=permissions`, and Jira returns no grants without it, so the
 * lockdown recorded the project as locked having removed nothing. Such a
 * project (permission_locked_at set, app_delete_granted_at not) is finished
 * here: the app's grant is added and the other delete grants removed, audited
 * as a repair. The hourly backfill picks every one of them up.
 */
export async function lockAttachmentDeletion(projectId, deps = {}) {
  const d = {
    getVaultSpace, getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants, markPermissionLocked, getProjectsUsingPermissionScheme,
    appJiraAccountId, hasAppDeleteGrant, grantAppAttachmentDelete, markAppDeleteGranted,
    tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const space = await d.getVaultSpace(projectId);
  if (!space) {
    throw new Error(`Cannot lock permissions: vault space not provisioned for project ${projectId}`);
  }
  const locked = space.permission_locked_at != null;
  const granted = space.app_delete_granted_at != null;
  // Already done. The hourly backfill re-runs provisioning, and finding the
  // other projects on a shared scheme walks every project on the site.
  if (locked && granted) {
    return { alreadyLocked: true, schemeId: space.permission_scheme_id ?? null, grantsRemoved: 0, otherProjectKeys: [] };
  }

  const scheme = await d.getProjectPermissionScheme(projectId);
  const appAccount = await d.appJiraAccountId();
  let appGrantAdded = false;
  if (!d.hasAppDeleteGrant(scheme, appAccount)) {
    try {
      await d.grantAppAttachmentDelete({ schemeId: scheme.id, accountId: appAccount });
      appGrantAdded = true;
    } catch (error) {
      await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_GRANT_FAILED,
        payload: { projectId, schemeId: scheme.id, error: String(error?.message ?? error) } });
      throw error;
    }
  }
  await d.markAppDeleteGranted({ projectId, now: d.now() });
  if (appGrantAdded) {
    await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_GRANTED_TO_APP,
      payload: { projectId, schemeId: scheme.id, schemeName: scheme.name, appAccountId: appAccount } });
  }
  const grantIds = d.attachmentDeleteGrantIds(scheme, { keepAccountId: appAccount });
  
  let otherProjectKeys = [];
  if (grantIds.length > 0) {
    await d.removeAttachmentDeleteGrants({ schemeId: scheme.id, grantIds });
    otherProjectKeys = await d.getProjectsUsingPermissionScheme(scheme.id, projectId);
  }
  
  if (!locked) await d.markPermissionLocked({ projectId, permissionSchemeId: String(scheme.id), now: d.now() });

  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_LOCKED,
    payload: { projectId, schemeId: scheme.id, schemeName: scheme.name, grantsRemoved: grantIds.length, otherProjectKeys,
      appKeepsDelete: true, ...(locked ? { repaired: true } : {}) } });
  return { schemeId: scheme.id, grantsRemoved: grantIds.length, otherProjectKeys, appGrantAdded,
    ...(locked ? { alreadyLocked: true, repaired: true } : {}) };
}

/** Never throws — vaulting is defense-in-depth and must not block the caller. */
export async function provisionVault(projectId, deps = {}) {
  const d = { tryAppend, actorAccountId: 'system', ...deps };
  const result = { space: null, lockdown: null, errors: [] };

  try {
    result.space = await ensureVaultSpace(projectId, deps);
  } catch (error) {
    console.error('provisionVault: ensureVaultSpace failed', projectId, error);
    await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.VAULT_SPACE_CREATE_FAILED,
      payload: { projectId, error: String(error?.message ?? error) } });
    result.errors.push({ step: 'ensureVaultSpace', error: String(error?.message ?? error) });
  }

  try {
    result.lockdown = await lockAttachmentDeletion(projectId, deps);
  } catch (error) {
    console.error('provisionVault: lockAttachmentDeletion failed', projectId, error);
    await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_LOCK_FAILED,
      payload: { projectId, error: String(error?.message ?? error) } });
    result.errors.push({ step: 'lockAttachmentDeletion', error: String(error?.message ?? error) });
  }

  return result;
}
