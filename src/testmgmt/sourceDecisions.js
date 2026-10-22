import { contentDigest } from './content.js';
import { chainDigest, chainPosition, chainPreflight, separationProblem, validateChain } from './chain.js';
import { flattenedEvidence, proofOkay } from './coverage.js';
import { sourceBaseline } from './sources.js';

const MESSAGES = {
  SOURCE_DRIFT: 'Approve or restore the source change before reviewing applicability.',
  SIGNED_REVIEW_REQUIRED: 'A signed review that the test still fits is required before reusing a run.',
  SOURCE_CHANGED: 'The source baseline changed. Review the current source before signing.',
  SOURCE_UNCHANGED: 'The source is still on the baseline signed with this test.',
  SOURCE_DECISION_EXISTS: 'A decision for this test and source baseline already exists. Open that decision.',
  BASELINE_REQUIRED: 'Both the original and current source need an approved baseline.',
  DECISION_HISTORY_INCOMPLETE: 'Source decision history could not be read completely.'
};
const fail = reason => { throw Object.assign(new Error(MESSAGES[reason] ?? reason), { reason, userMessage: MESSAGES[reason] }); };
const same = (a, b) => contentDigest(a) === contentDigest(b);
const sourceId = value => String(value ?? '');

export function sourceDecisionProof(record, signatures) {
  if (!record?.content || contentDigest(record.content) !== record.digest || !record.chain?.steps?.length || chainDigest(record.chain) !== record.chainDigest) return false;
  if (!Array.isArray(signatures) || signatures.length !== record.chain.steps.length || !chainPosition(record.chain, signatures).complete) return false;
  const ordered = [...signatures].sort((a, b) => Number(a.step_index) - Number(b.step_index));
  if (record.chain.distinctSigners && new Set(ordered.map(s => s.account_id)).size !== ordered.length) return false;
  return ordered.every((s, index) => s.step_index === index && s.state === 'ACTIVE' && s.decision === 'SIGN' && s.role === record.chain.steps[index].role &&
    s.contentHash === record.digest && Number.isSafeInteger(s.auditSeq) && s.auditSeq > 0 && /^[a-f0-9]{64}$/.test(s.auditHash ?? ''));
}

export function matchesSourceDecision(record, { kind, version, pinned, current, run = null }) {
  const content = record.content;
  return record.state === 'SIGNED' && content.kind === kind && content.testVersionId === version.versionId && content.testDigest === version.digest &&
    content.testIssueId === String(version.testIssueId) && content.projectId === String(version.projectId) &&
    content.source.issueId === pinned.issueId && content.source.siteId === current.siteId && content.source.projectId === current.projectId &&
    same(content.oldBaseline, sourceBaseline(pinned.baseline)) && same(content.newBaseline, sourceBaseline(current.baseline)) &&
    content.newSourceDigest === current.sourceDigest && (kind !== 'APPLICABILITY' || !!run && content.run?.runId === run.runId &&
      content.run.frozenDigest === run.frozenDigest && content.run.testVersionId === run.testVersionId && content.run.testDigest === run.testDigest);
}

/** Coverage checks the proof again; a terminal label or an unconfirmed signature cannot clear Suspect. */
export async function applicableSourceDecisions(records, context, deps) {
  const accepted = [];
  for (const record of records ?? []) {
    if (!['SUSPECT_REVIEW', 'APPLICABILITY'].includes(record.content?.kind)) continue;
    if (!matchesSourceDecision(record, { ...context, kind: record.content.kind })) continue;
    const signatures = await deps.listSignatures(record.content.kind, record.decisionId);
    if (sourceDecisionProof(record, signatures)) accepted.push(record);
  }
  const review = accepted.find(record => record.content.kind === 'SUSPECT_REVIEW') ?? null;
  const applicability = review?.content.decision === 'FITS' ? accepted.find(record => record.content.kind === 'APPLICABILITY' && record.content.decision === 'APPLIES') ?? null : null;
  return { review, applicability };
}

export function createSourceDecisions(deps) {
  async function testContext(issueKey, actor) {
    const issue = await deps.readIssueAsUser(String(issueKey), actor);
    const projectId = String(issue?.fields?.project?.id ?? '');
    const project = await deps.readProject(projectId);
    if (!project?.enabled || String(issue.fields?.issuetype?.id) !== String(project.testTypeId)) fail('NOT_A_TEST');
    return { issue, projectId, project };
  }
  async function references({ issue, projectId, sourceIssueId, versionId = null }, actor) {
    const version = await deps.latestSignedVersion(issue.id);
    if (!version || versionId && version.versionId !== versionId || !proofOkay(await deps.verifyVersionProof(version))) fail('TEST_CHANGED');
    if (String(version.testIssueId) !== String(issue.id) || String(version.projectId) !== projectId) fail('TEST_CHANGED');
    const pinned = (version.content.verifies ?? []).find(ref => ref.issueId === sourceId(sourceIssueId));
    if (!pinned) fail('SOURCE_UNAVAILABLE');
    const current = (await deps.resolveTestSources([pinned], { projectId, viewer: actor }))[0];
    if (!current || current.issueId !== pinned.issueId) fail('SOURCE_UNAVAILABLE');
    return { version, pinned, current };
  }
  function sourceReady(pinned, current) {
    if (current.drifted || !current.governedReady) fail('SOURCE_DRIFT');
    const oldBaseline = sourceBaseline(pinned.baseline), newBaseline = sourceBaseline(current.baseline);
    if (!oldBaseline || !newBaseline) fail('BASELINE_REQUIRED');
    if (same(oldBaseline, newBaseline)) fail('SOURCE_UNCHANGED');
    return { oldBaseline, newBaseline };
  }
  async function listForTest(issueKey, actor) {
    const { issue, projectId } = await testContext(issueKey, actor);
    const envelope = await deps.readSourceDecisionsForTestComplete(issue.id);
    const records = [];
    for (const record of envelope.records ?? []) {
      try {
        // Historical decisions remain readable only while their source and Test are still visible in this project.
        await deps.resolveTestSources([record.content.source], { projectId, viewer: actor });
        records.push(await describe(record, issue, actor));
      } catch { return { records: [], complete: false }; }
    }
    return { records, complete: envelope.complete === true };
  }
  async function prepare({ issueKey, sourceIssueId, kind, decision, rationale, runId = null }, actor) {
    if (!['SUSPECT_REVIEW', 'APPLICABILITY'].includes(kind) || kind === 'SUSPECT_REVIEW' && !['FITS', 'MUST_CHANGE'].includes(decision) ||
      kind === 'APPLICABILITY' && decision !== 'APPLIES' || !String(rationale ?? '').trim() || String(rationale).length > 4000) fail('INVALID_INPUT');
    const context = await testContext(issueKey, actor);
    if (!await deps.hasIssuePermission(context.issue.id, 'EDIT_ISSUES')) fail('NO_EDIT_PERMISSION');
    const { version, pinned, current } = await references({ ...context, sourceIssueId }, actor);
    const { oldBaseline, newBaseline } = sourceReady(pinned, current);
    const chain = validateChain(context.project.versionChain).chain;
    if (!chain) fail('INVALID_CHAIN');
    const holders = await deps.roleHolders({ projectId: context.projectId, issueTypeId: context.issue.fields.issuetype.id, roles: chain.steps.map(step => step.role) });
    const preflight = chainPreflight(chain, holders);
    if (!preflight.ok) fail(preflight.reason);
    let pinnedRun = null;
    if (kind === 'APPLICABILITY') {
      const history = await deps.readSourceDecisionsForTestComplete(context.issue.id);
      if (!history.complete) fail('DECISION_HISTORY_INCOMPLETE');
      const review = await applicableSourceDecisions(history.records, { version, pinned, current }, deps);
      if (review.review?.content.decision !== 'FITS') fail('SIGNED_REVIEW_REQUIRED');
      const run = await deps.readRun(String(runId ?? ''));
      if (!run || run.state !== 'SIGNED' || !['PASSED', 'PARTLY_PASSED', 'NOT_APPLICABLE'].includes(run.result) ||
          run.testVersionId !== version.versionId || run.testIssueId !== String(context.issue.id) || run.projectId !== context.projectId) fail('RUN_NOT_APPLICABLE');
      const execution = await deps.readIssueAsUser(run.executionIssueId, actor);
      if (String(execution.fields?.project?.id) !== context.projectId || String(execution.fields?.issuetype?.id) !== String(context.project.executionTypeId)) fail('RUN_NOT_APPLICABLE');
      if (!proofOkay(await deps.verifyRunProof(run, version)) || !proofOkay(await deps.verifyEvidence(flattenedEvidence(run), { run, viewer: actor }))) fail('RUN_NOT_APPLICABLE');
      pinnedRun = { runId: run.runId, testVersionId: run.testVersionId, testDigest: run.testDigest, frozenDigest: run.frozenDigest,
        configuration: run.configuration ?? '', environment: run.environment ?? '', release: run.release ?? null };
    }
    const content = { kind, schema: 1, testIssueId: String(context.issue.id), projectId: context.projectId,
      testVersionId: version.versionId, testDigest: version.digest, source: { issueId: pinned.issueId, issueKey: current.issueKey,
        projectId: current.projectId, siteId: current.siteId }, oldBaseline, newBaseline, newSourceDigest: current.sourceDigest,
      decision, rationale: String(rationale).trim(), run: pinnedRun, chainDigest: chainDigest(chain) };
    const decisionId = contentDigest({ kind, testVersionId: version.versionId, sourceIssueId: pinned.issueId,
      newBaselineId: newBaseline.id, runId: pinnedRun?.runId ?? null }).slice(0, 32);
    const record = { decisionId, testIssueId: String(context.issue.id), projectId: context.projectId, sourceIssueId: pinned.issueId,
      kind, content, digest: contentDigest(content), chain, chainDigest: content.chainDigest,
      state: 'SIGNING', createdAt: deps.now(), createdBy: actor.accountId, signedAt: null };
    if (!await deps.insertSourceDecision(record)) {
      const existing = await deps.readSourceDecision(decisionId);
      if (!existing || existing.digest !== record.digest) fail('SOURCE_DECISION_EXISTS');
      return describe(existing, context.issue, actor);
    }
    return describe(record, context.issue, actor);
  }
  async function activeContext(record, actor) {
    const context = await testContext(record.testIssueId, actor);
    const refs = await references({ ...context, sourceIssueId: record.sourceIssueId, versionId: record.content.testVersionId }, actor);
    const baselines = sourceReady(refs.pinned, refs.current);
    if (!same(record.content.oldBaseline, baselines.oldBaseline) || !same(record.content.newBaseline, baselines.newBaseline) ||
        record.content.newSourceDigest !== refs.current.sourceDigest || record.content.testDigest !== refs.version.digest) fail('SOURCE_CHANGED');
    if (record.kind === 'APPLICABILITY') {
      const run = await deps.readRun(record.content.run.runId);
      if (!run || !matchesSourceDecision({ ...record, state: 'SIGNED' }, { ...refs, kind: record.kind, run }) ||
          !proofOkay(await deps.verifyRunProof(run, refs.version)) || !proofOkay(await deps.verifyEvidence(flattenedEvidence(run), { run, viewer: actor }))) fail('RUN_NOT_APPLICABLE');
      const execution = await deps.readIssueAsUser(run.executionIssueId, actor);
      if (String(execution.fields?.project?.id) !== context.projectId) fail('RUN_NOT_APPLICABLE');
    }
    return { ...context, ...refs };
  }
  async function describe(record, issue, actor) {
    const signatures = await deps.listSignatures(record.kind, record.decisionId);
    const allConfirmed = signatures.every(s => s.state === 'ACTIVE' && s.contentHash === record.digest && Number(s.auditSeq) > 0 && /^[a-f0-9]{64}$/.test(s.auditHash ?? ''));
    const position = allConfirmed ? chainPosition(record.chain, signatures) : { corrupt: true };
    let canSign = false;
    const canEdit = await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES');
    const pending = deps.hasPendingSignatures ? await deps.hasPendingSignatures(record.kind, record.decisionId) : false;
    if (canEdit && !pending && record.state === 'SIGNING' && position.next != null && !separationProblem(record.chain, signatures, actor.accountId)) {
      canSign = await deps.isEligibleFor({ accountId: actor.accountId, projectId: record.projectId,
        issueTypeId: issue.fields.issuetype.id, role: position.step.role });
    }
    return { ...record, signatures, nextStep: position.next != null ? { index: position.next, ...position.step } : null,
      canSign, canFinish: canEdit && record.state === 'SIGNING' && (pending || sourceDecisionProof(record, signatures)), proofConfirmed: record.state === 'SIGNED' && sourceDecisionProof(record, signatures) };
  }
  async function view({ decisionId }, actor) {
    const record = await deps.readSourceDecision(decisionId);
    if (!record) fail('NOT_FOUND');
    const context = await testContext(record.testIssueId, actor);
    await deps.resolveTestSources([record.content.source], { projectId: context.projectId, viewer: actor });
    return describe(record, context.issue, actor);
  }
  async function finish({ decisionId }, actor) {
    const record = await deps.readSourceDecision(decisionId);
    if (!record || contentDigest(record.content) !== record.digest || chainDigest(record.chain) !== record.chainDigest) fail('CONTENT_CHANGED');
    const context = await activeContext(record, actor);
    if (!await deps.hasIssuePermission(context.issue.id, 'EDIT_ISSUES')) fail('NO_EDIT_PERMISSION');
    if (deps.recoverSignatures) await deps.recoverSignatures(record.kind, decisionId, deps.now());
    if (record.state === 'SIGNED') return view({ decisionId }, actor);
    const signatures = await deps.listSignatures(record.kind, record.decisionId);
    if (!sourceDecisionProof(record, signatures)) return view({ decisionId }, actor);
    if (!await deps.setSourceDecisionState({ decisionId, from: 'SIGNING', to: 'SIGNED', now: deps.now() })) fail('STALE');
    return view({ decisionId }, actor);
  }
  async function sign({ decisionId, contentHash, code }, actor) {
    const record = await deps.readSourceDecision(decisionId);
    if (!record || record.state !== 'SIGNING' || contentDigest(record.content) !== record.digest || record.digest !== contentHash || chainDigest(record.chain) !== record.chainDigest) fail('CONTENT_CHANGED');
    const context = await activeContext(record, actor);
    if (!await deps.hasIssuePermission(context.issue.id, 'EDIT_ISSUES')) fail('NO_EDIT_PERMISSION');
    if (deps.recoverSignatures) await deps.recoverSignatures(record.kind, decisionId, deps.now());
    if (deps.hasPendingSignatures && await deps.hasPendingSignatures(record.kind, decisionId)) fail('SIGNATURE_PENDING');
    const signatures = await deps.listSignatures(record.kind, decisionId);
    if (signatures.some(s => s.state !== 'ACTIVE' || s.contentHash !== record.digest || !(s.auditSeq > 0) || !/^[a-f0-9]{64}$/.test(s.auditHash ?? ''))) fail('SIGNATURE_PENDING');
    const position = chainPosition(record.chain, signatures);
    if (position.next == null || position.corrupt) fail('ALREADY_SIGNED');
    if (separationProblem(record.chain, signatures, actor.accountId)) fail('SAME_SIGNER');
    if (!await deps.isEligibleFor({ accountId: actor.accountId, projectId: context.projectId, issueTypeId: context.issue.fields.issuetype.id, role: position.step.role })) fail('NOT_ELIGIBLE');
    const me = await deps.myself();
    const recorded = await deps.recordSignature({ kind: record.kind, subjectId: decisionId, stepIndex: position.next, step: position.step,
      signer: { accountId: actor.accountId, displayName: me?.displayName ?? actor.accountId }, decision: 'SIGN',
      reason: record.content.rationale, contentHash: record.digest, code, issueId: context.issue.id,
      payload: { testVersionId: record.content.testVersionId, oldBaseline: record.content.oldBaseline,
        newBaseline: record.content.newBaseline, decision: record.content.decision, run: record.content.run } }, deps);
    if (!recorded.ok) return { error: recorded.message ?? recorded.reason, reason: recorded.reason };
    return finish({ decisionId }, actor);
  }
  return { prepare, sign, finish, view, listForTest };
}
