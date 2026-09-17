import api, { route } from '@forge/api';
import { restoreById, claimRestore, heartbeatRestore, beginRestoreVerification,
  finishQueuedRestore, markRestoreQueued, markRestoreQueueFailure, failRestore } from '../db/restoreStore.js';
import { activeBaseline } from '../db/baselineStore.js';
import { approvalById } from '../db/approvalStore.js';
import { markDecided } from '../db/driftStore.js';
import { release } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
import { readBaselineTree } from '../db/baselineTreeStore.js';
import { controlledFields, projectConfig } from '../db/configStore.js';
import { scopeFromIssue } from '../lib/trackedFields.js';
import { createTreeReader } from '../lib/tree/jira.js';
import { readStableTree } from '../lib/tree/stableRead.js';
import { planTreeCapture } from '../lib/tree/capturePlan.js';
import { executeTreeRestore } from '../lib/tree/restoreExecutor.js';
import { verifyTreeRestore } from '../lib/tree/restoreVerifier.js';
import { claimRestoreAction, finishRestoreAction, recordReplacement,
  readReplacements, readRestoreActions } from '../db/restoreTreeStore.js';
import { createRestoreAdapters } from '../lib/tree/restoreAdapters.js';
import { enqueueRestore } from '../lib/restore/queue.js';
import { withRequestCache } from '../lib/cache.js';

const WORKER_BATCH = 25;
const TERMINAL = new Set(['COMPLETE', 'COMPLETE_WITH_REPLACEMENTS', 'FAILED']);

function sameId(left, right) {
  if (left == null || right == null) return false;
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  return String(left) === String(right);
}

function restoreIdFor(body, restore) {
  return restore?.restore_id ?? Buffer.from(String(body.restoreId), 'base64');
}

function idBase64(value) {
  return Buffer.isBuffer(value) ? value.toString('base64') : String(value);
}

function actionPlan(restore) {
  const detail = restore?.detail;
  const steps = detail && !Array.isArray(detail) ? detail.actionPlan : null;
  return Array.isArray(steps) ? { steps } : null;
}

function countersFor(executed, state) {
  return {
    attempted: Number(executed?.attempted ?? 0),
    succeeded: Number(executed?.completed ?? 0),
    failed: state === 'FAILED' ? Math.max(0, Number(executed?.attempted ?? 0) - Number(executed?.completed ?? 0)) : 0,
    skipped: Number(executed?.remaining ?? 0),
    irreversible: 0,
    completedSteps: Number(executed?.completed ?? 0)
  };
}

async function defaultPrepare({ restore, baseline }) {
  const forgeApi = api?.default?.asApp ? api.default : api;
  const response = await forgeApi.asApp().requestJira(
    route`/rest/api/3/issue/${restore.issue_id}?fields=*all`
  );
  if (!response.ok) throw new Error('Restore worker could not read the issue');
  const issue = await response.json();
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const [declared, config, editResponse] = await Promise.all([
    controlledFields({ projectId, issueTypeId }),
    projectConfig(projectId),
    forgeApi.asApp().requestJira(route`/rest/api/3/issue/${issue.key}/editmeta?overrideScreenSecurity=true&overrideEditableFlag=true`)
  ]);
  const editmeta = editResponse.ok ? (await editResponse.json()).fields ?? {} : {};
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: editmeta });
  const reader = createTreeReader({ api: forgeApi, route });
  const stable = await readStableTree({ readTree: reader.read.bind(reader), rootIssueKey: issue.key,
    fieldIds: fields.map(field => field.field_id) });
  const captured = planTreeCapture({ rootIssueId: issue.id, nodes: stable.tree.nodes, controlledFields: fields });
  return {
    issue, issueId: Number(issue.id), projectId, config, fields,
    baseline, baselineTree: await readBaselineTree(baseline.baseline_id),
    currentTree: { nodes: captured.nodes, values: captured.values },
    reader, forgeApi
  };
}

async function defaultExecute({ restoreId, prepared, plan, maxActions }) {
  const jiraAdapters = createRestoreAdapters({ api: prepared.forgeApi, route });
  const adapters = {
    claimRestoreAction, finishRestoreAction, recordReplacement,
    readReplacements, readRestoreActions, ...jiraAdapters
  };
  return executeTreeRestore({ restoreId, rootIssueKey: prepared.issue.key,
    baselineTree: prepared.baselineTree, currentTree: prepared.currentTree,
    controlledFields: prepared.fields, adapters, plan, maxActions });
}

async function defaultVerify({ prepared, restoreId }) {
  const replacements = await readReplacements(restoreId);
  return verifyTreeRestore({ readStableTree, readTree: prepared.reader.read.bind(prepared.reader),
    rootIssueKey: prepared.issue.key, baselineTree: prepared.baselineTree,
    controlledFields: prepared.fields, replacements,
    expectedRootStatusId: null });
}

/**
 * Forge queue consumers are at-least-once. Every state transition below is
 * guarded by a durable CAS, so a duplicate delivery either observes terminal
 * work or loses the claim before it can call Jira.
 */
export async function runRestoreWorker(eventOrBody, overrides = {}) {
  const body = eventOrBody?.body ?? eventOrBody;
  const now = overrides.now ?? Date.now();
  const deps = {
    restoreById, activeBaseline, approvalById, claimRestore, heartbeatRestore,
    beginRestoreVerification, finishRestore: finishQueuedRestore,
    markRestoreQueued, markRestoreQueueFailure, failRestore, markDecided, release,
    enqueue: enqueueRestore, prepare: defaultPrepare, executeBatch: defaultExecute,
    verify: defaultVerify, append: tryAppend, ...overrides
  };
  if (!body?.restoreId) return { state: 'FAILED', reason: 'RESTORE_NOT_FOUND' };

  const restore = await deps.restoreById(body.restoreId);
  if (!restore) return { state: 'FAILED', reason: 'RESTORE_NOT_FOUND' };
  if (TERMINAL.has(restore.state)) return { state: restore.state, restore };

  const baseline = await deps.activeBaseline(Number(body.issueId));
  if (!baseline || Number(baseline.version) !== Number(body.baselineVersion)
      || !sameId(baseline.baseline_id, Buffer.from(String(body.baselineId), 'base64'))
      || Number(restore.baseline_version) !== Number(body.baselineVersion)) {
    await deps.failRestore({ restoreId: restoreIdFor(body, restore), error: 'STALE_BASELINE', now });
    await deps.release({ issueId: Number(body.issueId), state: 'ERROR', now,
      counters: { driftCount: 1, driftedFieldCount: 1, maxMateriality: null } }).catch(() => {});
    return { state: 'FAILED', reason: 'STALE_BASELINE' };
  }

  const restoreId = restoreIdFor(body, restore);
  const claimed = await deps.claimRestore({ restoreId, now });
  if (!claimed) return { state: restore.state, skipped: true };

  try {
    const approval = await deps.approvalById(restore.approval_id);
    if (!approval || approval.decision !== 'REJECT') throw new Error('Original rejection approval is unavailable');
    const prepared = await deps.prepare({ restore, approval, baseline, body });
    const plan = actionPlan(restore);
    if (!plan) throw new Error('Restore action plan is unavailable');
    await deps.heartbeatRestore({ restoreId, completedSteps: Number(restore.completed_steps ?? 0),
      totalSteps: Number(restore.total_steps ?? plan.steps.length), now });
    const executed = await deps.executeBatch({ restoreId, restore, approval, prepared, plan,
      maxActions: WORKER_BATCH });
    const totalSteps = Number(restore.total_steps ?? plan.steps.length);
    if (executed.state === 'PARTIAL' || Number(executed.remaining) > 0) {
      const previousCompleted = Number(restore.completed_steps ?? 0);
      const completed = Number(executed.completed ?? 0);
      if (executed.stopped === true && Number(executed.attempted ?? 0) > 0 && completed <= previousCompleted) {
        throw new Error('Restore made no progress; inspect the failed action before retrying.');
      }
      await deps.heartbeatRestore({ restoreId, completedSteps: Number(executed.completed ?? 0),
        totalSteps, now: Date.now() });
      try {
        const pushed = await deps.enqueue({ restoreId: idBase64(restoreId), issueId: Number(body.issueId),
          baselineId: String(body.baselineId), baselineVersion: Number(body.baselineVersion) });
        if (!pushed?.jobId) throw new Error('Forge did not return a restore job id');
        await deps.markRestoreQueued({ restoreId, jobId: pushed.jobId, now: Date.now(), totalSteps });
        return { state: 'RESTORING', restoreId, progress: { totalSteps, completedSteps: Number(executed.completed ?? 0), remainingSteps: Number(executed.remaining ?? 0) } };
      } catch (error) {
        await deps.markRestoreQueueFailure({ restoreId, error, now: Date.now() });
        return { state: 'QUEUING_FAILED', restoreId, error: String(error?.message ?? error) };
      }
    }
    if (executed.state !== 'READY_TO_VERIFY') throw new Error('Restore action batch failed');
    if (!await deps.beginRestoreVerification({ restoreId, now: Date.now() })) {
      return { state: 'RESTORING', restoreId, skipped: true };
    }
    const verified = await deps.verify({ restoreId, restore, approval, prepared, plan });
    const replacements = verified.replacements ?? [];
    const state = verified.matches
      ? (replacements.length ? 'COMPLETE_WITH_REPLACEMENTS' : 'COMPLETE')
      : (verified.progress ? 'PARTIAL' : 'FAILED');
    const counters = countersFor(executed, state);
    const detail = [{ ...counters, remaining: Number(executed.remaining ?? 0), verification: verified }];
    await deps.finishRestore({ restoreId, now: Date.now(), counters, state, detail });
    // finishRestore is durable at this point — the restore's own terminal
    // state is settled and reported below regardless of what happens next.
    // A failure in this bookkeeping must not fall into the catch block: that
    // would call failRestore() (a no-op against the already-terminal row,
    // since its WHERE clause excludes COMPLETE/COMPLETE_WITH_REPLACEMENTS/
    // FAILED) and release(issue, 'ERROR') (not a no-op — it would mark an
    // issue that was actually restored as being in error), and it would
    // report this call as FAILED when the restore itself did not fail.
    try {
      await deps.markDecided({ issueId: Number(body.issueId), baselineVersion: Number(body.baselineVersion), approvalId: restore.approval_id });
      await deps.release({ issueId: Number(body.issueId), state: 'BASELINED', now: Date.now(),
        counters: { driftCount: 0, driftedFieldCount: 0, maxMateriality: null } });
      await deps.append({ actorAccountId: restore.actor_account_id, issueId: Number(body.issueId),
        approvalId: restore.approval_id, eventType: EVENT.RESTORE_COMPLETED,
        payload: { restoreId: idBase64(restoreId), state, counters } });
    } catch (bookkeepingError) {
      console.error('restoreWorker: post-completion bookkeeping failed', JSON.stringify({ restoreId: idBase64(restoreId), state }), bookkeepingError);
    }
    return { state, restoreId, progress: { totalSteps, completedSteps: counters.completedSteps, remainingSteps: 0 } };
  } catch (error) {
    await deps.failRestore({ restoreId, error, now: Date.now() });
    await deps.release({ issueId: Number(body.issueId), state: 'ERROR', now: Date.now(),
      counters: { driftCount: 1, driftedFieldCount: 1, maxMateriality: null } }).catch(() => {});
    return { state: 'FAILED', restoreId, error: String(error?.message ?? error) };
  }
}

export async function handler(event) {
  return withRequestCache(() => runRestoreWorker(event));
}
