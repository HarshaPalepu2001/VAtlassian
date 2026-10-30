import {
  getVaultSpace, markPermissionLocked,
  markAppDeleteGranted, markAppDeleteChecked, ensureVaultProjectRow
} from '../db/vaultStore.js';
import { projectConfig } from '../db/configStore.js';
import { STORAGE } from './vaultLocation.js';
import {
  getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants, getProjectsUsingPermissionScheme,
  appJiraAccountId, hasAppDeleteGrant, grantAppAttachmentDelete
} from './vaultPermissions.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

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
 * Apply attachment-deletion lockdown only when the project opts in through
 * vault.lockAttachmentDeletion, which defaults to false. First preserve the
 * app's delete grant, then remove other delete grants from the scheme.
 *
 * Re-read grants every time so repeated lockdown removes re-added grants.
 * Record removed holders in ATTACHMENT_DELETE_LOCKED. Disabling lockdown does
 * not restore grants. A shared scheme also affects otherProjectKeys.
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
 * Maintain the Jira-side vault row, app delete grant and opt-in lockdown.
 * Return failures without throwing so vault provisioning cannot block callers.
 */
export async function provisionVault(projectId, deps = {}) {
  const d = { tryAppend, actorAccountId: 'system', getVaultSpace, projectConfig, ensureVaultProjectRow, now: Date.now, ...deps };
  const result = { appDelete: null, lockdown: null, lockdownEnabled: false, storage: STORAGE.OBJECT_STORE, errors: [] };
  const fail = async (step, eventType, error) => {
    console.error(`provisionVault: ${step} failed`, projectId, error);
    if (eventType) {
      await d.tryAppend({ actorAccountId: d.actorAccountId, eventType, payload: { projectId, error: String(error?.message ?? error) } });
    }
    result.errors.push({ step, error: String(error?.message ?? error) });
  };

  try {
    await d.ensureVaultProjectRow({ projectId, createdBy: d.actorAccountId, now: d.now() });
  } catch (error) {
    await fail('ensureVaultProjectRow', null, error);
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
