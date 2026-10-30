/**
 * Run sign-off follows the configured chain without exceptions (owner decision 4).
 *
 * Step 0 ("Executed by" by default) freezes the results: the run moves
 * IN_PROGRESS → SIGNING by a compare-and-swap on the revision the signer was
 * shown, so a result recorded a moment earlier makes the signature fail as
 * CONTENT_CHANGED instead of covering content the signer never saw. Every later
 * step signs the same frozen digest. The last step makes the run SIGNED; a
 * rejection makes it REJECTED. A fully signed Failed run gets its bug.
 *
 * A recorded signature stands, whatever happens after it. Applying the
 * chain's outcome and creating the bug (settle) is safe to repeat, so a run
 * whose outcome or bug was not written is finished from the panel, never left
 * signed with nothing anyone can do.
 */
import { tmFail } from '../testmgmt/messages.js';
import { runSteps, runContent, contentDigest } from '../testmgmt/content.js';
import { signabilityProblem, runResult } from '../testmgmt/results.js';
import { chainPosition, separationProblem } from '../testmgmt/chain.js';
import { ensureBug, bugDescription } from '../testmgmt/bug.js';
import { parentOf } from './testAuthoring.js';

export function createRunSigning(deps, { execution, view, isDone }) {
  async function context(runId) {
    let run = await deps.readRun(runId);
    if (!run) tmFail('NOT_FOUND');
    // Nothing is signed over a step change that is not yet in the audit chain.
    if (run.stepEventId) {
      if (!await deps.settleRunSteps(runId, { now: deps.now() })) tmFail('RESULT_PENDING');
      run = await deps.readRun(runId);
    }
    const { issue, project } = await execution(run.executionIssueId);
    // Nobody signs or closes a run of a test they cannot open in Jira.
    await deps.readIssueAsUser(run.testIssueId);
    const version = await deps.readVersion(run.testVersionId);
    if (!version || version.digest !== run.testDigest || contentDigest(version.content) !== version.digest) tmFail('CONTENT_CHANGED');
    const steps = runSteps(run.resolvedSteps ?? version.content.steps, run.steps);
    const result = runResultOf(steps);
    return { run, issue, project, version, steps, result, digest: contentDigest(runContent(run, steps, result)) };
  }

  async function signer(actor) {
    const me = await deps.myself();
    return { accountId: actor.accountId, displayName: me?.displayName ?? actor.accountId };
  }

  async function authorizeFrozenInputs(c, actor) {
    if (c.run.planningSnapshot?.plan) {
      if (!deps.validateRunPlanningSnapshot) tmFail('PLANNING_PROOF_UNAVAILABLE');
      await deps.validateRunPlanningSnapshot(c.run, c.version, { viewer: actor });
    }
    const refs = c.run.planningSnapshot?.sourceReferences ?? c.version.content.verifies ?? [];
    if (refs.length) await deps.resolveTestSources(refs, { projectId: c.project.projectId, viewer: actor });
  }

  async function signRun({ runId, code, contentHash, decision = 'SIGN', reason = null }, actor) {
    if (!['SIGN', 'REJECT'].includes(decision)) tmFail('INVALID_INPUT');
    const c = await context(runId);
    const { run, issue, project } = c;
    await authorizeFrozenInputs(c, actor);
    if (decision === 'SIGN') await deps.verifyEvidence(c.steps.flatMap(step => step.evidence ?? []));
    const signatures = await deps.listSignatures('RUN', runId);
    if (await deps.hasPendingSignatures('RUN', runId)) tmFail('SIGNATURE_PENDING');
    let stepIndex;
    if (run.state === 'IN_PROGRESS') {
      if (decision !== 'SIGN') tmFail('INVALID_INPUT');
      if (isDone(issue)) tmFail('EXECUTION_DONE');
      const problem = signabilityProblem(c.steps);
      if (problem) tmFail(problem);
      // Attribution (spec, settled item 7): "Executed by" is signed by someone
      // who recorded results in this run.
      if (!c.steps.some(s => s.recordedBy === actor.accountId)) tmFail('NOT_A_RECORDER');
      if (contentHash !== c.digest) tmFail('CONTENT_CHANGED');
      stepIndex = 0;
    } else if (run.state === 'SIGNING') {
      const position = chainPosition(run.chain, signatures);
      if (position.next == null) tmFail('RUN_NOT_SIGNING');
      // The frozen digest is what everyone after step 0 signs, and the stored
      // rows must still produce it.
      if (c.digest !== run.frozenDigest || contentHash !== run.frozenDigest) tmFail('CONTENT_CHANGED');
      stepIndex = position.next;
    } else tmFail('RUN_NOT_SIGNING');
    const step = run.chain.steps[stepIndex];
    if (!await deps.isEligibleFor({ accountId: actor.accountId, projectId: project.projectId,
      issueTypeId: issue.fields?.issuetype?.id, role: step.role })) tmFail('NOT_ELIGIBLE');
    const separation = separationProblem(run.chain, signatures, actor.accountId);
    if (separation) tmFail(separation);
    if (decision === 'REJECT' && !String(reason ?? '').trim()) tmFail('REASON_REQUIRED');

    if (stepIndex === 0 && !c.steps.some(s => s.recordedBy === actor.accountId)) tmFail('NOT_A_RECORDER');
    if (stepIndex === 0 && run.state === 'IN_PROGRESS') {
      const frozen = await deps.setRunState({ runId, from: 'IN_PROGRESS', to: 'SIGNING', expectedRevision: run.revision,
        frozenDigest: c.digest, now: deps.now() });
      if (!frozen) tmFail('CONTENT_CHANGED');
    }
    const recorded = await deps.recordSignature({ kind: 'RUN', subjectId: runId, stepIndex, step,
      signer: await signer(actor), decision, reason: decision === 'REJECT' ? String(reason).trim() : null,
      contentHash: c.digest, code, issueId: issue.id,
      payload: { result: c.result, testIssueId: run.testIssueId, versionId: run.testVersionId } }, deps);
    if (!recorded.ok) {
      if (stepIndex === 0) await deps.unfreezeRun({ runId, from: 'SIGNING', now: deps.now() }).catch(() => {});
      if (recorded.message) return { error: recorded.message, reason: recorded.reason };
      tmFail(recorded.reason);
    }
    if (decision === 'REJECT' || stepIndex === run.chain.steps.length - 1) {
      // The signature is recorded. A failure from here on leaves the run for
      // the panel's finish button (retryBug), not an error for the signer.
      await settle(runId).catch(error => console.error('tm: run not settled', { runId, reason: error?.reason ?? error?.message }));
    }
    return view(issue.key, actor);
  }

  /**
   * Apply the chain's outcome to the run, then a fully signed Failed run's
   * bug. Every write is a compare-and-swap and the bug is exactly-once, so
   * this is safe to repeat.
   */
  async function settle(runId) {
    const c = await context(runId);
    let run = c.run;
    if (run.state === 'CLOSING') {
      const closures = await deps.listSignatures('RUN_NOT_EXECUTED', runId);
      if (closures.length === 1 && closures[0].decision === 'NOT_EXECUTED' && closures[0].contentHash === run.frozenDigest) {
        await deps.setRunState({ runId, from: 'CLOSING', to: 'NOT_EXECUTED', expectedRevision: run.revision, now: deps.now() });
      } else if (!await deps.hasPendingSignatures('RUN_NOT_EXECUTED', runId)) {
        await deps.unfreezeRun({ runId, from: 'CLOSING', now: deps.now() });
      }
      return;
    }
    if (run.state === 'SIGNING') {
      const position = chainPosition(run.chain, await deps.listSignatures('RUN', runId));
      if (position.complete || position.rejected) {
        const to = position.rejected ? 'REJECTED' : 'SIGNED';
        const moved = await deps.setRunState({ runId, from: 'SIGNING', to, expectedRevision: run.revision, now: deps.now() });
        run = moved ? { ...run, state: to, revision: run.revision + 1 } : (await deps.readRun(runId)) ?? run;
      }
    }
    if (run.state !== 'SIGNED' || c.result !== 'FAILED') return;
    const bug = await deps.readBug(runId);
    if (bug?.state === 'CREATED' || bug?.state === 'NEEDS_REPAIR') return;
    await createBug({ ...c, run });
  }

  async function closeNotExecuted({ runId, code, reason }, actor) {
    const c = await context(runId);
    const { run, issue, project } = c;
    await authorizeFrozenInputs(c, actor);
    if (run.state !== 'IN_PROGRESS') tmFail('RUN_NOT_OPEN');
    // A recorded failure is final (testmgmt/results.js): the run is signed off
    // as Failed and gets its bug. Not executed is for a run that could not be
    // carried out, never a way round the bug.
    if (c.steps.some(s => s.status === 'FAILED')) tmFail('RUN_HAS_FAILURE');
    if (!String(reason ?? '').trim()) tmFail('REASON_REQUIRED');
    const step = run.chain.steps[0];
    if (!await deps.isEligibleFor({ accountId: actor.accountId, projectId: project.projectId,
      issueTypeId: issue.fields?.issuetype?.id, role: step.role })) tmFail('NOT_ELIGIBLE');
    const frozen = await deps.setRunState({ runId, from: 'IN_PROGRESS', to: 'CLOSING', expectedRevision: run.revision,
      frozenDigest: c.digest, now: deps.now() });
    if (!frozen) tmFail('STALE');
    let recorded;
    try { recorded = await deps.recordSignature({ kind: 'RUN_NOT_EXECUTED', subjectId: runId, stepIndex: 0,
      step: { ...step, label: 'Closed as not executed', meaning: 'I close this run as not executed, for the reason given.' },
      signer: await signer(actor), decision: 'NOT_EXECUTED', reason: String(reason).trim(), contentHash: c.digest, code,
      issueId: issue.id, payload: { testIssueId: run.testIssueId } }, deps);
    } catch (error) {
      await deps.unfreezeRun({ runId, from: 'CLOSING', now: deps.now() }).catch(() => {});
      throw error;
    }
    if (!recorded.ok) {
      await deps.unfreezeRun({ runId, from: 'CLOSING', now: deps.now() }).catch(() => {});
      if (recorded.message) return { error: recorded.message, reason: recorded.reason };
      tmFail(recorded.reason);
    }
    await settle(runId).catch(() => {});
    return view(issue.key, actor);
  }

  async function createBug({ run, issue, project, version, steps }) {
    const bugDeps = {
      insertBugIntent: deps.insertBugIntent, readBug: deps.readBug, updateBug: deps.updateBug,
      createIssue: deps.createIssueAsApp, searchByLabel: deps.searchByLabelAsApp, readMarker: deps.readBugMarkerAsApp,
      linkIssue: deps.ensureIssueLinkAsApp ?? deps.linkIssueAsApp, claimBugIssue: deps.claimBugIssue, now: deps.now
    };
    let test;
    try { test = await deps.readIssueAsApp(run.testIssueId); }
    catch (error) {
      // A test that is gone cannot give the bug its parent or summary, now or
      // later: the run shows Bug needs repair. Anything else is tried again.
      if (error?.reason !== 'NOT_FOUND') throw error;
      return recordBug(issue, run, await ensureBug({ run, parentIssueId: null, fields: {}, links: [], unbuildable: 'TEST_UNREADABLE' }, bugDeps));
    }
    // Only fields the bug's create screen offers: the payload follows the
    // project's configuration and is never changed after Jira refuses it.
    const screen = await deps.createScreenFields(project.projectId, project.defectTypeId).catch(() => null);
    const signatures = await deps.listSignatures('RUN', run.runId);
    const definitions = run.resolvedSteps ?? version.content.steps;
    const detailed = steps.map((s, i) => ({ ...s, position: i + 1, action: definitions[i]?.action ?? '',
      expected: definitions[i]?.expected ?? '' }));
    const fields = {
      project: { id: String(project.projectId) }, issuetype: { id: String(project.defectTypeId) },
      summary: `Test failed: ${test.key} — ${test.fields?.summary ?? ''}`.slice(0, 254),
      description: bugDescription({ run, testKey: test.key, versionNo: version.versionNo, executionKey: issue.key,
        steps: detailed, signers: signatures }),
      ...(run.release && screen?.has('fixVersions') ? { fixVersions: [{ id: String(run.release.id) }] } : {})
    };
    const links = [{ typeName: project.linkTypeName, outwardId: String(test.id) },
      { typeName: project.linkTypeName, outwardId: String(issue.id) }];
    return recordBug(issue, run, await ensureBug({ run, parentIssueId: parentOf(test)?.id ?? null, fields, links }, bugDeps));
  }

  async function recordBug(issue, run, bug) {
    await deps.tryAudit({ eventType: 'TM_BUG', actorAccountId: 'system', issueId: Number(issue.id),
      payload: { runId: run.runId, state: bug?.state ?? null, bugKey: bug?.issueKey ?? null, parentIssueId: bug?.parentIssueId ?? null,
        lastError: bug?.lastError ?? null } });
    return bug;
  }

  /**
   * Finish a run whose last signature is recorded: its outcome, then its bug.
   * Never past NEEDS_REPAIR: that is an administrator's decision.
   */
  async function retryBug({ runId }, actor) {
    const run = await deps.readRun(runId);
    if (!run) tmFail('NOT_FOUND');
    if (!['CREATING', 'SIGNING', 'SIGNED', 'CLOSING'].includes(run.state)) tmFail('INVALID_INPUT');
    await execution(run.executionIssueId);
    await deps.readIssueAsUser(run.testIssueId);
    if (run.state === 'CREATING') {
      await deps.activateRunCreation(runId);
      return view(run.executionIssueId, actor);
    }
    await deps.recoverSignatures('RUN', runId, deps.now());
    await deps.recoverSignatures('RUN_NOT_EXECUTED', runId, deps.now());
    await settle(runId);
    return view(run.executionIssueId, actor);
  }

  return { signRun, closeNotExecuted, retryBug };
}

/** The run's result from its steps: one iteration until datasets arrive. */
function runResultOf(steps) {
  return runResult([{ steps: steps.map(s => s.status) }]);
}
