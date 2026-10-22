import api, { route } from '@forge/api';
import { restoreById, claimRestore, heartbeatRestore, beginRestoreVerification,
  finishQueuedRestore, markRestoreQueued, markRestoreQueueFailure, failRestore } from '../db/restoreStore.js';
import { activeBaseline, activeBaselines, baselineById, readAllValues } from '../db/baselineStore.js';
import { approvalById } from '../db/approvalStore.js';
import { markDecided } from '../db/driftStore.js';
import { release, refreshRestoreLock } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
import { stateAfter, DECISION } from '../lib/decision.js';
import { readBaselineTree, activeRootsForNode } from '../db/baselineTreeStore.js';
import { controlledFields, projectConfig } from '../db/configStore.js';
import { scopeFromIssue } from '../lib/trackedFields.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';
import { baselineDecisionMeaning } from '../lib/approval/challenge.js';
import { CAUSE } from '../lib/evidence/versionEvidence.js';
import { createTreeReader } from '../lib/tree/jira.js';
import { testManagementExclusion } from '../testmgmt/treeExclusion.js';
import { readStableTree } from '../lib/tree/stableRead.js';
import { planTreeCapture } from '../lib/tree/capturePlan.js';
import { readTreeWithNodeFields, fieldScope } from '../lib/tree/nodeFields.js';
import { withChildBaselines } from '../lib/tree/childBaselines.js';
import { resolveBaselineTree } from '../lib/tree/scopedBaseline.js';
import { logicalNodeId } from '../lib/tree/model.js';
import { approvedLinksResolver } from '../db/approvedLinks.js';
import { executeTreeRestore } from '../lib/tree/restoreExecutor.js';
import { verifyTreeRestore, explainRefusals } from '../lib/tree/restoreVerifier.js';
import { claimRestoreAction, finishRestoreAction, recordReplacement,
  readReplacements, readRestoreActions } from '../db/restoreTreeStore.js';
import { createRestoreAdapters } from '../lib/tree/restoreAdapters.js';
import { enqueueRestore } from '../lib/restore/queue.js';
import { withRequestCache } from '../lib/cache.js';
import { harnessLog } from '../lib/harnessLogger.js';
import { applyOverlay } from '../lib/approval/mixedDecision.js';
import { baselineLinkPolicy, treeLinkPolicyResolver, hydrateLinkPolicyNodes, serialiseLinkPolicy } from '../lib/linkPolicy.js';

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

/**
 * The plan persisted when the restore was queued. A finished restore's detail
 * is its result list, and carries the plan in its first entry: a Retry must
 * find the same plan to resume, and it used to find none ("Restore action plan
 * is unavailable"), because finishing overwrote the detail it lived in.
 */
function actionPlan(restore) {
  const detail = restore?.detail;
  const steps = Array.isArray(detail) ? detail[0]?.actionPlan : detail?.actionPlan;
  return Array.isArray(steps) ? { steps } : null;
}

/**
 * The per-field decision a restore belongs to: the frozen overlay, the map hash
 * and which fields were approved and rejected (usecases/restoreActions.js
 * queueRestore). Like the plan, a finished restore keeps it in its first detail
 * entry, so a Retry finds it.
 */
function mixedOf(restore) {
  const detail = restore?.detail;
  const mixed = Array.isArray(detail) ? detail[0]?.mixed : detail?.mixed;
  return mixed && typeof mixed === 'object' && mixed.overlay && typeof mixed.overlay === 'object' ? mixed : null;
}

/** A queued decision cannot adopt a later child baseline's exclusion rules. */
function pinLinkPolicies(restore, prepared) {
  const detail = Array.isArray(restore?.detail) ? restore.detail[0] : restore?.detail;
  const saved = detail?.linkPolicies;
  const nodes = prepared.baselineTree?.nodes ?? [];
  const policyFor = treeLinkPolicyResolver(prepared.baselineTree, baselineLinkPolicy(prepared.baseline));
  const stale = () => { throw new Error('The stored link policy changed after this restore was reviewed. Review the changes and decide again.'); };
  if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved)
    || Object.keys(saved).length !== nodes.length)) stale();
  const frozen = {};
  for (const node of nodes) {
    const policy = policyFor(node);
    // Jobs written before snapshots existed are exactly v1, just like old baselines.
    const expected = saved === undefined ? { version: 1 } : saved[node.logicalNodeId];
    if (saved !== undefined && !Object.hasOwn(saved, node.logicalNodeId)) stale();
    if (serialiseLinkPolicy(policy) !== serialiseLinkPolicy(expected)) stale();
    frozen[node.logicalNodeId] = policy;
  }
  prepared.linkPolicyFor = policyFor;
  prepared.policyFor = policyFor;
  return frozen;
}

const PUBLICATION_INCOMPLETE = {
  kind: 'PUBLICATION_INCOMPLETE', logicalNodeId: null, issueKey: null, fieldId: null, fieldName: null,
  expected: null, actual: null,
  reason: 'The rejected fields were put back and verified, but the next baseline could not be published, '
    + 'so the approved fields are not yet recorded. Retry the restore to publish it.'
};

function countersFor(executed, state) {
  // A refused step is a step that did not happen, and the panel counts `failed`
  // to tell a reviewer how much of the restore did not land. Reporting 0 while
  // naming refusals elsewhere in the same record is the kind of quiet
  // disagreement that made the original failure so hard to read.
  const refused = Array.isArray(executed?.refused) ? executed.refused.length : 0;
  return {
    attempted: Number(executed?.attempted ?? 0),
    succeeded: Number(executed?.completed ?? 0),
    failed: state === 'FAILED'
      ? Math.max(refused, Number(executed?.attempted ?? 0) - Number(executed?.completed ?? 0))
      : refused,
    skipped: Number(executed?.remaining ?? 0),
    irreversible: 0,
    completedSteps: Number(executed?.completed ?? 0)
  };
}

const REWRITING_STEPS = new Set(['RESTORE_FIELDS', 'RESTORE_LINKS', 'RESTORE_ATTACHMENTS', 'REPOINT_RICH_TEXT', 'MOVE_NODE']);

/**
 * The descendants this restore wrote to. A parent's restore puts each child
 * back to that child's own record, and the child carries its own stored review
 * state and its own evidence, so both have to follow. A recreated or deleted
 * node is not here: it has no prior record to settle.
 */
function rewrittenChildren({ plan, prepared, rootIssueId }) {
  const byLogical = new Map();
  for (const node of [...(prepared?.baselineTree?.nodes ?? []), ...(prepared?.currentTree?.nodes ?? [])]) {
    const issueId = Number(node?.currentIssueId);
    if (Number.isFinite(issueId)) byLogical.set(String(node.logicalNodeId), issueId);
  }
  const children = new Map();
  for (const step of plan?.steps ?? []) {
    if (!REWRITING_STEPS.has(step.kind)) continue;
    const issueId = byLogical.get(String(step.logicalNodeId));
    if (issueId != null && issueId !== rootIssueId) children.set(issueId, String(step.logicalNodeId));
  }
  return [...children].map(([issueId, logicalNodeId]) => ({ issueId, logicalNodeId }));
}

/**
 * The children whose restore can be called settled. After a COMPLETE restore,
 * every one of them. After a PARTIAL one, only those the verification read back
 * as matching their own record: a child whose write was refused, or that the
 * verification names, stays drifted, and when the verification cannot say WHICH
 * item is wrong (it could not read the tree, or an entry names no item) none is
 * claimed.
 */
function settledChildren({ complete, plan, prepared, rootIssueId, refused = [], unmatched = [] }) {
  const written = rewrittenChildren({ plan, prepared, rootIssueId });
  if (complete) return written;
  if (unmatched.some(entry => entry?.kind === 'READ_FAILED' || entry?.logicalNodeId == null)) return [];
  const wrong = new Set([...refused, ...unmatched].map(entry => String(entry.logicalNodeId)));
  return written.filter(child => !wrong.has(child.logicalNodeId));
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
  const [{ fields: declared, ruleScope }, config, editResponse] = await Promise.all([
    fieldScope({ issueId: Number(issue.id), projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
    projectConfig(projectId),
    forgeApi.asApp().requestJira(route`/rest/api/3/issue/${issue.key}/editmeta?overrideScreenSecurity=true&overrideEditableFlag=true`)
  ]);
  const editmeta = editResponse.ok ? (await editResponse.json()).fields ?? {} : {};
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: editmeta });
  const reader = createTreeReader({ api: forgeApi, route, exclude: testManagementExclusion });
  const stable = await readTreeWithNodeFields({ readStableTree, readTree: reader.read.bind(reader),
    rootIssueKey: issue.key, rootFields: fields });
  const { fieldsFor } = stable;
  const baselineValues = await readAllValues(Number(issue.id), Number(baseline.version));
  const resolvedBaseline = await resolveBaselineTree({ baseline, baselineValues,
    rootLogicalNodeId: logicalNodeId(issue.id), baselineById, readBaselineTree });
  if (!resolvedBaseline) throw new Error('Restore cannot reconstruct the signed governing baseline tree.');
  const baselineTree = await withChildBaselines({ parentBaseline: resolvedBaseline.governingBaseline,
    baselineTree: resolvedBaseline.tree, activeBaselines, readAllValues, readBaselineTree });
  const policyFor = treeLinkPolicyResolver(baselineTree, baselineLinkPolicy(baseline));
  stable.tree.nodes = await hydrateLinkPolicyNodes(stable.tree.nodes, policyFor);
  const captured = planTreeCapture({ rootIssueId: issue.id, nodes: stable.tree.nodes, controlledFields: fields, fieldsFor, policyFor });
  return {
    issue, issueId: Number(issue.id), projectId, config, fields, fieldsFor, ruleScope,
    // The same tree the reviewer rejected against (usecases/panelAccess.js):
    // each child that carries its own latest baseline stands as that baseline,
    // so verification checks each issue against its own record.
    baseline, baselineTree, policyFor, linkPolicy: baselineLinkPolicy(baseline), linkPolicyFor: policyFor,
    currentTree: { nodes: captured.nodes, values: captured.values },
    reader, forgeApi
  };
}

async function defaultExecute({ restoreId, restore, prepared, plan, maxActions }) {
  const jiraAdapters = createRestoreAdapters({ api: prepared.forgeApi, route,
    actorAccountId: restore?.actor_account_id ?? 'system', approvalId: restore?.approval_id ?? null,
    policyForIssue: (issue, context) => (prepared.linkPolicyFor ?? prepared.policyFor
      ?? treeLinkPolicyResolver(prepared.baselineTree, baselineLinkPolicy(prepared.baseline)))({
      ...issue, logicalNodeId: context?.logicalNodeId }),
    // A link is changed only when its other end's approved state agrees
    // (lib/restore/linkConflicts.js).
    approvedLinksOf: approvedLinksResolver({ baselineTree: prepared.baselineTree }) });
  const adapters = {
    claimRestoreAction, finishRestoreAction, recordReplacement,
    readReplacements, readRestoreActions, ...jiraAdapters,
    // The synchronous path in usecases/restoreActions.js has always wired this;
    // the queued worker never did, so a tree restore run through the queue —
    // which is every tree restore, since config.restore.queue defaults on —
    // wrote no step-level ledger entries at all. The executor now refuses to
    // delete a work item without one, and that refusal would have been
    // permanent here.
    appendLedger: async (eventType, payload) => {
      await tryAppend({ actorAccountId: restore?.actor_account_id ?? 'system',
        issueId: Number(prepared.issueId), approvalId: restore?.approval_id ?? null,
        eventType: EVENT[eventType] ?? eventType, payload });
    }
  };
  return executeTreeRestore({ restoreId, rootIssueKey: prepared.issue.key,
    baselineTree: prepared.baselineTree, currentTree: prepared.currentTree,
    controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor, adapters, plan, maxActions });
}

async function defaultVerify({ prepared, restoreId }) {
  const replacements = await readReplacements(restoreId);
  return verifyTreeRestore({ readStableTree, readTree: prepared.reader.read.bind(prepared.reader),
    // A per-field decision verifies against its target (restoreWorker's
    // `targetTree`); every other restore verifies against the baseline itself.
    rootIssueKey: prepared.issue.key, baselineTree: prepared.targetTree ?? prepared.baselineTree,
    controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor, replacements,
    expectedRootStatusId: null });
}

/**
 * Publishes the next baseline from the state a per-field restore just verified.
 *
 * The worker has no user session, so it reads as the app and re-reads the item:
 * the issue read in prepare() predates this restore's last writes. The tree hash
 * of that fresh read is handed to the capture as the hash it must still see —
 * the signed hash cannot be it (the reviewer signed the candidate, and the
 * rejected fields have since been restored), and this refuses the capture if
 * anything moved between the verification and the read it makes itself.
 */
async function defaultCaptureMixed({ restore, approval, prepared, baseline }) {
  const { captureDriftBaseline, publishBaselineSideEffects } = await import('../usecases/drift.js');
  const readTree = prepared.reader.read.bind(prepared.reader);
  const response = await prepared.forgeApi.asApp().requestJira(route`/rest/api/3/issue/${prepared.issueId}?fields=*all`);
  if (!response.ok) throw new Error('Restore worker could not re-read the issue to publish its baseline');
  const issue = await response.json();
  const stable = await readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey: issue.key,
    rootFields: prepared.fields, extraFieldIds: ['status', 'parent', 'security'] });
  const linkPolicy = baselineLinkPolicy(approval);
  const linkPolicyFor = treeLinkPolicyResolver(prepared.baselineTree, linkPolicy);
  stable.tree.nodes = await hydrateLinkPolicyNodes(stable.tree.nodes, linkPolicyFor);
  const expectedTreeHash = planTreeCapture({ rootIssueId: issue.id, nodes: stable.tree.nodes,
    controlledFields: prepared.fields, fieldsFor: stable.fieldsFor, linkPolicy, policyFor: linkPolicyFor }).treeHash;
  // The baseline's own recorded rule, mapped exactly as prepareApproval maps it.
  const frozen = baselinePolicy(baseline);
  const gate = { transition_id: frozen.transitionId, from_status_id: frozen.reviewStatusId,
    to_status_id: frozen.destinationStatusId, required_role: frozen.requiredRole,
    required_assurance: frozen.requiredAssurance, meaning: baselineDecisionMeaning('MIXED', frozen.version),
    capture_baseline: true };
  const actor = { accountId: restore.actor_account_id, displayName: approval.actor_name ?? approval.printed_name ?? null };
  const checked = { issue, issueId: Number(issue.id), projectId: prepared.projectId, fields: prepared.fields,
    ruleScope: prepared.ruleScope, gate, baseline, baselineTree: prepared.baselineTree, linkPolicy, linkPolicyFor };
  const capture = await captureDriftBaseline({ checked, approval, actor, cause: CAUSE.MIXED_DECISION,
    readTree, expectedTreeHash });
  if (capture.captured) await publishBaselineSideEffects({ capture, checked, approval, actor });
  return capture;
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
    refreshItemLock: refreshRestoreLock,
    enqueue: enqueueRestore, prepare: defaultPrepare, executeBatch: defaultExecute,
    verify: defaultVerify, captureMixed: defaultCaptureMixed, append: tryAppend, ...overrides
  };
  // The work item's RESTORING lock is what the gate, the collectors and every
  // other decision read; va_restore's own heartbeat is invisible to them. Kept
  // fresh at each checkpoint so a long or slow-delivered restore is never
  // mistaken for an abandoned one. Best effort: a missed beat only shortens
  // the lease, which the next beat restores.
  const beat = at => Promise.resolve(deps.refreshItemLock({ issueId: Number(body.issueId), now: at }))
    .catch(error => console.error('restoreWorker: could not refresh the item lock', error));
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
  harnessLog('RESTORE', 'worker:claim', { restoreId: idBase64(restoreId), issueId: body.issueId });
  await beat(now);

  try {
    const approval = await deps.approvalById(restore.approval_id);
    if (!approval || !['REJECT', 'MIXED'].includes(approval.decision)) throw new Error('Original rejection approval is unavailable');
    const mixed = approval.decision === 'MIXED' ? mixedOf(restore) : null;
    if (approval.decision === 'MIXED' && !mixed) throw new Error('The field decisions this restore belongs to are unavailable');
    const prepared = await deps.prepare({ restore, approval, baseline, body });
    const linkPolicies = pinLinkPolicies(restore, prepared);
    // Verify against what the reviewer decided: the approved baseline, with each
    // APPROVED field at the digest they saw. Rebuilt from the frozen overlay,
    // never from live values, so an edit to an approved field after signing
    // fails verification instead of being silently accepted.
    if (mixed) prepared.targetTree = applyOverlay({ baselineTree: prepared.baselineTree, overlay: mixed.overlay });
    const plan = actionPlan(restore);
    if (!plan) throw new Error('Restore action plan is unavailable');
    await deps.heartbeatRestore({ restoreId, completedSteps: Number(restore.completed_steps ?? 0),
      totalSteps: Number(restore.total_steps ?? plan.steps.length), now });
    const executed = await deps.executeBatch({ restoreId, restore, approval, prepared, plan,
      maxActions: WORKER_BATCH });
    const totalSteps = Number(restore.total_steps ?? plan.steps.length);
    harnessLog('RESTORE', 'worker:batchExecuted', { restoreId: idBase64(restoreId), completed: executed.completed, remaining: executed.remaining, state: executed.state });
    if (executed.state === 'PARTIAL' || Number(executed.remaining) > 0) {
      const previousCompleted = Number(restore.completed_steps ?? 0);
      const completed = Number(executed.completed ?? 0);
      // A preflight refusal attempts nothing, so the no-progress guard below
      // never fired and the batch was handed straight back to the queue — for
      // ever, with the item pinned in RESTORING and the gate denying every
      // transition. Nothing was tried and nothing can be: settle it.
      if (executed.preflightFailed === true || executed.state === 'FAILED') {
        throw new Error(executed.preflightFailed === true
          ? 'The app does not have the Jira permissions this restore needs on every affected project.'
          : 'The restore batch could not run, so there is nothing for a further attempt to continue.');
      }
      if (executed.stopped === true && Number(executed.attempted ?? 0) > 0 && completed <= previousCompleted) {
        throw new Error('Restore made no progress; inspect the failed action before retrying.');
      }
      await deps.heartbeatRestore({ restoreId, completedSteps: Number(executed.completed ?? 0),
        totalSteps, now: Date.now() });
      await beat(Date.now());
      try {
        const pushed = await deps.enqueue({ restoreId: idBase64(restoreId), issueId: Number(body.issueId),
          baselineId: String(body.baselineId), baselineVersion: Number(body.baselineVersion) });
        if (!pushed?.jobId) throw new Error('Forge did not return a restore job id');
        await deps.markRestoreQueued({ restoreId, jobId: pushed.jobId, now: Date.now(), totalSteps });
        harnessLog('RESTORE', 'worker:requeued', { restoreId: idBase64(restoreId), jobId: pushed.jobId, remaining: executed.remaining });
        return { state: 'RESTORING', restoreId, progress: { totalSteps, completedSteps: Number(executed.completed ?? 0), remainingSteps: Number(executed.remaining ?? 0) } };
      } catch (error) {
        await deps.markRestoreQueueFailure({ restoreId, error, now: Date.now() });
        // No batch is coming, so the item is not left RESTORING for the gate to
        // report as running. ERROR, as for any restore that could not run;
        // Retry resumes it (usecases/restore.js).
        await deps.release({ issueId: Number(body.issueId), state: 'ERROR', now: Date.now(),
          counters: { driftCount: 1, driftedFieldCount: 1, maxMateriality: null } }).catch(() => {});
        harnessLog('ERROR', 'worker:requeueFailed', { restoreId: idBase64(restoreId), error: error?.message });
        return { state: 'QUEUING_FAILED', restoreId, error: String(error?.message ?? error) };
      }
    }
    if (executed.state !== 'READY_TO_VERIFY') throw new Error('Restore action batch failed');
    if (!await deps.beginRestoreVerification({ restoreId, now: Date.now() })) {
      return { state: 'RESTORING', restoreId, skipped: true };
    }
    await beat(Date.now());
    const verified = await deps.verify({ restoreId, restore, approval, prepared, plan });
    const replacements = verified.replacements ?? [];
    const restoredState = verified.matches
      ? (replacements.length ? 'COMPLETE_WITH_REPLACEMENTS' : 'COMPLETE')
      : (verified.progress ? 'PARTIAL' : 'FAILED');
    // THE ONE DURABLE BOUNDARY OF A PER-FIELD DECISION: the next baseline is
    // captured only now, after every rejected field has been read back at its
    // approved value. Capturing earlier would re-approve a value the reviewer
    // rejected. If publication fails the restore is NOT left looking complete:
    // the rejected fields are back, but the approved ones are not yet recorded.
    let publication = null;
    if (mixed && restoredState !== 'PARTIAL' && restoredState !== 'FAILED') {
      if (mixed.approved.length === 0) publication = 'NOT_NEEDED';
      else {
        try {
          const captured = await deps.captureMixed({ restore, approval, prepared, baseline, mixed });
          publication = captured?.captured === true ? 'PUBLISHED' : 'INCOMPLETE';
          if (publication === 'INCOMPLETE') harnessLog('ERROR', 'worker:publishRefused', { restoreId: idBase64(restoreId), reason: captured?.reason }, 'WARN');
        } catch (error) {
          publication = 'INCOMPLETE';
          harnessLog('ERROR', 'worker:publishFailed', { restoreId: idBase64(restoreId), error: error?.message });
        }
      }
    }
    const state = publication === 'INCOMPLETE' ? 'PARTIAL' : restoredState;
    const counters = countersFor(executed, state);
    const unmatched = explainRefusals(verified.unmatched ?? [], executed.refused);
    const detail = [{ ...counters, remaining: Number(executed.remaining ?? 0),
      refused: executed.refused ?? [],
      unmatched: publication === 'INCOMPLETE' ? [...unmatched, PUBLICATION_INCOMPLETE] : unmatched,
      verification: verified, actionPlan: plan.steps,
      ...(Object.values(linkPolicies).some(policy => policy.version === 2) ? { linkPolicies } : {}),
      ...(mixed ? { mixed, publication } : {}) }];
    await deps.finishRestore({ restoreId, now: Date.now(), counters, state, detail });
    harnessLog('RESTORE', 'worker:finished', { restoreId: idBase64(restoreId), state,
      replacementsCount: replacements.length, refusedCount: (executed.refused ?? []).length,
      unmatchedCount: unmatched.length,
      unmatchedFields: unmatched.map(entry => entry.fieldName ?? entry.kind).slice(0, 20) },
    state === 'COMPLETE' || state === 'COMPLETE_WITH_REPLACEMENTS' ? 'INFO' : 'WARN');
    // finishRestore is durable at this point — the restore's own terminal
    // state is settled and reported below regardless of what happens next.
    // A failure in this bookkeeping must not fall into the catch block: that
    // would call failRestore() (a no-op against the already-terminal row,
    // since its WHERE clause excludes COMPLETE/COMPLETE_WITH_REPLACEMENTS/
    // FAILED) and release(issue, 'ERROR') (not a no-op — it would mark an
    // issue that was actually restored as being in error), and it would
    // report this call as FAILED when the restore itself did not fail.
    //
    // ─── AND IT IS CONDITIONAL, WHICH IT WAS NOT ─────────────────────────────
    //
    // This block used to run whatever the verifier said. A restore the verifier
    // had just REFUSED to confirm was therefore recorded as RESTORE_COMPLETED
    // in the ledger, its drift was marked decided, and the item was released as
    // BASELINED with driftCount 0 — the app asserting that a work item matched
    // its approved baseline in the same breath as reporting that it did not.
    // For an evidence product that is the worst class of bug there is, and it
    // is also what made the failure so confusing to a reviewer: the panel said
    // PARTIAL while the queue said clean, and the next drift sweep re-raised
    // the same difference and blocked the transition all over again.
    //
    // The synchronous path in usecases/restoreActions.js has always gated this
    // on `complete`. The two paths now say the same thing.
    const complete = state === 'COMPLETE' || state === 'COMPLETE_WITH_REPLACEMENTS';
    // lib/decision.js owns where a decided item lands. The queued worker and
    // the synchronous path in usecases/restoreActions.js both ask it, so they
    // cannot drift apart the way they had.
    const itemState = stateAfter({ decision: DECISION.REJECT, restoreState: state,
      unmatchedCount: unmatched.length });
    try {
      if (complete) {
        await deps.markDecided({ issueId: Number(body.issueId), baselineVersion: Number(body.baselineVersion), approvalId: restore.approval_id });
      }
      const outstanding = complete ? 0 : Math.max(unmatched.length, 1);
      await deps.release({ issueId: Number(body.issueId), state: itemState, now: Date.now(),
        counters: { driftCount: outstanding, driftedFieldCount: outstanding, maxMateriality: null } });
      await deps.append({ actorAccountId: restore.actor_account_id, issueId: Number(body.issueId),
        approvalId: restore.approval_id,
        eventType: complete ? EVENT.RESTORE_COMPLETED : EVENT.RESTORE_PARTIAL,
        payload: { restoreId: idBase64(restoreId), state, counters,
          refused: (executed.refused ?? []).map(entry => entry.stepKey),
          unmatched: unmatched.map(entry => entry.fieldId ?? entry.kind),
          ...(mixed ? { publication, ...(complete ? { mixed: { approved: mixed.approved, rejected: mixed.rejected,
            baselineCreated: publication === 'PUBLISHED' } } : {}) } : {}) } });
      // Each child is settled on its own: one that cannot be written must not
      // leave the others (or the decided item, already released) unsettled.
      for (const child of settledChildren({ complete, plan, prepared, rootIssueId: Number(body.issueId),
        refused: executed.refused ?? [], unmatched })) {
        try {
          await deps.release({ issueId: child.issueId, state: stateAfter({ decision: DECISION.REJECT, restoreState: 'COMPLETE' }),
            now: Date.now(), counters: { driftCount: 0, driftedFieldCount: 0, maxMateriality: null } });
          await deps.append({ actorAccountId: restore.actor_account_id, issueId: child.issueId,
            approvalId: restore.approval_id, eventType: EVENT.RESTORE_COMPLETED,
            payload: { restoreId: idBase64(restoreId), state: 'COMPLETE', parentState: state,
              viaParentIssueId: Number(body.issueId) } });
        } catch (childError) {
          console.error('restoreWorker: could not settle a restored child', JSON.stringify({ restoreId: idBase64(restoreId), childId: child.issueId }), childError);
        }
      }
    } catch (bookkeepingError) {
      console.error('restoreWorker: post-completion bookkeeping failed', JSON.stringify({ restoreId: idBase64(restoreId), state }), bookkeepingError);
    }
    return { state, restoreId, progress: { totalSteps, completedSteps: counters.completedSteps, remainingSteps: 0 } };
  } catch (error) {
    harnessLog('ERROR', 'worker:failed', { restoreId: idBase64(restoreId), issueId: body?.issueId, error: error?.message });
    await deps.failRestore({ restoreId, error, now: Date.now() });
    await deps.release({ issueId: Number(body.issueId), state: 'ERROR', now: Date.now(),
      counters: { driftCount: 1, driftedFieldCount: 1, maxMateriality: null } }).catch(() => {});
    return { state: 'FAILED', restoreId, error: String(error?.message ?? error) };
  }

}

export async function handler(event) {
  return withRequestCache(() => runRestoreWorker(event));
}
