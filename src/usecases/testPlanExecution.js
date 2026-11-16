import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { contentDigest } from '../testmgmt/content.js';
import { createTestPlanning } from './testPlanning.js';
import { createTestExecution } from './testExecution.js';
import { resolveSubject, parentOf } from './testAuthoring.js';

export const PLAN_EXECUTION_MARKER_PROPERTY = 'va-tm-plan-execution';
export const PLAN_EXECUTION_SETTLE_MS = 5 * 60_000;

/** Selection is rebuilt from the signed plan on every retry; issue and run creation are idempotent. */
export function createTestPlanExecution(deps) {
  async function createFromPlan(selected, requestId, actor) {
    const { issue: plan, project } = await resolveSubject(selected.plan.issueId, deps, 'PLAN');
    if (String(project.projectId) !== String(plan.fields?.project?.id)) tmFail('PLAN_EXECUTION_SCOPE');
    const parent = parentOf(plan);
    if (!parent) tmFail('NO_PARENT');
    if (!await deps.hasIssuePermission(plan.id, 'CREATE_ISSUES')) tmFail('PLAN_EXECUTION_CREATE_PERMISSION');

    let intentId = contentDigest({ actorAccountId: actor.accountId, requestId, revisionId: selected.plan.revisionId }).slice(0, 32);
    const fingerprint = contentDigest({ projectId: String(project.projectId), planIssueId: String(plan.id), parentIssueId: parent.id,
      actorAccountId: actor.accountId, revisionId: selected.plan.revisionId, contentHash: selected.plan.digest });
    let intent = await deps.readPlanExecutionIntent(intentId);
    if (!intent) {
      intent = await deps.readPendingPlanExecutionIntent({ projectId: project.projectId, planIssueId: plan.id,
        actorAccountId: actor.accountId, revisionId: selected.plan.revisionId });
      if (intent) intentId = intent.requestId;
    }
    let inserted = false;
    if (!intent) {
      const screen = await deps.createScreenFields(project.projectId, project.executionTypeId);
      if (!screen.has('parent') || !screen.has('labels')) tmFail('PLAN_EXECUTION_CREATE_SCREEN');
      const now = deps.now();
      inserted = await deps.insertPlanExecutionIntent({ requestId: intentId, projectId: project.projectId,
        planIssueId: plan.id, parentIssueId: parent.id, actorAccountId: actor.accountId,
        revisionId: selected.plan.revisionId, fingerprint, marker: `va-plan-exec-${intentId}`, createdAt: now, updatedAt: now });
      intent = await deps.readPlanExecutionIntent(intentId);
    }
    if (!intent || intent.fingerprint !== fingerprint || intent.actorAccountId !== actor.accountId) tmFail('IDEMPOTENCY_CONFLICT');

    if (intent.state === 'CREATING' && inserted) {
      try {
        const created = await deps.createIssueAsApp({ project: { id: String(project.projectId) },
          issuetype: { id: String(project.executionTypeId) },
          summary: `Execution from ${plan.key} · revision ${selected.plan.revisionNo}`,
          parent: { id: parent.id }, labels: [intent.marker] },
        [{ key: PLAN_EXECUTION_MARKER_PROPERTY, value: { requestId: intentId, planIssueId: String(plan.id) } }]);
        await deps.transitionPlanExecutionIntent(intentId, { from: 'CREATING', to: 'READY',
          executionIssueId: created.id, executionKey: created.key, now: deps.now() });
        intent = await deps.readPlanExecutionIntent(intentId);
      } catch (error) {
        if (error?.status >= 400 && error.status < 500) {
          await deps.transitionPlanExecutionIntent(intentId, { from: 'CREATING', to: 'NEEDS_REPAIR',
            lastError: `JIRA_REFUSED_${error.status}`, now: deps.now() });
          tmFail('PLAN_EXECUTION_CREATE_REPAIR');
        }
        tmFail('PLAN_EXECUTION_CREATE_PENDING');
      }
    } else if (intent.state === 'CREATING') {
      if (deps.now() - intent.updatedAt < PLAN_EXECUTION_SETTLE_MS) tmFail('PLAN_EXECUTION_CREATE_PENDING');
      try {
        const search = await deps.searchByLabelAsApp(intent.marker);
        if (!search?.complete || search.issues.length !== 1) throw new Error('Issue creation is not uniquely confirmed');
        const candidate = search.issues[0];
        const markerProof = await deps.readPlanExecutionMarkerAsApp(candidate.id);
        if (markerProof.requestId !== intent.requestId || String(markerProof.planIssueId) !== intent.planIssueId
          || markerProof.projectId !== intent.projectId || markerProof.issueTypeId !== String(project.executionTypeId)
          || markerProof.parentIssueId !== intent.parentIssueId) throw new Error('Created execution identity does not match');
        await deps.transitionPlanExecutionIntent(intentId, { from: 'CREATING', to: 'READY',
          executionIssueId: candidate.id, executionKey: candidate.key, now: deps.now() });
        intent = await deps.readPlanExecutionIntent(intentId);
      } catch {
        await deps.transitionPlanExecutionIntent(intentId, { from: 'CREATING', to: 'NEEDS_REPAIR',
          lastError: 'CREATE_IDENTITY_UNPROVEN', now: deps.now() });
        tmFail('PLAN_EXECUTION_CREATE_UNPROVEN');
      }
    }
    if (intent.state === 'NEEDS_REPAIR') tmFail(intent.lastError === 'CREATE_IDENTITY_UNPROVEN'
      ? 'PLAN_EXECUTION_CREATE_UNPROVEN' : 'PLAN_EXECUTION_CREATE_REPAIR');
    if (!intent.executionIssueId) tmFail('PLAN_EXECUTION_CREATE_PENDING');

    const issue = await deps.readIssueAsUser(intent.executionIssueId);
    if (String(issue.fields?.project?.id) !== String(project.projectId)
      || String(issue.fields?.issuetype?.id) !== String(project.executionTypeId)
      || parentOf(issue)?.id !== parent.id) tmFail('PLAN_EXECUTION_SCOPE');
    return { issue, project, runRequestId: intentId };
  }

  async function start({ revisionId, contentHash, executionKey = '', requestId, offset = 0 }, actor) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(requestId ?? '')) || !Number.isSafeInteger(offset) || offset < 0) tmFail('INVALID_INPUT');
    const selected = await createTestPlanning(deps).selectRuns({ revisionId, contentHash }, actor);
    let issue, project, runRequestId = requestId;
    if (String(executionKey ?? '').trim()) {
      ({ issue, project } = await resolveSubject(String(executionKey).trim(), deps, 'EXECUTION'));
      if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
      if (issue.fields?.status?.statusCategory?.key === 'done') tmFail('EXECUTION_DONE');
      const plan = await deps.readIssueAsUser(selected.plan.issueId);
      if (String(plan.fields?.project?.id) !== String(project.projectId) || !parentOf(issue)
        || parentOf(issue).id !== parentOf(plan)?.id) tmFail('PLAN_EXECUTION_SCOPE');
    } else {
      ({ issue, project, runRequestId } = await createFromPlan(selected, requestId, actor));
      if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
      if (issue.fields?.status?.statusCategory?.key === 'done') tmFail('EXECUTION_DONE');
    }
    const creationKeys = new Set(selected.runs.map((_run, index) => contentDigest({ projectId: project.projectId,
      executionIssueId: String(issue.id), requestId: contentDigest({ requestId: runRequestId, index }).slice(0, 32) })));
    const existing = await deps.listRunsForExecution(issue.id);
    if (selected.runs.length + existing.filter(run => !creationKeys.has(run.creationKey)).length > 500) tmFail('PLAN_SCOPE_TOO_LARGE');
    if (offset > selected.runs.length) tmFail('INVALID_INPUT');
    const addRun = deps.addRunFromPlan ?? createTestExecution(deps).addRun;
    const end = Math.min(offset + 10, selected.runs.length);
    for (let i = offset; i < end; i++) {
      const run = selected.runs[i];
      const selection = { plan: selected.plan, preconditions: run.preconditions, required: run.required, configurationId: run.configurationId };
      await addRun({ issueKey: issue.key, testKey: run.testKey, testVersionId: run.testVersionId,
        environment: run.environment, configuration: run.configuration, releaseId: run.release?.id ?? null,
        requestId: contentDigest({ requestId: runRequestId, index: i }).slice(0, 32) }, actor, selection);
    }
    return { execution: { id: String(issue.id), key: issue.key }, complete: end === selected.runs.length,
      nextOffset: end, totalRuns: selected.runs.length, selectionDigest: selected.digest };
  }
  return { start };
}
export const startTestPlanExecution = async ({ payload = {}, context }, suppliedDeps = null) => tmRespond(async () => {
  const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
  return createTestPlanExecution(deps).start(payload, actorFrom(context));
});
