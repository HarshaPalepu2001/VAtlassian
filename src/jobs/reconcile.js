import { collect, DETECTED_VIA } from '../lib/collect.js';
import { dueForReconcile, recoverStaleLocks } from '../db/itemStateStore.js';
import { expireStale } from '../db/approvalStore.js';

/** Event gap-fill using the same collector as the issue trigger. Bounded and
 * least-recently-checked first; each bad item is isolated from the rest.
 */
export async function sweep({ now = Date.now(), detectedVia = DETECTED_VIA.RECONCILE,
  batch = 40, due = dueForReconcile, collector = collect } = {}) {
  const started = Date.now();
  const items = await due(batch);
  let examined = 0;
  let withDrift = 0;
  let errors = 0;
  for (const item of items) {
    try {
      const result = await collector({issueId:item.issue_id, issueKey:item.issue_key, detectedVia, now});
      examined++;
      if (result.outcome === 'DRIFT_RECORDED' && result.inserted > 0) withDrift++;
      if (result.outcome === 'ERROR' || result.ok === false) errors++;
    } catch (error) {
      errors++;
      console.error(`reconcile: issue ${item.issue_id} failed`, error);
    }
  }
  return {ok:errors === 0, examined, withDrift, errors, elapsedMs:Date.now() - started};
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
