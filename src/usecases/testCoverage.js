import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { contentDigest } from '../testmgmt/content.js';
import { inspectRunProof, latestTerminalRuns, sourceChange } from '../testmgmt/coverage.js';
import { applicableSourceDecisions } from '../testmgmt/sourceDecisions.js';
import { requestReads } from '../testmgmt/requestReads.js';

const rowsEnvelope = value => value?.complete === true && Array.isArray(value.records);
const unique = values => [...new Set(values)];

export function createTestCoverage(deps) {
  async function issueContext(issueKey, expectedType = null, actor) {
    const issue = await deps.readIssueAsUser(String(issueKey), actor);
    const projectId = String(issue?.fields?.project?.id ?? '');
    const project = await deps.readProject(projectId);
    if (!project?.enabled) tmFail('NOT_ENABLED');
    if (expectedType && String(issue.fields?.issuetype?.id) !== String(project[expectedType])) tmFail('NOT_FOUND');
    return { issue, projectId, project };
  }

  async function evaluateTest(testIssueId, actor, options = {}, scoped = false) {
    if (!scoped) return createTestCoverage(requestReads(deps)).evaluateTest(testIssueId, actor, options, true);
    const { issue, projectId, project } = await issueContext(testIssueId, 'testTypeId', actor);
    const [latest, envelope] = await Promise.all([deps.latestSignedVersion(issue.id),
      options.runs ? Promise.resolve(options.runs) : deps.readRunsForTestComplete(issue.id)]);
    const complete = rowsEnvelope(envelope);
    const problems = complete ? [] : ['RUN_LIST_INCOMPLETE'];
    const terminal = latestTerminalRuns(envelope?.records ?? []);
    const rows = [];
    if (!latest) return { test: { id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '' }, rows: [], complete, problems: [...problems, 'NO_SIGNED_VERSION'] };
    let currentSources = [], sourcesAvailable = true;
    try { currentSources = await deps.resolveTestSources(latest.content.verifies ?? [], { projectId, viewer: actor }); }
    catch { sourcesAvailable = false; problems.push('SOURCE_UNAVAILABLE'); }
    let jiraLinksProven = false;
    if (latest.content.verifies?.length) {
      try { jiraLinksProven = !!deps.verifySourceLinkProjection && (await deps.verifySourceLinkProjection(latest, actor))?.ok === true; }
      catch { jiraLinksProven = false; }
    }
    let draftChanged = false;
    if (deps.readDraft) {
      const draft = await deps.readDraft(issue.id);
      // Compare the full editable definition, including datasets and actions, to the signed version.
      if (draft?.content) {
        const definition = content => Object.fromEntries(Object.keys(draft.content).map(key => [key,
          key === 'verifies' ? (content.verifies ?? []).map(ref => ({ issueId: String(ref.issueId) })).sort((a, b) => a.issueId.localeCompare(b.issueId))
            : content[key] ?? null]));
        draftChanged = contentDigest(definition(draft.content)) !== contentDigest(definition(latest.content));
      }
    }
    const candidates = terminal.length ? terminal : [{ runId: null, testIssueId: String(issue.id), projectId,
      testVersionId: latest.versionId, testDigest: latest.digest, state: 'NO_RUN', result: 'NOT_RUN',
      configuration: '', environment: '', release: null }];
    for (const run of candidates) {
      const runProblems = [...problems];
      let version = run.runId ? null : latest;
      if (String(run.testIssueId) !== String(issue.id) || String(run.projectId) !== projectId) runProblems.push('RUN_SCOPE_MISMATCH');
      try { if (run.runId) {
        const execution = await deps.readIssueAsUser(run.executionIssueId, actor);
        if (String(execution.fields?.project?.id) !== projectId || String(execution.fields?.issuetype?.id) !== String(project.executionTypeId)) runProblems.push('EXECUTION_UNAVAILABLE');
        version = await deps.readVersion(run.testVersionId);
      }
      } catch { runProblems.push('EXECUTION_UNAVAILABLE'); }
      if (run.runId) runProblems.push(...await inspectRunProof(run, version, deps, actor));
      if (run.testVersionId !== latest.versionId || run.testDigest !== latest.digest || draftChanged) runProblems.push('TEST_CHANGED');
      const pins = version?.content?.verifies ?? [];
      // Hidden sources never appear in the response, including in pinned historical data.
      const safeSources = sourcesAvailable ? pins : [null];
      for (const pinned of safeSources.length ? safeSources : [null]) {
        const current = pinned ? currentSources.find(ref => ref.issueId === pinned.issueId) : null;
        const changed = pinned ? sourceChange(pinned, current) : sourcesAvailable ? 'NO_SOURCE_ASSOCIATION' : 'SOURCE_UNAVAILABLE';
        let review = null, applicability = null, decisionProblem = null;
        if (changed === 'SOURCE_CHANGED' && current && pinned && version && deps.readSourceDecisionsForTestComplete) {
          try {
            const history = await deps.readSourceDecisionsForTestComplete(issue.id);
            if (!history.complete) decisionProblem = 'DECISION_HISTORY_INCOMPLETE';
            else ({ review, applicability } = await applicableSourceDecisions(history.records, { version, pinned, current, run }, deps));
          } catch { decisionProblem = 'DECISION_HISTORY_INCOMPLETE'; }
        }
        let sourceProblem = changed;
        if (changed === 'SOURCE_CHANGED' && review?.content.decision === 'FITS') {
          const runSource = (run.planningSnapshot?.sourceReferences ?? []).find(ref => ref.issueId === pinned.issueId);
          sourceProblem = applicability || runSource && !sourceChange(runSource, current) ? null : 'NEW_RUN_OR_APPLICABILITY_REQUIRED';
        }
        const reasons = unique([...runProblems, ...(sourceProblem ? [sourceProblem] : []), ...(decisionProblem ? [decisionProblem] : [])]);
        let operational = 'UNKNOWN', governed = 'UNKNOWN';
        if (!reasons.length) {
          operational = run.state === 'SIGNED' && (run.result === 'PASSED' || (run.result === 'PARTLY_PASSED' && project.partlyPassedCounts === true)) ? 'VERIFIED'
            : run.state === 'SIGNED' && run.result === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'NOT_VERIFIED';
          governed = current?.governedReady && pinned?.baseline ? operational : 'UNKNOWN';
        } else if (reasons.every(reason => ['NO_SOURCE_ASSOCIATION'].includes(reason))) {
          operational = run.state === 'SIGNED' && run.result === 'PASSED' ? 'VERIFIED' : 'NOT_VERIFIED';
        }
        rows.push({ test: { id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '' },
          source: current ? { issueId: current.issueId, issueKey: current.issueKey, projectId: current.projectId, siteId: current.siteId,
            baseline: current.baseline, sourceDigest: current.sourceDigest } : null,
          runId: run.runId, executionIssueId: run.executionIssueId == null ? null : String(run.executionIssueId), testVersionId: run.testVersionId,
          configuration: run.configuration ?? '', environment: run.environment ?? '', release: run.release ?? null,
          state: run.state, result: run.result, operational, governed: jiraLinksProven ? governed : 'UNKNOWN',
          suspect: reasons.some(reason => ['SOURCE_CHANGED', 'SOURCE_DRIFT', 'TEST_CHANGED'].includes(reason)),
          suspectReviewDecisionId: review?.decisionId ?? null, applicabilityDecisionId: applicability?.decisionId ?? null,
          reasons: [...reasons, ...(pinned && !jiraLinksProven ? ['SOURCE_LINK_PROOF_UNAVAILABLE'] : [])] });
      }
    }
    return { test: { id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '' }, rows,
      complete: complete && sourcesAvailable && rows.every(row => !row.reasons.length || row.reasons.every(r => r === 'NO_SOURCE_ASSOCIATION')),
      problems: unique([...problems, ...rows.flatMap(row => row.reasons)]) };
  }

  async function forTest({ issueKey }, actor) {
    const result = await evaluateTest(issueKey, actor);
    return { scope: 'TEST', issue: result.test, rows: result.rows, complete: result.complete, problems: result.problems };
  }

  async function forSource({ issueKey }, actor, scoped = false) {
    if (!scoped) return createTestCoverage(requestReads(deps)).forSource({ issueKey }, actor, true);
    const { issue, projectId } = await issueContext(issueKey, null, actor);
    const associations = await deps.readTestsForSource(issue.id, { projectId });
    const rows = [], problems = rowsEnvelope(associations) ? [] : ['SOURCE_ASSOCIATIONS_INCOMPLETE'];
    let complete = rowsEnvelope(associations);
    for (const testIssueId of unique((associations?.records ?? []).map(record => String(record.testIssueId)))) {
      try {
        const result = await evaluateTest(testIssueId, actor, {}, true);
        rows.push(...result.rows.filter(row => row.source?.issueId === String(issue.id)));
        if (!result.complete) complete = false;
        problems.push(...result.problems);
      } catch { complete = false; problems.push('TEST_UNAVAILABLE'); }
    }
    return { scope: 'SOURCE', issue: { id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '' },
      rows, complete, problems: unique(problems), associationStorage: 'SIGNED_TEST_SQL' };
  }
  return { forTest, forSource, evaluateTest };
}
const call = fn => async ({ payload = {}, context }) => tmRespond(async () => fn(createTestCoverage(await (await import('../testmgmt/runtime.js')).testManagementRuntime()), payload, actorFrom(context)));
export const getTestCoverage = call((uc, payload, actor) => uc.forTest(payload, actor));
export const getSourceCoverage = call((uc, payload, actor) => uc.forSource(payload, actor));

const sourceDecisionCall = fn => async ({ payload = {}, context }) => tmRespond(async () => {
  const { createSourceDecisions } = await import('../testmgmt/sourceDecisions.js');
  return fn(createSourceDecisions(await (await import('../testmgmt/runtime.js')).testManagementRuntime()), payload, actorFrom(context));
});
export const prepareSourceDecision = sourceDecisionCall((uc, payload, actor) => uc.prepare(payload, actor));
export const signSourceDecision = sourceDecisionCall((uc, payload, actor) => uc.sign(payload, actor));
export const finishSourceDecision = sourceDecisionCall((uc, payload, actor) => uc.finish(payload, actor));
export const getSourceDecision = sourceDecisionCall((uc, payload, actor) => uc.view(payload, actor));
export const listSourceDecisions = sourceDecisionCall((uc, payload, actor) => uc.listForTest(payload.issueKey, actor));

export async function resolveTestSourceSelection({ payload = {}, context }, suppliedDeps = null) {
  return tmRespond(async () => {
    const actor = actorFrom(context);
    const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
    const { resolveSubject } = await import('./testAuthoring.js');
    const { projectId } = await resolveSubject(payload.issueKey, deps, 'TEST');
    const source = await deps.readIssueAsUser(String(payload.sourceKey ?? '').trim());
    return { sources: await deps.resolveTestSources([{ issueId: String(source.id) }], { projectId, viewer: actor }) };
  });
}
