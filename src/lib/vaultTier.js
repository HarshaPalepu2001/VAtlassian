import { STORAGE } from './vaultLocation.js';

/**
 * WHERE THIS SITE'S VAULT IS: Confluence, or the Forge Object Store.
 *
 * A customer with Confluence gets its evidence in a private Confluence space,
 * readable as pages by an auditor the site admin lets in. A Jira-only customer
 * has no Confluence to put it in, and gets the Forge Object Store instead —
 * the same guarantee (a copy the app hashed, that a rejection restores from),
 * still inside the Atlassian tenant.
 *
 * Decided once and remembered (va_config `vault:tier`):
 *   · a site vault already recorded            -> CONFLUENCE
 *   · Confluence answers                       -> CONFLUENCE (not remembered
 *     until the vault space exists: creating it can still fail, e.g. on a
 *     Confluence plan without space permissions, and each job then falls back)
 *   · Confluence refuses or is absent (4xx)    -> OBJECT_STORE, remembered
 *   · the request itself fails                 -> OBJECT_STORE for now, not
 *     remembered, so the next job asks again
 *   · Confluence is down (5xx, 429)            -> thrown: the queue retries
 *
 * CONFLUENCE IS NEVER DOWNGRADED by this. Once a site has a Confluence vault,
 * a failing upload falls back to the Object Store for that one file and says
 * so in the ledger; the site stays a Confluence site. "Re-detect" in the
 * admin console (usecases/vaultStatus.js) clears the remembered answer.
 */
export const TIER_CONFIG_KEY = 'vault:tier';

export async function resolveVaultTier(deps) {
  const cached = await deps.getConfig(TIER_CONFIG_KEY, null).catch(() => null);
  if (cached?.tier === STORAGE.CONFLUENCE || cached?.tier === STORAGE.OBJECT_STORE) return { ...cached, remembered: true };

  if (await deps.getVaultSite().catch(() => null)) return remember(deps, STORAGE.CONFLUENCE, 'VAULT_SPACE_EXISTS');

  let res;
  try {
    res = await deps.probeConfluence();
  } catch (error) {
    return { tier: STORAGE.OBJECT_STORE, reason: 'CONFLUENCE_UNREACHABLE', detail: String(error?.message ?? error), remembered: false };
  }
  const status = Number(res?.status ?? 0);
  if (res?.ok) return { tier: STORAGE.CONFLUENCE, reason: 'CONFLUENCE_AVAILABLE', remembered: false };
  if (status >= 500 || status === 429 || status === 0) {
    const error = new Error(`Confluence could not be reached to choose the vault (${status || 'no response'}).`);
    error.status = 503;
    throw error;
  }
  return remember(deps, STORAGE.OBJECT_STORE, `NO_CONFLUENCE_${status}`);
}

async function remember(deps, tier, reason) {
  const value = { tier, reason, decidedAt: deps.now() };
  try {
    await deps.setConfig(TIER_CONFIG_KEY, value, 'system', value.decidedAt);
    await deps.tryAppend({ actorAccountId: 'system', eventType: deps.EVENT.VAULT_TIER_DETECTED, payload: { tier, reason } });
  } catch (error) {
    // Asked again next time; the answer is still right for this job.
    console.error('vaultTier: could not remember the vault tier', error);
  }
  return { ...value, remembered: true };
}

/** The remembered tier only, never a probe: for paths that must not call Confluence. */
export async function rememberedVaultTier(deps) {
  const cached = await deps.getConfig(TIER_CONFIG_KEY, null).catch(() => null);
  return cached?.tier ?? null;
}

/** Production dependencies. */
export async function vaultTierDeps() {
  const [forge, config, store, vault, ledger] = await Promise.all([
    import('@forge/api'), import('../db/configStore.js'), import('../db/store.js'), import('../db/vaultStore.js'), import('./ledger.js')
  ]);
  return {
    getConfig: config.getConfig,
    setConfig: config.setConfig,
    getVaultSite: () => vault.getVaultSite(),
    probeConfluence: () => forge.default.asApp().requestConfluence(forge.route`/wiki/api/v2/spaces?limit=1`),
    tryAppend: store.tryAppend,
    EVENT: ledger.EVENT,
    now: Date.now
  };
}

/** Forget the remembered tier, so the next vault job decides again. */
export async function forgetVaultTier(query) {
  const rows = await query('DELETE FROM va_config WHERE cfg_key = ?', [TIER_CONFIG_KEY]);
  if (!rows?.result) throw rows?.error ?? new Error('Failed to forget the vault tier');
}
