import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { contentDigest } from '../testmgmt/content.js';
import { inspectRunProof, TERMINAL_COVERAGE_STATES } from '../testmgmt/coverage.js';
import { renderExecutionSummary, summaryDigestValid } from '../testmgmt/summary.js';
import { createTestCoverage } from './testCoverage.js';
import { requestReads } from '../testmgmt/requestReads.js';

const unique = values => [...new Set(values)];
export function createTestSummary(deps) {
  async function executionContext(issueKey, actor) {
    const issue = await deps.readIssueAsUser(String(issueKey), actor);
    const projectId = String(issue?.fields?.project?.id ?? '');
    const project = await deps.readProject(projectId);
    if (!project?.enabled || String(issue.fields?.issuetype?.id) !== String(project.executionTypeId)) tmFail('NOT_AN_EXECUTION');
    return { issue, project, projectId };
  }
  async function generate({ issueKey }, actor, scoped = false) {
    if (!scoped) return createTestSummary(requestReads(deps)).generate({ issueKey }, actor, true);
    const { issue, projectId, project } = await executionContext(issueKey, actor);
    const envelope = await deps.readRunsForExecutionComplete(issue.id);
    const problems = envelope?.complete === true && Array.isArray(envelope.records) ? [] : ['RUN_LIST_INCOMPLETE'];
    const records = envelope?.records ?? [];
    if (!records.length) problems.push('NO_RUNS');
    const runs = [], coverage = [];
    const coverageService = createTestCoverage(deps);
    const tested = new Set();
    for (const run of records) {
      let test, version;
      try {
        test = await deps.readIssueAsUser(run.testIssueId, actor);
        if (String(test.fields?.project?.id) !== projectId || String(test.fields?.issuetype?.id) !== String(project.testTypeId) ||
            String(run.projectId) !== projectId || String(run.executionIssueId) !== String(issue.id)) throw new Error('scope');
        version = await deps.readVersion(run.testVersionId);
      } catch {
        problems.push('TEST_UNAVAILABLE'); runs.push({ hidden: true, problems: ['TEST_UNAVAILABLE'] }); continue;
      }
      const runProblems = await inspectRunProof(run, version, deps, actor);
      if (!TERMINAL_COVERAGE_STATES.has(run.state)) runProblems.push('RUN_NOT_TERMINAL');
      if (!version) { problems.push('TEST_VERSION_UNVERIFIABLE'); runs.push({ hidden: true, problems: ['TEST_VERSION_UNVERIFIABLE'] }); continue; }
      let sourceVisible = true;
      try { await deps.resolveTestSources(version.content.verifies ?? [], { projectId, viewer: actor }); }
      catch { sourceVisible = false; runProblems.push('SOURCE_UNAVAILABLE'); }
      const signatures = deps.listSignatures ? await deps.listSignatures('RUN', run.runId) : [];
      const notExecutedSignatures = run.state === 'NOT_EXECUTED' && deps.listSignatures ? await deps.listSignatures('RUN_NOT_EXECUTED', run.runId) : [];
      runs.push({ runId: run.runId, test: { id: String(test.id), key: test.key, summary: test.fields?.summary ?? '' },
        version: { versionId: version.versionId, versionNo: version.versionNo, digest: version.digest,
          content: { ...version.content, ...(!sourceVisible ? { verifies: [], sourcesRedacted: true } : {}) } },
        state: run.state, result: run.result, configuration: run.configuration ?? '', environment: run.environment ?? '', release: run.release ?? null,
        retestOf: run.retestOf ?? null, createdAt: run.createdAt, updatedAt: run.updatedAt,
        steps: run.steps ?? [], resolvedSteps: run.resolvedSteps ?? version.content.steps ?? [], iterations: run.iterations ?? [],
        planningSnapshot: runProblems.includes('PLANNING_PROOF_UNAVAILABLE') ? null : run.planningSnapshot ? { ...run.planningSnapshot,
          ...(!sourceVisible ? { sourceReferences: [], sourcesRedacted: true } : {}) } : null,
        planSnapshot: runProblems.includes('PLANNING_PROOF_UNAVAILABLE') ? null : run.planSnapshot ?? null,
        datasetSnapshot: run.datasetSnapshot ?? null, frozenDigest: run.frozenDigest ?? null,
        signatures, notExecutedSignatures, problems: unique(runProblems) });
      problems.push(...runProblems);
      if (!tested.has(String(test.id))) {
        tested.add(String(test.id));
        try {
          const result = await coverageService.evaluateTest(test.id, actor);
          coverage.push(...result.rows);
          if (!result.complete) problems.push('COVERAGE_INCOMPLETE');
        } catch { problems.push('COVERAGE_INCOMPLETE'); }
      }
    }
    const snapshot = structuredClone({ kind: 'TEST_EXECUTION_SUMMARY', schema: 1, generatedAt: deps.now(), generatedBy: actor.accountId,
      execution: { id: String(issue.id), key: issue.key, projectId, summary: issue.fields?.summary ?? '', status: issue.fields?.status?.name ?? '' },
      completeness: problems.length ? 'INCOMPLETE' : 'COMPLETE', problems: unique(problems), runCount: records.length, runs, coverage,
      coverageScope: 'LATEST_TERMINAL_PER_TEST_CONFIGURATION_RELEASE_ENVIRONMENT', associationStorage: 'SIGNED_TEST_SQL' });
    const record = { summaryId: deps.newHexId(), executionIssueId: String(issue.id), projectId,
      createdBy: actor.accountId, createdAt: snapshot.generatedAt, snapshot, digest: contentDigest(snapshot) };
    await deps.audit({ eventType: 'TM_EXECUTION_SUMMARY', actorAccountId: actor.accountId, issueId: Number(issue.id),
      payload: { summaryId: record.summaryId, digest: record.digest, completeness: snapshot.completeness, runCount: records.length } });
    if (!await deps.insertExecutionSummary(record)) tmFail('STALE');
    return { summaryId: record.summaryId, digest: record.digest, completeness: snapshot.completeness, snapshot, downloads: renderExecutionSummary(record) };
  }
  async function read({ summaryId }, actor) {
    const record = await deps.readExecutionSummary(summaryId);
    if (!record || !summaryDigestValid(record)) tmFail('NOT_FOUND');
    await executionContext(record.executionIssueId, actor);
    // A stored download does not grandfather visibility after Jira permissions change.
    for (const run of record.snapshot.runs) {
      if (run.hidden) continue;
      const test = await deps.readIssueAsUser(run.test.id, actor);
      if (String(test.fields?.project?.id) !== record.projectId) tmFail('NOT_FOUND');
      await deps.resolveTestSources(run.version.content.verifies ?? [], { projectId: record.projectId, viewer: actor });
      await deps.resolveTestSources(run.planningSnapshot?.sourceReferences ?? [], { projectId: record.projectId, viewer: actor });
      if (run.planningSnapshot?.plan) {
        const savedRun = await deps.readRun(run.runId);
        if (!savedRun || !deps.validateRunPlanningSnapshot) tmFail('NOT_FOUND');
        await deps.validateRunPlanningSnapshot(savedRun, await deps.readVersion(savedRun.testVersionId), { viewer: actor });
      }
    }
    for (const row of record.snapshot.coverage ?? []) {
      await deps.readIssueAsUser(row.test.id, actor);
      if (row.executionIssueId) await deps.readIssueAsUser(row.executionIssueId, actor);
      if (row.source) await deps.resolveTestSources([row.source], { projectId: record.projectId, viewer: actor });
    }
    return { summaryId: record.summaryId, digest: record.digest, completeness: record.snapshot.completeness,
      snapshot: record.snapshot, downloads: renderExecutionSummary(record) };
  }
  return { generate, read };
}
const call = fn => async ({ payload = {}, context }) => tmRespond(async () => fn(createTestSummary(await (await import('../testmgmt/runtime.js')).testManagementRuntime()), payload, actorFrom(context)));
export const generateExecutionSummary = call((uc, payload, actor) => uc.generate(payload, actor));
export const readExecutionSummary = call((uc, payload, actor) => uc.read(payload, actor));
