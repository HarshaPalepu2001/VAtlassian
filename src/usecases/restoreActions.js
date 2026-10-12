import api, { route } from '@forge/api';
import { FailClosed } from '../lib/errors.js';
import { executeRestore } from '../lib/restore/executor.js';
import { verifyRestore, describeResult } from '../lib/restore/verifier.js';
import { tally } from '../lib/restore/outcome.js';
import { stateAfter, undecidedCounters } from '../lib/decision.js';
import { planRestore } from '../lib/restore/planner.js';
import { startRestore, finishRestore } from '../db/restoreStore.js';
import { markDecided } from '../db/driftStore.js';
import { release } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';

import { executeTreeRestore } from '../lib/tree/restoreExecutor.js';
import { verifyTreeRestore, explainRefusals } from '../lib/tree/restoreVerifier.js';
import { claimRestoreAction, finishRestoreAction, recordReplacement, readReplacements, readRestoreActions } from '../db/restoreTreeStore.js';
import { createTreeReader } from '../lib/tree/jira.js';
import { readStableTree } from '../lib/tree/stableRead.js';
import { createRestoreAdapters } from '../lib/tree/restoreAdapters.js';
import { planTreeRestore } from '../lib/tree/restorePlan.js';
import { enqueueRestore } from '../lib/restore/queue.js';
import { approvedLinksResolver } from '../db/approvedLinks.js';
import * as restoreStore from '../db/restoreStore.js';

function asBase64(value) {
  return Buffer.isBuffer(value) ? value.toString('base64') : String(value);
}

/** Persist the full deterministic plan before asking Forge to deliver work. */
/**
 * `mixed` is a per-field decision (lib/approval/mixedDecision.js): its restore
 * plan already covers only the rejected fields, and the overlay that turns the
 * baseline into the verification target is frozen into the restore's detail so
 * the worker verifies the state the reviewer SAW, not whatever is live later.
 * Only digests are frozen: no field value is added to the restore record.
 */
export async function queueRestore({ prepared, actor, approval, mixed = null, stores = restoreStore,
  enqueue = enqueueRestore, now = Date.now() }) {
  if (!prepared?.baselineTree || !prepared?.currentTree) {
    const error = new Error('Recursive restore requires the reviewed baseline and current tree snapshots.');
    error.reason = 'CAPTURE_INCOMPLETE';
    throw error;
  }
  const plan = mixed ? mixed.restore : planTreeRestore({ baselineTree: prepared.baselineTree, currentTree: prepared.currentTree,
    controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor });
  const restoreId = await stores.startRestore({
    approvalId: approval.approval_id, issueId: prepared.issueId, projectId: prepared.projectId,
    baselineId: prepared.baseline.baseline_id, baselineVersion: prepared.baseline.version,
    actorAccountId: actor.accountId, now, state: 'QUEUING', totalSteps: plan.steps.length,
    actionPlan: plan.steps,
    detail: { actionPlan: plan.steps, ...(mixed ? { mixed: { overlay: mixed.overlay, mapHash: mixed.mapHash,
      approved: mixed.approvedIds, rejected: mixed.rejectedIds } } : {}) },
    candidateDigests: prepared.digests ?? {}
  });
  const body = { restoreId: asBase64(restoreId), issueId: Number(prepared.issueId),
    baselineId: asBase64(prepared.baseline.baseline_id), baselineVersion: Number(prepared.baseline.version) };
  try {
    const pushed = await enqueue(body);
    if (!pushed?.jobId) throw new Error('Forge did not return a restore job id');
    await stores.markRestoreQueued({ restoreId, jobId: pushed.jobId, now, totalSteps: plan.steps.length });
    return { success: false, state: 'RESTORING', restoreId, jobId: pushed.jobId,
      progress: { totalSteps: plan.steps.length, completedSteps: 0, remainingSteps: plan.steps.length } };
  } catch (error) {
    await stores.markRestoreQueueFailure({ restoreId, error: String(error?.message ?? error), now }).catch(failure =>
      console.error('restore: could not persist queue failure', failure));
    // Nothing is running, so the reject's RESTORING lock is let go: left in
    // place, the gate would call every transition "restore in progress" until
    // the lease ran out. ERROR is what lib/decision.js calls a restore that
    // could not run; Retry resumes it from there.
    const counters = undecidedCounters(prepared.reviewDiff ?? prepared.diff);
    await (stores.release ?? release)({ issueId: prepared.issueId, state: 'ERROR', now,
      counters: { ...counters, driftCount: prepared.driftCount ?? counters.driftCount } })
      .catch(failure => console.error('restore: could not release the lock after a queue failure', failure));
    return { success: false, state: 'QUEUING_FAILED', restoreId,
      progress: { totalSteps: plan.steps.length, completedSteps: 0, remainingSteps: plan.steps.length },
      error: String(error?.message ?? error) };
  }
}


/** Restore success is derived only from the post-write verification read. */
export async function performRestore({ prepared, actor, approval }) {
  const forgeApi = api?.default?.asUser ? api.default : (api?.asUser ? api : api?.default ?? api);
  const { issue, issueId, projectId, baseline, fields, baselineValues, editmeta, restoreEditmeta, diff, config } = prepared;
  const isTree = Boolean(baseline?.tree_hash);
  const baselineTree = isTree ? prepared.baselineTree : null;
  const currentTree = isTree ? prepared.currentTree : null;
  if (isTree && config?.restore?.queue !== false) {
    return queueRestore({ prepared, actor, approval });
  }
  if (isTree && (!baselineTree || !currentTree)) {
    const error = new Error('Recursive restore requires the reviewed baseline and current tree snapshots.');
    error.reason = 'CAPTURE_INCOMPLETE';
    throw error;
  }
  const plan = isTree ? null
    : planRestore({ diff, baselineValues, controlledFields: fields, editmeta: restoreEditmeta ?? editmeta });

  const restoreId = await startRestore({ approvalId: approval.approval_id, issueId, projectId,
    baselineId: baseline.baseline_id, baselineVersion: baseline.version,
    actorAccountId: actor.accountId, now: Date.now(),
    // The rejected candidate, frozen before anything is written back. Without
    // this the restore erases the only record of what was rejected.
    candidateDigests: prepared.digests ?? {} });

  let detail = [];
  let unmatched = [];
  let counters = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, irreversible: 0 };
  let state = 'FAILED';

  try {
    if (isTree) {
      const treeReader = createTreeReader({ api: forgeApi, route });
      const jiraAdapters = createRestoreAdapters({ api: forgeApi, route,
        actorAccountId: actor.accountId, approvalId: approval.approval_id,
        approvedLinksOf: approvedLinksResolver({ baselineTree }) });
      const adapters = {
        claimRestoreAction,
        finishRestoreAction,
        recordReplacement,
        readReplacements,
        readRestoreActions,
        ...jiraAdapters,
        appendLedger: async (eventType, payload) => {
          await tryAppend({ actorAccountId: actor.accountId, issueId, approvalId: approval.approval_id, eventType: EVENT[eventType], payload });
        }
      };

      const executed = await executeTreeRestore({
        restoreId,
        rootIssueKey: issue.key,
        baselineTree,
        currentTree,
        controlledFields: fields,
        fieldsFor: prepared.fieldsFor,
        adapters,
        maxActions: Number(config?.restore?.maxActions ?? 25)
      });
      const replacements = await adapters.readReplacements(restoreId);
      let verified = null;
      if (executed.state === 'READY_TO_VERIFY') {
        verified = await verifyTreeRestore({
          readStableTree,
          readTree: treeReader.read.bind(treeReader),
          rootIssueKey: issue.key,
          baselineTree,
          controlledFields: fields,
          fieldsFor: prepared.fieldsFor,
          replacements,
          expectedRootStatusId: null
        });
      }
      state = executed.state === 'READY_TO_VERIFY'
        ? (verified.matches ? (replacements.length ? 'COMPLETE_WITH_REPLACEMENTS' : 'COMPLETE')
          : (verified.progress ? 'PARTIAL' : 'FAILED'))
        : executed.state;
      counters = {
        attempted: executed.attempted,
        succeeded: executed.completed,
        failed: state === 'FAILED' || state === 'PARTIAL' ? Math.max(0, executed.attempted - executed.completed) : 0,
        skipped: executed.remaining,
        irreversible: 0
      };
      // Name each refusal in its own words — a link kept because the other end
      // approved otherwise is not "Jira accepted but something overrode it".
      unmatched = explainRefusals(verified?.unmatched ?? [], executed.refused);
      detail = [{ attempted: executed.attempted, completed: executed.completed,
        remaining: executed.remaining, refused: executed.refused ?? [], replacements, unmatched,
        verification: verified && {
          matches: verified.matches, statusMatches: verified.statusMatches, changes: verified.changes,
          unmatched
        } }];
    } else {
      const executed = await executeRestore({ api: forgeApi, plan, issueKey: issue.key, issueId,
        controlledFields: fields, ...config.restore,
        actorAccountId: actor.accountId, approvalId: approval.approval_id,
        approvedLinksOf: approvedLinksResolver() });
      const verified = await verifyRestore({ api: forgeApi, issueKey: issue.key, controlledFields: fields,
        baselineDigests: typeof baseline.field_digests === 'string' ? JSON.parse(baseline.field_digests) : baseline.field_digests,
        detail: executed.detail, expectedStatusId: null });
      detail = verified.detail;
      unmatched = verified.unmatched;
      const tal = tally(detail, unmatched);
      counters = tal.counters;
      state = tal.state;
    }
  } finally {
    await finishRestore({ restoreId, now: Date.now(), counters, state, detail }).catch(e => console.error('finishRestore failed', e));
    const complete = state === 'COMPLETE' || state === 'COMPLETE_WITH_REPLACEMENTS';
    if (complete) await markDecided({ issueId, baselineVersion: baseline.version, approvalId: approval.approval_id }).catch(e => console.error('markDecided failed', e));
    // lib/decision.js owns this rule for both restore paths. A partial restore
    // whose verification NAMED the fields that still differ is honest drift and
    // stays actionable in the queue; anything the app could not establish is
    // ERROR. See stateAfter() for why the two were worth separating.
    const unmatchedCount = unmatched.length;
    await release({ issueId, state: stateAfter({ decision: 'REJECT', restoreState: state, unmatchedCount }),
      now: Date.now(),
      counters: complete ? { driftCount: 0, driftedFieldCount: 0, maxMateriality: null } : {
        driftCount: prepared.driftCount, driftedFieldCount: diff?.materialFieldCount ?? prepared.driftCount,
        maxMateriality: diff?.maxMateriality ?? null } }).catch(e => console.error('release failed', e));
    await tryAppend({ actorAccountId: actor.accountId, issueId, approvalId: approval.approval_id,
      eventType: complete ? EVENT.RESTORE_COMPLETED : EVENT.RESTORE_PARTIAL,
      payload: { restoreId: restoreId.toString('base64'), state, counters,
        unmatched: unmatched.map((u) => u.fieldId) } }).catch(e => console.error('tryAppend failed', e));
  }

  return { success: state === 'COMPLETE' || state === 'COMPLETE_WITH_REPLACEMENTS', restoreId, state, counters, detail, unmatched,
    message: describeResult({ counters, state }) };
}
