/**
 * THE VAULT BACKFILL — finds projects that need a vault and provisions them.
 *
 * A vault is otherwise provisioned only when an administrator SAVES a
 * baseline-capturing rule (usecases/transitions.js). That misses every rule
 * saved before vaulting existed, and leaves a failed attempt waiting for a
 * re-save nobody knows to make. This job closes both: each hour it asks which
 * projects have an ACTIVE rule that captures a baseline but no finished vault,
 * and provisions a bounded batch. provisionVault never throws and is idempotent,
 * so a project that keeps failing is simply retried next hour, with each failure
 * in the ledger.
 *
 * Projects whose administrator turned the attachment-delete lockdown on and
 * that are not yet locked are provisioned too; provisionVault reads the
 * setting itself, so a project with it off never has its scheme touched.
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
