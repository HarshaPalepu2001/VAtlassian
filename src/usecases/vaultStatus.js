import { runAdmin } from './adminRuntime.js';
import { fieldScope } from './fieldsValidation.js';
import { STORAGE } from '../lib/vaultLocation.js';

/**
 * What the attachment vault and the attachment-delete lockdown are doing for
 * one project, for the Settings page's "Attachment protection" card.
 *
 * Read-only. The scheme is read live, so the card names the scheme the
 * lockdown would edit; which OTHER projects share it is only worked out when
 * asked (`checkSharing`), because that walks every project on the site.
 */
export async function getVaultStatus(req, overrides) {
  return runAdmin(req, async deps => {
    const projectId = Number(fieldScope({ projectId: req.payload?.projectId, issueTypeId: '*' }).projectId);
    const d = await vaultDeps(deps);
    const [config, space] = await Promise.all([d.projectConfig(projectId), d.getVaultSpace(projectId)]);

    let scheme = null;
    let schemeError = null;
    try {
      const read = await d.getProjectPermissionScheme(projectId);
      scheme = { id: read?.id ?? null, name: read?.name ?? null };
    } catch (error) {
      schemeError = String(error?.message ?? error);
    }
    let sharedWith = null;
    if (req.payload?.checkSharing === true && scheme?.id != null) {
      sharedWith = await d.getProjectsUsingPermissionScheme(scheme.id, projectId);
    }

    return {
      ok: true,
      projectId,
      vault: {
        storage: STORAGE.OBJECT_STORE
      },
      lockdown: {
        enabled: config?.vault?.lockAttachmentDeletion === true,
        lockedAt: space?.permission_locked_at == null ? null : Number(space.permission_locked_at),
        lockedSchemeId: space?.permission_scheme_id ?? null
      },
      appDelete: {
        grantedAt: space?.app_delete_granted_at == null ? null : Number(space.app_delete_granted_at),
        refusedAt: space?.app_delete_checked_at == null ? null : Number(space.app_delete_checked_at)
      },
      scheme,
      schemeError,
      sharedWith
    };
  }, overrides, 'fields');
}

async function vaultDeps(deps) {
  const need = ['getVaultSpace', 'getProjectPermissionScheme', 'getProjectsUsingPermissionScheme'];
  if (need.every(name => typeof deps[name] === 'function')) return deps;
  const [store, permissions] = await Promise.all([import('../db/vaultStore.js'), import('../lib/vaultPermissions.js')]);
  return {
    ...deps,
    getVaultSpace: deps.getVaultSpace ?? (id => store.getVaultSpace(id)),
    getProjectPermissionScheme: deps.getProjectPermissionScheme ?? (id => permissions.getProjectPermissionScheme(id)),
    getProjectsUsingPermissionScheme: deps.getProjectsUsingPermissionScheme
      ?? ((schemeId, exclude) => permissions.getProjectsUsingPermissionScheme(schemeId, exclude))
  };
}
