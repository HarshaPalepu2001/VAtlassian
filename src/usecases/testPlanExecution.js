import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { contentDigest } from '../testmgmt/content.js';
import { createTestPlanning } from './testPlanning.js';
import { createTestExecution } from './testExecution.js';
import { resolveSubject, parentOf } from './testAuthoring.js';

/** Selection is rebuilt from the signed plan on every retry; child creation is idempotent. */
export function createTestPlanExecution(deps) {
  async function start({ revisionId, contentHash, executionKey, requestId, offset = 0 }, actor) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(requestId ?? '')) || !Number.isSafeInteger(offset) || offset < 0) tmFail('INVALID_INPUT');
    const selected = await createTestPlanning(deps).selectRuns({ revisionId, contentHash }, actor);
    const { issue, project } = await resolveSubject(executionKey, deps, 'EXECUTION');
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
    if (issue.fields?.status?.statusCategory?.key === 'done') tmFail('EXECUTION_DONE');
    const plan = await deps.readIssueAsUser(selected.plan.issueId);
    if (String(plan.fields?.project?.id) !== String(project.projectId) || !parentOf(issue)
      || parentOf(issue).id !== parentOf(plan)?.id) tmFail('PLAN_EXECUTION_SCOPE');
    const creationKeys = new Set(selected.runs.map((_run, index) => contentDigest({ projectId: project.projectId,
      executionIssueId: String(issue.id), requestId: contentDigest({ requestId, index }).slice(0, 32) })));
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
        requestId: contentDigest({ requestId, index: i }).slice(0, 32) }, actor, selection);
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
