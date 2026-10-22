/**
 * TEST EXECUTION — runs of signed test versions, recorded step by step and
 * closed by the project's sign-off chain.
 *
 * Every run pins the signed test version, the run sign-off chain in force, the
 * environment, configuration and release. Results are recorded only while the
 * run is IN_PROGRESS; the first sign-off freezes them (SIGNING) and every later
 * step signs the same frozen digest. A run ends SIGNED, REJECTED or
 * NOT_EXECUTED and never changes again: a retest is a new run.
 */
import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { runSteps, runContent, contentDigest } from '../testmgmt/content.js';
import { runResult, signabilityProblem, isStepStatus, RESULT } from '../testmgmt/results.js';
import { chainDigest, chainPreflight, chainPosition, separationProblem } from '../testmgmt/chain.js';
import { resolveSubject, parentOf } from './testAuthoring.js';
import { createRunSigning } from './testRunSigning.js';
import { expandDatasetSteps } from '../testmgmt/planning.js';
import { verifyVersionProof, verifyRunProof } from '../testmgmt/proof.js';
import { requestReads } from '../testmgmt/requestReads.js';

const MAX_LABEL = 255;
const isDone = (issue) => String(issue?.fields?.status?.statusCategory?.key ?? '').toLowerCase() === 'done';

export function computedResult(steps) {
  return runResult([{ steps: steps.map(s => s.status) }]);
}

/** The digest a signer is shown: frozen once signing started, live before. */
export function runDigest(run, steps) {
  return run.frozenDigest ?? contentDigest(runContent(run, steps, computedResult(steps)));
}

export function createTestExecution(deps) {
  async function execution(issueKey) {
    const subject = await resolveSubject(issueKey, deps, 'EXECUTION');
    return subject;
  }

  async function view(issueKey, actor, scoped = false) {
    if (!scoped) return createTestExecution(requestReads(deps)).view(issueKey, actor, true);
    const { issue, project } = await execution(issueKey);
    const [runs, canEdit, releases] = await Promise.all([
      deps.listRunsForExecution(issue.id), deps.hasIssuePermission(issue.id, 'EDIT_ISSUES'),
      deps.projectVersions(project.projectId).catch(() => [])
    ]);
    const runIds = runs.map(r => r.runId);
    const [versions, signed, closed, bugs] = await Promise.all([
      deps.readVersions(runs.map(r => r.testVersionId)), deps.listSignaturesFor('RUN', runIds),
      deps.listSignaturesFor('RUN_NOT_EXECUTED', runIds), deps.listBugsFor(runIds)
    ]);
    const versionById = new Map(versions.map(v => [v.versionId, v]));
    // A test the viewer cannot open in Jira stays closed here too: its run
    // shows its state and sign-offs, never the test's steps, preconditions or
    // the results recorded against them. Unreadable counts as hidden.
    const tests = new Map();
    for (const testId of new Set(runs.map(r => r.testIssueId))) {
      tests.set(testId, await deps.readIssueAsUser(testId).catch(() => null));
    }
    const out = [];
    for (const run of runs) {
      const version = versionById.get(run.testVersionId);
      const definition = run.resolvedSteps ?? version?.content?.steps ?? [];
      const steps = runSteps(definition, run.steps);
      const own = signed.filter(s => s.subjectId === run.runId);
      const position = chainPosition(run.chain, own);
      const pending = await deps.hasPendingSignatures('RUN', run.runId) || await deps.hasPendingSignatures('RUN_NOT_EXECUTED', run.runId);
      const test = tests.get(run.testIssueId);
      const hidden = !test;
      let planningVisible = !hidden;
      if (planningVisible && run.planningSnapshot?.plan && deps.validateRunPlanningSnapshot) {
        try { await deps.validateRunPlanningSnapshot(run, version, { viewer: actor }); }
        catch { planningVisible = false; }
      }
      let sourcesVisible = !hidden;
      if (sourcesVisible && run.planningSnapshot?.sourceReferences?.length && deps.resolveTestSources) {
        try { await deps.resolveTestSources(run.planningSnapshot.sourceReferences, { projectId: project.projectId, viewer: actor }); }
        catch { sourcesVisible = false; }
      }
      let canSign = false;
      const nextRole = run.state === 'IN_PROGRESS' ? run.chain.steps[0].role
        : run.state === 'SIGNING' && position.next != null ? position.step.role : null;
      if (nextRole && !hidden && planningVisible && sourcesVisible && !pending) {
        canSign = !separationProblem(run.chain, own, actor.accountId)
          && await deps.isEligibleFor({ accountId: actor.accountId, projectId: project.projectId,
            issueTypeId: issue.fields?.issuetype?.id, role: nextRole });
      }
      const result = computedResult(steps);
      const bug = bugs.find(b => b.runId === run.runId) ?? null;
      out.push({
        runId: run.runId, state: run.state, result, revision: run.revision,
        test: { id: run.testIssueId, key: test?.key ?? null, summary: test?.fields?.summary ?? null, hidden },
        version: { versionId: run.testVersionId, versionNo: version?.versionNo ?? null, digest: run.testDigest },
        environment: run.environment, configuration: run.configuration, release: run.release,
        retestOf: run.retestOf, createdBy: run.createdBy, createdAt: run.createdAt,
        iterations: hidden ? [] : run.iterations ?? [{ id: 'default', values: {} }],
        planningSnapshot: !planningVisible ? null : run.planningSnapshot ? { ...run.planningSnapshot,
          ...(!sourcesVisible ? { sourceReferences: [], sourcesRedacted: true } : {}) } : null,
        steps: hidden ? [] : steps.map((s, i) => ({ ...s, position: i + 1, action: definition[i]?.action ?? '',
          data: definition[i]?.data ?? '', expected: definition[i]?.expected ?? '' })),
        preconditions: hidden ? '' : version?.content?.preconditions ?? '',
        contentHash: runDigest(run, steps), signabilityProblem: run.state === 'IN_PROGRESS' ? signabilityProblem(steps) : null,
        chain: run.chain, signatures: own.map(s => ({ stepIndex: s.step_index, label: s.label, role: s.role,
          decision: s.decision, printedName: s.printedName, signedAt: s.signedAt, reason: s.reason, meaning: s.meaning,
          assuranceLevel: s.assuranceLevel, contentHash: s.contentHash })),
        notExecuted: closed.find(s => s.subjectId === run.runId) ?? null,
        nextStep: run.state === 'IN_PROGRESS' ? { index: 0, ...run.chain.steps[0] }
          : position.next != null && run.state === 'SIGNING' ? { index: position.next, ...position.step } : null,
        canSign, bug,
        // Signed off, but its outcome or its bug was not written: the panel
        // offers to finish it (retryBug).
        canFinish: (['CREATING', 'SIGNING', 'CLOSING'].includes(run.state) && (pending || position.complete || position.rejected || ['CREATING', 'CLOSING'].includes(run.state)))
          || (run.state === 'SIGNED' && result === RESULT.FAILED && !['CREATED', 'NEEDS_REPAIR'].includes(bug?.state))
      });
    }
    return {
      role: 'EXECUTION', issue: { id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '',
        status: issue.fields?.status?.name ?? '', done: isDone(issue) },
      parent: parentOf(issue), canEdit, releases,
      attachments: (issue.fields?.attachment ?? []).map(a => ({ id: String(a.id), filename: a.filename, size: a.size })),
      runChain: project.runChain, runs: out
    };
  }

  async function addRun({ issueKey, testKey, environment = '', configuration = '', releaseId = null, retestOf = null, testVersionId = null, requestId = null }, actor, selection = null) {
    const { issue, project } = await execution(issueKey);
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
    if (isDone(issue)) tmFail('EXECUTION_DONE');
    if (!parentOf(issue)) tmFail('NO_PARENT');
    if (String(environment).length > MAX_LABEL || String(configuration).length > MAX_LABEL) tmFail('INVALID_INPUT');
    const test = await resolveSubject(String(testKey ?? '').trim(), deps, 'TEST');
    if (test.projectId !== project.projectId) tmFail('NOT_A_TEST');
    if (!parentOf(test.issue)) tmFail('NO_PARENT');
    if (requestId != null && !/^[a-zA-Z0-9_-]{8,100}$/.test(String(requestId))) tmFail('INVALID_INPUT');
    const creationKey = requestId ? contentDigest({ projectId: project.projectId, executionIssueId: String(issue.id), requestId }) : null;
    const creationFingerprint = contentDigest({ testIssueId: String(test.issue.id), environment: String(environment).trim(), configuration: String(configuration).trim(),
      releaseId: releaseId == null ? null : String(releaseId), retestOf, testVersionId, selection });
    if (creationKey) {
      const prior = await deps.readRunByCreationKey(creationKey);
      if (prior) {
        if (prior.creationFingerprint !== creationFingerprint) tmFail('IDEMPOTENCY_CONFLICT');
        if (prior.state === 'CREATING') await deps.activateRunCreation(prior.runId);
        return view(issueKey, actor);
      }
    }
    if ((await deps.listRunsForExecution(issue.id)).length >= 500) tmFail('PLAN_SCOPE_TOO_LARGE');
    const version = testVersionId ? await deps.readVersion(testVersionId) : await deps.latestSignedVersion(test.issue.id);
    if (!version) tmFail('NO_SIGNED_VERSION');
    if (version.testIssueId !== String(test.issue.id) || !(await verifyVersionProof(version, deps)).ok) tmFail('VERSION_PROOF_INVALID');
    const chain = project.runChain;
    const holders = await deps.roleHolders({ projectId: project.projectId, issueTypeId: issue.fields?.issuetype?.id,
      roles: chain.steps.map(s => s.role) });
    const preflight = chainPreflight(chain, holders, { mustInclude: actor.accountId });
    if (!preflight.ok) tmFail(preflight.reason);
    let previousRun = null;
    if (retestOf) {
      previousRun = await deps.readRun(retestOf);
      if (!previousRun || previousRun.testIssueId !== String(test.issue.id) || previousRun.projectId !== project.projectId
        || !(await verifyRunProof(previousRun, await deps.readVersion(previousRun.testVersionId), deps)).ok) tmFail('INVALID_INPUT');
      const previousExecution = await execution(previousRun.executionIssueId);
      if (previousExecution.projectId !== project.projectId) tmFail('INVALID_INPUT');
    }
    let release = null;
    if (releaseId) {
      release = (await deps.projectVersions(project.projectId)).find(v => v.id === String(releaseId)) ?? null;
      // A rerun may retain an archived release, using only the authorized original's immutable snapshot.
      if (!release && previousRun?.release?.id === String(releaseId)) release = previousRun.release;
      if (!release) tmFail('INVALID_INPUT');
    }
    const expanded = expandDatasetSteps(version.content);
    if (expanded.error) tmFail('INVALID_INPUT');
    const steps = runSteps(expanded.steps, []);
    const sourceReferences = version.content.verifies?.length ? await deps.resolveTestSources(version.content.verifies, { projectId: project.projectId, viewer: actor }) : [];
    const planningSnapshot = { ...(selection ?? {}), datasetDigest: expanded.digest, sourceReferences };
    const iterations = expanded.iterations.map(it => ({ id: it.id, values: it.values, stepIds: it.steps.map(s => s.id) }));
    const run = { runId: deps.newHexId(), executionIssueId: String(issue.id), projectId: project.projectId,
      testIssueId: String(test.issue.id), testVersionId: version.versionId, testDigest: version.digest,
      environment: String(environment).trim(), configuration: String(configuration).trim(),
      resolvedSteps: expanded.steps, iterations, planningSnapshot,
      creationKey, creationFingerprint, creationEventId: deps.newHexId(),
      release: release ? { id: release.id, name: release.name } : null, chain, chainDigest: chainDigest(chain),
      result: RESULT.NOT_RUN, steps, retestOf: retestOf || null, createdBy: actor.accountId, createdAt: deps.now() };
    if (Buffer.byteLength(JSON.stringify(run)) > 384 * 1024) tmFail('RUN_TOO_LARGE');
    if (!await deps.insertRun(run)) {
      const prior = creationKey ? await deps.readRunByCreationKey(creationKey) : null;
      if (!prior || prior.creationFingerprint !== creationFingerprint) tmFail('IDEMPOTENCY_CONFLICT');
      return view(issueKey, actor);
    }
    try {
      await deps.audit({ eventId: Buffer.from(run.creationEventId, 'hex'), eventType: 'TM_RUN_CREATED', actorAccountId: actor.accountId, issueId: Number(issue.id),
        payload: { runId: run.runId, testIssueId: run.testIssueId, testKey: test.issue.key, versionId: version.versionId,
          versionNo: version.versionNo, testDigest: version.digest, chainDigest: run.chainDigest,
          environment: run.environment, configuration: run.configuration, release: run.release, retestOf: run.retestOf,
          creationFingerprint } });
    } catch {
      await deps.deleteRun(run.runId).catch(() => {});
      tmFail('LEDGER_UNAVAILABLE');
    }
    await deps.activateRunCreation(run.runId);
    return view(issueKey, actor);
  }

  /** The run, its execution as the viewer sees it, and the right to change results. */
  async function openRun(runId) {
    const run = await deps.readRun(runId);
    if (!run) tmFail('NOT_FOUND');
    const { issue } = await execution(run.executionIssueId);
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
    if (run.state !== 'IN_PROGRESS') tmFail('RUN_NOT_OPEN');
    if (isDone(issue)) tmFail('EXECUTION_DONE');
    // Results are recorded only by someone who can open the test in Jira.
    await deps.readIssueAsUser(run.testIssueId);
    const version = await deps.readVersion(run.testVersionId);
    return { run, issue, version };
  }

  async function saveSteps(run, issue, steps, actor, event) {
    const ok = await deps.updateRunSteps({ runId: run.runId, expectedRevision: run.revision, steps,
      result: computedResult(steps), now: deps.now() });
    if (!ok) tmFail('STALE');
    await deps.tryAudit({ eventType: 'TM_STEP_RECORDED', actorAccountId: actor.accountId, issueId: Number(issue.id),
      payload: { runId: run.runId, ...event } });
    return view(issue.key, actor);
  }

  async function recordStep({ runId, expectedRevision, stepId, status, actual = '', comment = '' }, actor) {
    const { run, issue, version } = await openRun(runId);
    if (run.revision !== Number(expectedRevision)) tmFail('STALE');
    if (!isStepStatus(status)) tmFail('INVALID_INPUT');
    const steps = runSteps(run.resolvedSteps ?? version.content.steps, run.steps);
    const step = steps.find(s => s.id === stepId);
    if (!step) tmFail('INVALID_INPUT');
    if (String(actual).length > 4000 || String(comment).length > 4000) tmFail('INVALID_INPUT');
    const before = step.status;
    Object.assign(step, { status, actual: String(actual), comment: String(comment), recordedBy: actor.accountId, recordedAt: deps.now() });
    return saveSteps(run, issue, steps, actor, { stepId, from: before, to: status });
  }

  async function attachEvidence({ runId, expectedRevision, stepId, attachmentId }, actor) {
    const { run, issue, version } = await openRun(runId);
    if (run.revision !== Number(expectedRevision)) tmFail('STALE');
    const attachment = (issue.fields?.attachment ?? []).find(a => String(a.id) === String(attachmentId));
    if (!attachment) tmFail('EVIDENCE_NOT_ON_EXECUTION');
    const steps = runSteps(run.resolvedSteps ?? version.content.steps, run.steps);
    const step = steps.find(s => s.id === stepId);
    if (!step) tmFail('INVALID_INPUT');
    if (step.evidence.some(e => String(e.attachmentId) === String(attachmentId))) return view(issue.key, actor);
    const retained = await deps.retainEvidence({ attachment, issueId: issue.id, viewer: actor.accountId });
    step.evidence = [...step.evidence, { ...retained,
      addedBy: actor.accountId, addedAt: deps.now() }];
    return saveSteps(run, issue, steps, actor, { stepId, evidenceAdded: { attachmentId: String(attachment.id), sha256: retained.sha256, size: retained.size } });
  }

  async function removeEvidence({ runId, expectedRevision, stepId, attachmentId }, actor) {
    const { run, issue, version } = await openRun(runId);
    if (run.revision !== Number(expectedRevision)) tmFail('STALE');
    const steps = runSteps(run.resolvedSteps ?? version.content.steps, run.steps);
    const step = steps.find(s => s.id === stepId);
    if (!step) tmFail('INVALID_INPUT');
    step.evidence = step.evidence.filter(e => String(e.attachmentId) !== String(attachmentId));
    return saveSteps(run, issue, steps, actor, { stepId, evidenceRemoved: String(attachmentId) });
  }

  const signing = createRunSigning(deps, { execution, view, isDone });
  return { view, addRun, recordStep, attachEvidence, removeEvidence, ...signing };
}

async function runtime() {
  return (await import('../testmgmt/runtime.js')).testManagementRuntime();
}

const call = (fn) => async ({ payload = {}, context }) => tmRespond(async () => {
  const actor = actorFrom(context);
  return fn(createTestExecution(await runtime()), payload, actor);
});

export const getExecution = call((uc, p, actor) => uc.view(p.issueKey, actor));
export const addTestRun = call((uc, p, actor) => uc.addRun(p, actor));
export const recordRunStep = call((uc, p, actor) => uc.recordStep(p, actor));
export const attachRunEvidence = call((uc, p, actor) => uc.attachEvidence(p, actor));
export const removeRunEvidence = call((uc, p, actor) => uc.removeEvidence(p, actor));
export const signTestRun = call((uc, p, actor) => uc.signRun(p, actor));
export const closeRunNotExecuted = call((uc, p, actor) => uc.closeNotExecuted(p, actor));
export const retryRunBug = call((uc, p, actor) => uc.retryBug(p, actor));
