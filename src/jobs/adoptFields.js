import { gatedScopes } from '../db/configStore.js';
import { syncTrackedFields, readScopeFields } from '../lib/trackedFields.js';

/**
 * THE BACKFILL: a gated project that tracks nothing is a bug, not a choice.
 *
 * ─── WHY A JOB AND NOT JUST THE SAVE PATH ────────────────────────────────────
 *
 * Seeding on gate save fixes every project configured from now on. It does
 * nothing for the ones already out there — including the project this bug was
 * found on, which has a gate, has approved baselines, and tracks zero fields.
 * Those installs will never call admin:saveGate again; nobody re-saves a gate
 * that looks configured. Without this job the fix ships and changes nothing on
 * any tenant that already had the problem.
 *
 * It also covers the ongoing case. A tenant adds a custom field in March; every
 * gated project should start watching it without an administrator noticing it
 * exists and going to find the button.
 *
 * ─── WHY IT CANNOT RUN AWAY WITH THE CONFIGURATION ───────────────────────────
 *
 * syncTrackedFields only ever inserts rows for fields that have NO row. It
 * never updates, never re-activates, never deletes. So an administrator's
 * exclusion is permanent against this job, and a project that has been synced
 * once costs one indexed COUNT per hour thereafter.
 *
 * The catalogue is read ONCE for the whole sweep and passed down, rather than
 * per scope: /rest/api/3/field is install-wide, and a tenant with forty gated
 * projects should not make forty identical REST calls every hour.
 */
export async function run() {
  const started = Date.now();
  const scopes = await gatedScopes();
  if (scopes.length === 0) return { scopes: 0, synced: 0, added: 0, elapsedMs: Date.now() - started };

  let synced = 0;
  let added = 0;
  const failures = [];

  for (const scope of scopes) {
    try {
      const jiraFields = await readScopeFields(scope.projectId, scope.issueTypeId);
      if (!jiraFields || jiraFields.length === 0) continue;

      const res = await syncTrackedFields({
        projectId: scope.projectId,
        issueTypeId: scope.issueTypeId,
        // Attributed to the job, not to whichever admin happened to configure
        // the gate. The ledger should not say a person widened the tracked set
        // when a scheduled trigger did.
        accountId: 'system:adopt-fields',
        jiraFields
      });
      if (res.ok) {
        synced += 1;
        added += res.added;
      } else {
        failures.push({ ...scope, error: res.error });
      }
    } catch (e) {
      // One bad project does not stop the sweep. The next scope may be the one
      // that matters, and this returns to a log nobody reads until something is
      // wrong — so it records which scope, not just that something failed.
      console.error('adoptFields: scope failed', scope, e);
      failures.push({ ...scope, error: String(e?.message ?? e) });
    }
  }

  return {
    scopes: scopes.length,
    synced,
    added,
    failed: failures.length,
    failures: failures.slice(0, 10),
    elapsedMs: Date.now() - started
  };
}
