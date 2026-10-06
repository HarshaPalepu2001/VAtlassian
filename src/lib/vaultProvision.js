import api, { route } from '@forge/api';
import {
  getVaultSite, insertVaultSite, getVaultSpace, insertVaultSpace, setVaultProjectPage, markPermissionLocked,
  markAppDeleteGranted, markAppDeleteChecked, ensureVaultProjectRow
} from '../db/vaultStore.js';
import { projectConfig, getConfig } from '../db/configStore.js';
import { STORAGE } from './vaultLocation.js';
import { TIER_CONFIG_KEY } from './vaultTier.js';
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
 * Makes sure the app itself may delete attachments on the project: a rejection
 * deletes every file added after approval (lib/restore/attachments.js), and
 * the app must be able to whether or not the project's lockdown is on. The
 * app usually holds it already, through the add-ons project role
 * (lib/vaultPermissions.js); when it does not, the grant is added and recorded.
 *
 * A grant Jira REFUSES is audited, and the refusal's time recorded, so the
 * hourly backfill asks again a day later rather than every hour.
 */
export async function ensureAppDeleteGrant(projectId, deps = {}) {
  const d = {
    getVaultSpace, getProjectPermissionScheme, appJiraAccountId, hasAppDeleteGrant, grantAppAttachmentDelete,
    markAppDeleteGranted, markAppDeleteChecked, tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const space = deps.space ?? await d.getVaultSpace(projectId);
  if (!space) throw new Error(`Cannot check the app's attachment-delete grant: vault not provisioned for project ${projectId}`);
  if (space.app_delete_granted_at != null && !deps.scheme) return { alreadyGranted: true, appGrantAdded: false };

  const scheme = deps.scheme ?? await d.getProjectPermissionScheme(projectId);
  const appAccount = deps.appAccount ?? await d.appJiraAccountId();
  let appGrantAdded = false;
  if (!d.hasAppDeleteGrant(scheme, appAccount)) {
    try {
      await d.grantAppAttachmentDelete({ schemeId: scheme.id, accountId: appAccount });
      appGrantAdded = true;
    } catch (error) {
      await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_GRANT_FAILED,
        payload: { projectId, schemeId: scheme.id, error: String(error?.message ?? error) } });
      await d.markAppDeleteChecked({ projectId, now: d.now() }).catch(() => {});
      throw error;
    }
  }
  await d.markAppDeleteGranted({ projectId, now: d.now() });
  if (appGrantAdded) {
    await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_GRANTED_TO_APP,
      payload: { projectId, schemeId: scheme.id, schemeName: scheme.name, appAccountId: appAccount } });
  }
  return { alreadyGranted: false, appGrantAdded, scheme, appAccount };
}

/** Who held a removed grant, in words a Jira administrator can re-add from. */
function grantHolder(grant) {
  const h = grant?.holder ?? {};
  return { type: h.type ?? null, value: h.value ?? h.parameter ?? null,
    name: h.projectRole?.name ?? h.group?.name ?? h.user?.displayName ?? null };
}

/**
 * THE LOCKDOWN — only when the project's administrator turned it on
 * (config `vault.lockAttachmentDeletion`, off by default; see provisionVault).
 * Removes every attachment-delete grant on the project's scheme except those
 * that let the app delete, whose own grant it makes sure of FIRST, so there is
 * no moment at which the app has lost it.
 *
 * It always reads the scheme and removes whatever is there: a project locked
 * before, whose grants a person re-added, is locked again. Who held each
 * removed grant is in the ATTACHMENT_DELETE_LOCKED entry, because turning the
 * lockdown off does NOT put them back and the scheme may be shared with other
 * projects (otherProjectKeys), which lose them too.
 */
export async function lockAttachmentDeletion(projectId, deps = {}) {
  const d = {
    getVaultSpace, getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants, markPermissionLocked,
    getProjectsUsingPermissionScheme, appJiraAccountId, tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const space = await d.getVaultSpace(projectId);
  if (!space) {
    throw new Error(`Cannot lock permissions: vault space not provisioned for project ${projectId}`);
  }
  const wasLocked = space.permission_locked_at != null;
  const scheme = await d.getProjectPermissionScheme(projectId);
  const appAccount = await d.appJiraAccountId();
  const { appGrantAdded } = await ensureAppDeleteGrant(projectId, { ...deps, space, scheme, appAccount });

  const grantIds = d.attachmentDeleteGrantIds(scheme, { keepAccountId: appAccount });
  const removing = new Set(grantIds.map(String));
  const removedGrants = (scheme?.permissions ?? []).filter(p => removing.has(String(p.id)))
    .map(p => ({ id: p.id, permission: p.permission, holder: grantHolder(p) }));

  let otherProjectKeys = [];
  if (grantIds.length > 0) {
    await d.removeAttachmentDeleteGrants({ schemeId: scheme.id, grantIds });
    otherProjectKeys = await d.getProjectsUsingPermissionScheme(scheme.id, projectId);
  }

  await d.markPermissionLocked({ projectId, permissionSchemeId: String(scheme.id), now: d.now() });

  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_LOCKED,
    payload: { projectId, schemeId: scheme.id, schemeName: scheme.name, grantsRemoved: grantIds.length, removedGrants,
      otherProjectKeys, appKeepsDelete: true, ...(wasLocked ? { relocked: true } : {}) } });
  return { schemeId: scheme.id, grantsRemoved: grantIds.length, removedGrants, otherProjectKeys, appGrantAdded,
    ...(wasLocked ? { relocked: true } : {}) };
}

async function lockdownWanted(projectId, d) {
  if (typeof d.lockdownEnabled === 'boolean') return d.lockdownEnabled;
  const config = await d.projectConfig(projectId);
  return config?.vault?.lockAttachmentDeletion === true;
}

/**
 * Never throws — vaulting is defense-in-depth and must not block the caller.
 *
 * Three steps, each on its own: the vault page; the app's own right to delete
 * attachments, always; and the lockdown, only when the project has it on and
 * it is not already applied (`forceLock`, from turning the setting on, looks
 * at the scheme again regardless). A config that cannot be read counts as
 * OFF: the one thing this must never do by mistake is edit a permission scheme.
 *
 * On a site whose vault is the Forge Object Store (lib/vaultTier.js) there is
 * no Confluence page to make; the project still gets its row, which the grant
 * and the lockdown are recorded on. The same row is made when a Confluence
 * vault cannot be made yet, so the grant never waits on Confluence.
 */
export async function provisionVault(projectId, deps = {}) {
  const d = { tryAppend, actorAccountId: 'system', getVaultSpace, projectConfig, ensureVaultProjectRow, now: Date.now,
    vaultTier: async () => (await getConfig(TIER_CONFIG_KEY, null))?.tier ?? null, ...deps };
  const result = { space: null, appDelete: null, lockdown: null, lockdownEnabled: false, storage: null, errors: [] };
  const fail = async (step, eventType, error) => {
    console.error(`provisionVault: ${step} failed`, projectId, error);
    if (eventType) {
      await d.tryAppend({ actorAccountId: d.actorAccountId, eventType, payload: { projectId, error: String(error?.message ?? error) } });
    }
    result.errors.push({ step, error: String(error?.message ?? error) });
  };

  result.storage = await d.vaultTier().catch(() => null);
  if (result.storage !== STORAGE.OBJECT_STORE) {
    try {
      result.space = await ensureVaultSpace(projectId, deps);
    } catch (error) {
      await fail('ensureVaultSpace', EVENT.VAULT_SPACE_CREATE_FAILED, error);
    }
  }
  if (!result.space) {
    try {
      await d.ensureVaultProjectRow({ projectId, createdBy: d.actorAccountId, now: d.now() });
    } catch (error) {
      await fail('ensureVaultProjectRow', null, error);
    }
  }

  try {
    result.appDelete = await ensureAppDeleteGrant(projectId, deps);
  } catch (error) {
    // A refusal was audited as ATTACHMENT_DELETE_GRANT_FAILED where it happened.
    await fail('ensureAppDeleteGrant', null, error);
  }

  try {
    result.lockdownEnabled = await lockdownWanted(projectId, d);
  } catch (error) {
    await fail('readLockdownSetting', null, error);
  }
  if (result.lockdownEnabled) {
    try {
      const space = await d.getVaultSpace(projectId);
      if (space?.permission_locked_at != null && !deps.forceLock) {
        result.lockdown = { alreadyLocked: true, schemeId: space.permission_scheme_id ?? null, grantsRemoved: 0, otherProjectKeys: [] };
      } else {
        result.lockdown = await lockAttachmentDeletion(projectId, deps);
      }
    } catch (error) {
      await fail('lockAttachmentDeletion', EVENT.ATTACHMENT_DELETE_LOCK_FAILED, error);
    }
  }

  return result;
}
