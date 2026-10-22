import { createHash } from 'node:crypto';
import { actorFrom } from './access.js';
import { resolveSubject, parentOf } from './testAuthoring.js';
import { tmRespond } from '../testmgmt/messages.js';
import { contentDigest } from '../testmgmt/content.js';
import { chainDigest, chainPreflight } from '../testmgmt/chain.js';
import { verifyRunProof, verifyVersionProof } from '../testmgmt/proof.js';

export const RETEST_PROPERTY = 'va-tm-retest';
export const RETEST_SETTLE_MS = 5 * 60_000;
export const RETEST_MAX_SELECTION = 100;
export const RETEST_FAN_OUT_BATCH = 10;
const terminal = new Set(['SIGNED', 'REJECTED', 'NOT_EXECUTED']);
const digestId = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const validId = value => /^[0-9a-f]{32}$/.test(String(value ?? ''));
const defaultRun = run => run.state === 'REJECTED' || run.state === 'NOT_EXECUTED' || (run.state === 'SIGNED' && run.result === 'FAILED');
const problem = (reason, message) => { throw Object.assign(new Error(message), { reason, userMessage: message }); };
export const retestChildRequestId = (requestId, runId) => digestId(`${requestId}:${runId}`);

/** All selection snapshots come from stored, authorized runs, never from the client. */
export function createTestRetest(deps) {
  async function context(issueKey, actor) {
    if (!actor?.accountId) problem('AUTHENTICATION_REQUIRED', 'Sign in before creating a rerun.');
    const { issue, project } = await resolveSubject(issueKey, deps, 'EXECUTION');
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES') || !await deps.hasIssuePermission(issue.id, 'CREATE_ISSUES')) {
      problem('RETEST_PERMISSION_DENIED', 'You need Edit Issues and Create Issues permission for this execution to create a rerun.');
    }
    if (String(issue.fields?.status?.statusCategory?.key) !== 'done') problem('RETEST_SOURCE_NOT_FINISHED', 'Finish the source execution before creating a selective rerun.');
    const parent = parentOf(issue);
    if (!parent) problem('NO_PARENT', 'Set the source execution\'s parent before creating a rerun.');
    const parentIssue = await deps.readIssueAsUser(parent.id);
    if (String(parentIssue.fields?.project?.id) !== String(project.projectId)) problem('RETEST_PARENT_INVALID', 'The execution parent must be visible in the same project.');
    const runs = await deps.listRunsForExecution(issue.id);
    if (!Array.isArray(runs) || runs.complete === false || runs.hasMore || runs.length > 500) problem('RETEST_SOURCE_INCOMPLETE', 'The execution run list is incomplete. No rerun was created.');
    if (runs.some(run => !terminal.has(run.state))) problem('RETEST_SOURCE_NOT_FINISHED', 'Every source run must be terminal before creating a rerun.');
    return { issue, project, parent, runs, actor };
  }

  async function selectedSnapshots(c, selectedIds, useLatestVersion) {
    const selected = selectedIds == null ? c.runs.filter(defaultRun) : selectedIds.map(id => c.runs.find(run => run.runId === id));
    if (!selected.length || selected.length > RETEST_MAX_SELECTION || selected.some(run => !run)) problem('RETEST_SELECTION_INVALID', 'Choose between one and 100 finished runs from this execution.');
    const snapshots = [];
    for (const run of selected) {
      if (String(run.projectId) !== String(c.project.projectId) || String(run.executionIssueId) !== String(c.issue.id)) problem('RETEST_SELECTION_INVALID', 'The selected run is outside this execution.');
      const test = await resolveSubject(run.testIssueId, deps, 'TEST');
      if (test.projectId !== String(c.project.projectId)) problem('RETEST_SELECTION_INVALID', 'The selected test is unavailable or outside this project.');
      const original = await deps.readVersion(run.testVersionId);
      if (String(original?.testIssueId) !== String(test.issue.id) || String(original?.projectId) !== String(c.project.projectId)
        || !(await verifyRunProof(run, original, deps)).ok) problem('RETEST_PROOF_INVALID', 'The selected run has incomplete or invalid terminal sign-off proof.');
      if (run.planningSnapshot?.plan && deps.validateRunPlanningSnapshot) {
        const planning = await deps.validateRunPlanningSnapshot(run, original, { viewer: c.actor });
        if (planning?.ok !== true) problem('RETEST_PLANNING_UNAVAILABLE', 'The selected run\'s frozen plan or reusable preconditions could not be authorized.');
      }
      if (run.planningSnapshot?.sourceReferences?.length && deps.resolveTestSources) {
        await deps.resolveTestSources(run.planningSnapshot.sourceReferences, { projectId: c.project.projectId, viewer: c.actor });
      }
      const version = useLatestVersion ? await deps.latestSignedVersion(test.issue.id) : original;
      if (String(version?.testIssueId) !== String(test.issue.id) || String(version?.projectId) !== String(c.project.projectId)
        || !(await verifyVersionProof(version, deps)).ok) problem('VERSION_PROOF_INVALID', 'The selected test version does not have complete signed approval proof.');
      snapshots.push({ sourceRunId: run.runId, sourceDigest: run.frozenDigest, testIssueId: String(test.issue.id), testKey: test.issue.key,
        testVersionId: version.versionId, testDigest: version.digest,
        environment: run.environment ?? '', configuration: run.configuration ?? '', releaseId: run.release?.id ?? null,
        planningSnapshot: structuredClone(run.planningSnapshot ?? {}) });
    }
    return snapshots;
  }

  async function verifySnapshots(intent, c) {
    if (intent.projectId !== String(c.project.projectId) || intent.sourceExecutionIssueId !== String(c.issue.id)
      || intent.parentIssueId !== c.parent.id || intent.snapshot.executionTypeId !== String(c.project.executionTypeId)
      || intent.snapshot.runChainDigest !== chainDigest(c.project.runChain)) problem('RETEST_CONFIGURATION_CHANGED', 'The source parent or execution configuration changed. Investigate this rerun request before continuing.');
    // Repeat visibility and immutable-proof checks on every resume, before any write.
    const originals = await selectedSnapshots(c, intent.snapshot.runs.map(run => run.sourceRunId), false);
    for (const saved of intent.snapshot.runs) {
      const original = originals.find(run => run.sourceRunId === saved.sourceRunId);
      const version = await deps.readVersion(saved.testVersionId);
      if (!original || original.sourceDigest !== saved.sourceDigest || saved.testIssueId !== original.testIssueId
        || version?.digest !== saved.testDigest || String(version?.testIssueId) !== saved.testIssueId
        || !(await verifyVersionProof(version, deps)).ok) problem('RETEST_PROOF_INVALID', 'The stored rerun selection no longer has valid immutable proof.');
    }
    const holders = await deps.roleHolders({ projectId: c.project.projectId, issueTypeId: c.project.executionTypeId,
      roles: c.project.runChain.steps.map(step => step.role) });
    const preflight = chainPreflight(c.project.runChain, holders, { mustInclude: intent.actorAccountId });
    if (!preflight.ok) problem(preflight.reason, 'The current sign-off chain cannot be completed by eligible people.');
  }

  async function auditOnce(intent, eventType, payload) {
    const eventId = digestId(`${eventType}:${intent.requestId}`);
    const valid = row => row && row.eventType === eventType && row.actorAccountId === intent.actorAccountId
      && String(row.issueId) === intent.sourceExecutionIssueId && contentDigest(row.payload) === contentDigest(payload)
      && Number.isSafeInteger(row.seq) && row.seq > 0 && /^[0-9a-f]{64}$/.test(row.entryHash ?? '');
    const existing = await deps.readRetestAuditEvent(eventId);
    if (existing) { if (!valid(existing)) problem('RETEST_AUDIT_INVALID', 'The rerun audit proof conflicts with this request.'); return; }
    try {
      await deps.audit({ eventId: Buffer.from(eventId, 'hex'), eventType, actorAccountId: intent.actorAccountId,
        issueId: Number(intent.sourceExecutionIssueId), payload });
    } catch (error) {
      if (!valid(await deps.readRetestAuditEvent(eventId))) throw error;
    }
  }

  async function response(intent, extra = {}) {
    let execution = null;
    if (intent.executionIssueId) {
      const visible = await deps.readIssueAsUser(intent.executionIssueId).catch(() => null);
      if (visible && String(visible.fields?.project?.id) === intent.projectId) execution = { id: String(visible.id), key: visible.key };
    }
    return { requestId: intent.requestId, state: intent.state, complete: intent.state === 'COMPLETE', execution,
      createdRuns: (await deps.listRetestRunLinks(intent.requestId)).length, totalRuns: intent.snapshot.runs.length,
      problem: intent.lastError ?? null, ...extra };
  }

  async function change(intent, to, patch = {}) {
    await deps.transitionRetestIntent(intent.requestId, { from: intent.state, to, ...patch, now: deps.now() });
    return deps.readRetestIntent(intent.requestId);
  }

  async function reconcile(intent) {
    if (deps.now() - intent.updatedAt < RETEST_SETTLE_MS) return intent;
    let found;
    try {
      const search = await deps.searchByLabelAsApp(intent.marker);
      if (!search?.complete || search.issues.length !== 1) throw new Error('Create absence or uniqueness unproven');
      const candidate = search.issues[0], mark = await deps.readRetestMarkerAsApp(candidate.id);
      if (mark.requestId !== intent.requestId || String(mark.sourceExecutionIssueId) !== intent.sourceExecutionIssueId
        || String(mark.projectId) !== intent.projectId || String(mark.issueTypeId) !== intent.snapshot.executionTypeId
        || String(mark.parentIssueId) !== intent.parentIssueId) throw new Error('Retest marker not confirmed');
      found = candidate;
    } catch { return change(intent, 'NEEDS_REPAIR', { lastError: 'CREATE_ABSENCE_OR_IDENTITY_UNPROVEN' }); }
    return change(intent, 'ADDING_RUNS', { executionIssueId: String(found.id), executionKey: found.key, lastError: null });
  }

  async function retest({ issueKey, runIds = null, useLatestVersion = false, requestId }, actor) {
    if (!validId(requestId) || typeof useLatestVersion !== 'boolean' || (runIds != null && (!Array.isArray(runIds)
      || !runIds.length || runIds.length > RETEST_MAX_SELECTION || runIds.some(id => !validId(id)) || new Set(runIds).size !== runIds.length))) {
      problem('RETEST_SELECTION_INVALID', 'Choose finished runs and use a valid stable rerun request ID.');
    }
    const c = await context(issueKey, actor);
    const fingerprint = contentDigest({ sourceExecutionIssueId: String(c.issue.id), actorAccountId: actor.accountId,
      runIds: runIds == null ? null : [...runIds].sort(), useLatestVersion });
    let intent = await deps.readRetestIntent(requestId);
    if (!intent) {
      const runs = await selectedSnapshots(c, runIds, useLatestVersion);
      const next = { requestId, projectId: String(c.project.projectId), sourceExecutionIssueId: String(c.issue.id), sourceExecutionKey: c.issue.key,
        parentIssueId: c.parent.id, actorAccountId: actor.accountId, fingerprint, marker: `va-retest-${requestId}`,
        state: 'PREPARING', snapshot: { runs, executionTypeId: String(c.project.executionTypeId), runChainDigest: chainDigest(c.project.runChain), useLatestVersion },
        executionIssueId: null, executionKey: null, lastError: null, createdAt: deps.now(), updatedAt: deps.now() };
      await verifySnapshots(next, c);
      await deps.insertRetestIntent(next); intent = await deps.readRetestIntent(requestId);
    }
    if (!intent || intent.fingerprint !== fingerprint || intent.actorAccountId !== actor.accountId) problem('RETEST_REQUEST_CONFLICT', 'This rerun request ID already belongs to a different selection.');
    await verifySnapshots(intent, c);
    if (intent.state === 'PREPARING') {
      await auditOnce(intent, 'TM_RETEST_REQUESTED', { requestId, fingerprint, snapshot: intent.snapshot, parentIssueId: intent.parentIssueId });
      intent = await change(intent, 'PREPARED');
    }
    if (intent.state === 'PREPARED') {
      const screen = await deps.createScreenFields(intent.projectId, intent.snapshot.executionTypeId);
      if (!screen.has('labels') || !screen.has('parent')) problem('RETEST_CREATE_SCREEN_INVALID', 'The execution create screen must allow Parent and Labels before a safe rerun can be created.');
      const claimed = await deps.transitionRetestIntent(requestId, { from: 'PREPARED', to: 'CREATING', now: deps.now() });
      intent = await deps.readRetestIntent(requestId);
      if (claimed) {
        try {
          const created = await deps.createIssueAsApp({ project: { id: intent.projectId }, issuetype: { id: intent.snapshot.executionTypeId },
            summary: `Retest of ${intent.sourceExecutionKey}`, parent: { id: intent.parentIssueId }, labels: [intent.marker] },
          [{ key: RETEST_PROPERTY, value: { requestId, sourceExecutionIssueId: intent.sourceExecutionIssueId } }]);
          intent = await change(intent, 'ADDING_RUNS', { executionIssueId: String(created.id), executionKey: created.key, lastError: null });
        } catch (error) {
          intent = await change(intent, error?.status >= 400 && error?.status < 500 ? 'NEEDS_REPAIR' : 'CREATING',
            { lastError: error?.status >= 400 && error?.status < 500 ? `JIRA_REFUSED_${error.status}` : 'CREATE_ANSWER_LOST' });
          return response(intent);
        }
      }
    }
    if (intent.state === 'CREATING') intent = await reconcile(intent);
    if (intent.state !== 'ADDING_RUNS') return response(intent);
    const target = await deps.readIssueAsUser(intent.executionIssueId).catch(() => null);
    if (!target) return response(intent, { problem: 'NEW_EXECUTION_UNAVAILABLE' });
    if (String(target.fields?.project?.id) !== intent.projectId || String(target.fields?.issuetype?.id) !== intent.snapshot.executionTypeId
      || String(target.fields?.parent?.id) !== intent.parentIssueId || target.fields?.status?.statusCategory?.key === 'done') {
      return response(await change(intent, 'NEEDS_REPAIR', { lastError: 'NEW_EXECUTION_CHANGED' }));
    }
    const completed = new Set((await deps.listRetestRunLinks(requestId)).map(link => link.sourceRunId));
    const addRun = deps.addRunForRetest ?? (await import('./testExecution.js')).createTestExecution(deps).addRun;
    let added = 0;
    for (const saved of intent.snapshot.runs) {
      if (completed.has(saved.sourceRunId)) continue;
      if (added >= RETEST_FAN_OUT_BATCH) return response(intent, { problem: 'CONTINUE_RUN_CREATION' });
      try {
        // Permission is checked again between child writes; a partial fan-out remains resumable.
        await context(issueKey, actor);
        const result = await addRun({ issueKey: target.key, testKey: saved.testKey, environment: saved.environment, configuration: saved.configuration,
          releaseId: saved.releaseId, retestOf: saved.sourceRunId, testVersionId: saved.testVersionId,
          requestId: retestChildRequestId(requestId, saved.sourceRunId) }, actor, { ...saved.planningSnapshot,
          retest: { requestId, sourceExecutionIssueId: intent.sourceExecutionIssueId, sourceRunId: saved.sourceRunId, useLatestVersion } });
        const run = result?.runs?.find(run => run.retestOf === saved.sourceRunId);
        if (result?.error || !validId(run?.runId)) throw new Error('Child run proof unavailable');
        await deps.insertRetestRunLink({ requestId, sourceRunId: saved.sourceRunId, targetRunId: run.runId, now: deps.now() });
        added++;
      } catch {
        return response(await change(intent, 'ADDING_RUNS', { lastError: 'RUN_CREATION_INTERRUPTED' }));
      }
    }
    await auditOnce(intent, 'TM_RETEST_CREATED', { requestId, fingerprint, executionIssueId: intent.executionIssueId,
      sourceRunIds: intent.snapshot.runs.map(run => run.sourceRunId) });
    intent = await change(intent, 'COMPLETE', { lastError: null });
    return response(intent);
  }
  return { retest };
}

export async function retestTestExecution({ payload = {}, context }, suppliedDeps = null) {
  return tmRespond(async () => {
    const actor = actorFrom(context);
    const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
    return createTestRetest(deps).retest(payload, actor);
  });
}
