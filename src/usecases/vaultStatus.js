import { runAdmin } from './adminRuntime.js';
import { fieldScope } from './fieldsValidation.js';
import { TIER_CONFIG_KEY, forgetVaultTier } from '../lib/vaultTier.js';

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
    const [config, space, site, tier] = await Promise.all([d.projectConfig(projectId), d.getVaultSpace(projectId), d.getVaultSite(),
      d.getConfig(TIER_CONFIG_KEY, null)]);

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
        // Where new copies go (lib/vaultTier.js): remembered, or inferred from
        // a vault space that exists; null until the first vault job decides.
        storage: tier?.tier ?? (site ? 'CONFLUENCE' : null),
        storageReason: tier?.reason ?? null,
        storageChosen: tier?.reason === 'CHOSEN_BY_ADMIN',
        siteSpaceKey: site?.space_key ?? null,
        projectPageId: space?.project_page_id ?? null
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

/**
 * Where this SITE's new vault copies go, for the Settings page's "Vault
 * storage" card. Site-wide, so it needs no project and is shown at every scope.
 */
export async function getVaultTier(req, overrides) {
  return runAdmin(req, async deps => {
    const d = await vaultDeps(deps);
    const [site, tier] = await Promise.all([d.getVaultSite(), d.getConfig(TIER_CONFIG_KEY, null)]);
    return {
      ok: true,
      storage: tier?.tier ?? (site ? 'CONFLUENCE' : null),
      storageChosen: tier?.reason === 'CHOSEN_BY_ADMIN',
      siteSpaceKey: site?.space_key ?? null
    };
  }, overrides, 'fields');
}

/**
 * Where this SITE's vault copies go: 'AUTO' forgets the remembered answer so
 * the next vault job detects it again; CONFLUENCE or OBJECT_STORE pins it — a
 * site with Confluence may still keep evidence out of it. Existing copies stay
 * where they are; each row says where, and a restore reads from there.
 */
export async function setVaultTier(req, overrides) {
  return runAdmin(req, async deps => {
    const choice = req.payload?.tier;
    if (!['AUTO', 'CONFLUENCE', 'OBJECT_STORE'].includes(choice)) throw new Error('Vault storage must be AUTO, CONFLUENCE or OBJECT_STORE.');
    const now = Date.now();
    await deps.tryAppend({ actorAccountId: req.context.accountId, eventType: deps.EVENT.CONFIG_CHANGED,
      payload: { scope: TIER_CONFIG_KEY, action: 'SAVE_REQUESTED', tier: choice } });
    if (choice === 'AUTO') await forgetVaultTier((sql, params) => deps.executeQuery(sql, params));
    else await deps.setConfig(TIER_CONFIG_KEY, { tier: choice, reason: 'CHOSEN_BY_ADMIN', decidedAt: now }, req.context.accountId, now);
    return { ok: true, note: choice === 'AUTO'
      ? 'Vault storage will be detected again by the next vault job.'
      : `New vault copies go to ${choice === 'OBJECT_STORE' ? 'the Forge Object Store' : 'Confluence'}. Existing copies stay where they are.` };
  }, overrides, 'fields');
}

async function vaultDeps(deps) {
  const need = ['getVaultSpace', 'getVaultSite', 'getProjectPermissionScheme', 'getProjectsUsingPermissionScheme'];
  if (need.every(name => typeof deps[name] === 'function')) return deps;
  const [store, permissions] = await Promise.all([import('../db/vaultStore.js'), import('../lib/vaultPermissions.js')]);
  return {
    ...deps,
    getVaultSpace: deps.getVaultSpace ?? (id => store.getVaultSpace(id)),
    getVaultSite: deps.getVaultSite ?? (() => store.getVaultSite()),
    getProjectPermissionScheme: deps.getProjectPermissionScheme ?? (id => permissions.getProjectPermissionScheme(id)),
    getProjectsUsingPermissionScheme: deps.getProjectsUsingPermissionScheme
      ?? ((schemeId, exclude) => permissions.getProjectsUsingPermissionScheme(schemeId, exclude))
  };
}
