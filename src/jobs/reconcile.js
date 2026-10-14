import { collectTree, DETECTED_VIA } from '../lib/collect.js';
import { dueTreeRoots, recoverStaleLocks } from '../db/itemStateStore.js';
import { expireStale } from '../db/approvalStore.js';

/** Event gap-fill using the same aggregate collector as the issue triggers.
 * Enumerates ACTIVE tree roots, not every indexed descendant, so one sweep
 * pass runs the collector once per governed tree rather than once per node.
 * Bounded and least-recently-checked first; each bad item is isolated from
 * the rest.
 */
export async function sweep({ now = Date.now(), detectedVia = DETECTED_VIA.RECONCILE,
  batch = 40, due = dueTreeRoots, collector = collectTree, deadline = Infinity, clock = Date.now } = {}) {
  const started = Date.now();
  const items = await due(batch);
  let examined = 0;
  let withDrift = 0;
  let errors = 0;
  let deferred = 0;
  for (const item of items) {
    // A scheduled function is killed at its time limit, taking every job after
    // it down too. Trees not started now are the least recently checked next
    // time, so stopping early only defers them.
    if (clock() >= deadline) { deferred++; continue; }
    try {
      const result = await collector({rootIssueId:item.issue_id, rootIssueKey:item.issue_key, detectedVia, now});
      examined++;
      if (result.outcome === 'DRIFT_RECORDED' && result.inserted > 0) withDrift++;
      if (result.outcome === 'ERROR' || result.ok === false) errors++;
    } catch (error) {
      errors++;
      console.error(`reconcile: issue ${item.issue_id} failed`, error);
    }
  }
  return {ok:errors === 0, examined, withDrift, errors, deferred, elapsedMs:Date.now() - started};
}

export async function run(options = {}) {
  const result = await sweep(options);
  try {
    result.expiredApprovals = await expireStale(options.now ?? Date.now());
    result.recoveredLocks = await recoverStaleLocks(options.now ?? Date.now());
  } catch (error) {
    result.ok = false;
    result.housekeepingError = String(error?.message ?? error);
  }
  return result;
}
export const handler = run;
