import api, { route } from '@forge/api';
import { getVaultSpace, insertVaultSpace, markPermissionLocked } from '../db/vaultStore.js';
import { deriveSpaceKey, createSpace, restrictSpacePermissions } from './vaultConfluence.js';
import { getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants } from './vaultPermissions.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

async function defaultProjectKeyFor(projectId) {
  const res = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`);
  if (!res.ok) throw new Error(`Failed to read project ${projectId}: ${res.status}`);
  const project = await res.json();
  return project.key;
}

export async function ensureVaultSpace(projectId, deps = {}) {
  const d = {
    getVaultSpace, insertVaultSpace, deriveSpaceKey, createSpace, restrictSpacePermissions,
    projectKeyFor: defaultProjectKeyFor, tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const existing = await d.getVaultSpace(projectId);
  if (existing) return { created: false, spaceId: existing.space_id, spaceKey: existing.space_key };

  const projectKey = await d.projectKeyFor(projectId);
  const spaceKey = d.deriveSpaceKey(projectKey);
  const space = await d.createSpace({ spaceKey, name: `VAtlassian Vault — ${projectKey}` });
  const resolvedKey = space.key ?? spaceKey;
  await d.restrictSpacePermissions(resolvedKey);
  await d.insertVaultSpace({ projectId, spaceId: space.id, spaceKey: resolvedKey, createdBy: d.actorAccountId, now: d.now() });
  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.VAULT_SPACE_CREATED,
    payload: { projectId, spaceId: space.id, spaceKey: resolvedKey } });
  return { created: true, spaceId: space.id, spaceKey: resolvedKey };
}

export async function lockAttachmentDeletion(projectId, deps = {}) {
  const d = {
    getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants, markPermissionLocked,
    tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const scheme = await d.getProjectPermissionScheme(projectId);
  const grantIds = d.attachmentDeleteGrantIds(scheme);
  if (grantIds.length > 0) {
    await d.removeAttachmentDeleteGrants({ schemeId: scheme.id, grantIds });
  }
  await d.markPermissionLocked({ projectId, permissionSchemeId: String(scheme.id), now: d.now() });
  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_LOCKED,
    payload: { projectId, schemeId: scheme.id, schemeName: scheme.name, grantsRemoved: grantIds.length } });
  return { schemeId: scheme.id, grantsRemoved: grantIds.length };
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
