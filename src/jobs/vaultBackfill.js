/**
 * Provision missing vaults for baseline-capturing projects each hour.
 *
 * Saving a baseline-capturing rule in usecases/transitions.js normally
 * provisions its vault. This job also covers older rules and failed attempts
 * that have not been saved again. It processes a bounded batch of projects
 * with an ACTIVE capturing rule and no completed vault. provisionVault is
 * idempotent and never throws; failures are audited and retried next hour.
 *
 * Also include projects with attachment-delete lockdown enabled but not yet
 * applied. provisionVault reads that setting itself and leaves permission
 * schemes unchanged when lockdown is off.
 */
import { projectsNeedingVault, projectsNeedingLockdown } from '../db/vaultStore.js';
import { projectsWantingLockdown } from '../db/configStore.js';
import { provisionVault } from '../lib/vaultProvision.js';

const BATCH = 10;

export async function run(deps = {}) {
  const d = { projectsNeedingVault, projectsWantingLockdown, projectsNeedingLockdown, provisionVault, ...deps };
  const unfinished = await d.projectsNeedingVault({ limit: BATCH });
  const wanting = await d.projectsWantingLockdown();
  const unlocked = wanting.length ? await d.projectsNeedingLockdown(wanting) : [];
  const projectIds = [...new Set([...unfinished, ...unlocked])].slice(0, BATCH);
  let provisioned = 0;
  let failed = 0;
  for (const projectId of projectIds) {
    const result = await d.provisionVault(projectId);
    if (result?.errors?.length) failed += 1;
    else provisioned += 1;
  }
  return { ok: true, checked: projectIds.length, provisioned, failed };
}
