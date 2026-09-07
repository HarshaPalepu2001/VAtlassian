import api from '@forge/api';
import { executeRestore } from '../lib/restore/executor.js';
import { verifyRestore, describeResult } from '../lib/restore/verifier.js';
import { tally } from '../lib/restore/outcome.js';
import { planRestore } from '../lib/restore/planner.js';
import { startRestore, finishRestore } from '../db/restoreStore.js';
import { markDecided } from '../db/driftStore.js';
import { release } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';

/** Restore success is derived only from the post-write verification read. */
export async function performRestore({ prepared, actor, approval }) {
  const { issue, issueId, projectId, baseline, fields, baselineValues, editmeta, diff, config } = prepared;
  const plan = planRestore({ diff, baselineValues, controlledFields: fields, editmeta });
  const restoreId = await startRestore({ approvalId: approval.approval_id, issueId, projectId,
    baselineId: baseline.baseline_id, baselineVersion: baseline.version,
    actorAccountId: actor.accountId, now: Date.now() });
  const executed = await executeRestore({ api, plan, issueKey: issue.key, issueId,
    controlledFields: fields, ...config.restore });
  const { detail, unmatched } = await verifyRestore({ api, issueKey: issue.key, controlledFields: fields,
    baselineDigests: typeof baseline.field_digests === 'string' ? JSON.parse(baseline.field_digests) : baseline.field_digests,
    detail: executed.detail });
  const { counters, state } = tally(detail, unmatched);
  await finishRestore({ restoreId, now: Date.now(), counters, state, detail });
  if (state === 'COMPLETE') await markDecided({ issueId, baselineVersion: baseline.version, approvalId: approval.approval_id });
  await release({ issueId, state: state === 'COMPLETE' ? 'BASELINED' : 'ERROR', now: Date.now(),
    counters: state === 'COMPLETE' ? { driftCount: 0, driftedFieldCount: 0, maxMateriality: null } : {
      driftCount: prepared.driftCount, driftedFieldCount: diff.materialFieldCount, maxMateriality: diff.maxMateriality } });
  await tryAppend({ actorAccountId: actor.accountId, issueId, approvalId: approval.approval_id,
    eventType: state === 'COMPLETE' ? EVENT.RESTORE_COMPLETED : EVENT.RESTORE_PARTIAL,
    payload: { restoreId: restoreId.toString('base64'), state, counters,
      unmatched: unmatched.map((u) => u.fieldId) } });
  return { success: state === 'COMPLETE', restoreId, state, counters, detail, unmatched,
    message: describeResult({ counters, state }) };
}
