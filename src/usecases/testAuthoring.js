/**
 * TEST AUTHORING — drafts, published versions, and their sign-off.
 *
 * Owner decision 3: a run that counts is created only from a signed version.
 * A draft is free to edit and never executed for the record. Publishing
 * freezes the draft as a numbered version with a content digest; the version's
 * sign-off chain then signs that exact digest. A version is never edited in
 * place: a change is a new draft and a new version.
 */
import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { normaliseDraft, publishProblem, versionContent, contentDigest } from '../testmgmt/content.js';
import { chainDigest, chainPosition, separationProblem } from '../testmgmt/chain.js';

const EMPTY_DRAFT = { objective: '', preconditions: '', steps: [], verifies: [], dataset: null };

export function parentOf(issue) {
  const parent = issue?.fields?.parent;
  return parent?.id ? { id: String(parent.id), key: parent.key, summary: parent.fields?.summary ?? null } : null;
}

/** The issue as the viewer sees it, and what it is in test management. */
export async function resolveSubject(issueIdOrKey, deps, expected = null) {
  if (!issueIdOrKey) tmFail('INVALID_INPUT');
  const issue = await deps.readIssueAsUser(String(issueIdOrKey));
  const projectId = String(issue?.fields?.project?.id ?? '');
  const tm = await deps.testManagementRole(issue);
  if (!tm) {
    const project = await deps.readProject(projectId);
    if (!project?.enabled) tmFail('NOT_ENABLED');
  }
  if (expected === 'TEST' && tm?.role !== 'TEST') tmFail('NOT_A_TEST');
  if (expected === 'EXECUTION' && tm?.role !== 'EXECUTION') tmFail('NOT_AN_EXECUTION');
  return { issue, projectId, role: tm?.role ?? null, project: tm?.project ?? null };
}

function describeSignature(s) {
  return { stepIndex: s.step_index, label: s.label, role: s.role, decision: s.decision, printedName: s.printedName,
    accountId: s.account_id, meaning: s.meaning, reason: s.reason, signedAt: s.signedAt, contentHash: s.contentHash,
    assuranceLevel: s.assuranceLevel };
}

export function createTestAuthoring(deps) {
  async function view(issueKey, actor) {
    const { issue, project } = await resolveSubject(issueKey, deps, 'TEST');
    const [draft, versions, canEdit, runs] = await Promise.all([
      deps.readDraft(issue.id), deps.listVersions(issue.id),
      deps.hasIssuePermission(issue.id, 'EDIT_ISSUES'), deps.listRunsForTest(issue.id)
    ]);
    const signatures = await deps.listSignaturesFor('TEST_VERSION', versions.map(v => v.versionId));
    let visibleDraft = draft?.content ?? EMPTY_DRAFT;
    if (visibleDraft.verifies?.length) {
      const refs = await deps.resolveTestSources(visibleDraft.verifies, { projectId: project.projectId, viewer: actor });
      visibleDraft = { ...visibleDraft, verifies: refs.map(ref => ({ issueId: ref.issueId, issueKey: ref.issueKey })) };
    }
    const out = [];
    const latestSignedId = versions.find(v => v.state === 'SIGNED')?.versionId;
    for (const v of versions) {
      if (v.content.verifies?.length) await deps.resolveTestSources(v.content.verifies, { projectId: project.projectId, viewer: actor });
      const own = signatures.filter(s => s.subjectId === v.versionId);
      const position = chainPosition(v.chain, own);
      const pending = await deps.hasPendingSignatures('TEST_VERSION', v.versionId);
      const needsProjection = v.versionId === latestSignedId && deps.sourceProjectionComplete ? !await deps.sourceProjectionComplete(v.versionId) : false;
      const sourceLinks = v.state === 'SIGNED' && deps.readSourceLinkIntent ? await deps.readSourceLinkIntent(v.versionId) : null;
      let canSign = false;
      if (v.state === 'PUBLISHED' && !pending && position.next != null) {
        canSign = !separationProblem(v.chain, own, actor.accountId)
          && await deps.isEligibleFor({ accountId: actor.accountId, projectId: project.projectId,
            issueTypeId: issue.fields?.issuetype?.id, role: position.step.role });
      }
      out.push({ versionId: v.versionId, versionNo: v.versionNo, state: v.state, digest: v.digest,
        publishedBy: v.publishedBy, publishedAt: v.publishedAt, signedAt: v.signedAt, content: v.content,
        ...(sourceLinks ? { sourceLinks: { state: sourceLinks.state, problem: sourceLinks.problem } } : {}),
        chain: v.chain, signatures: own.map(describeSignature),
        nextStep: position.next != null ? { index: position.next, ...position.step } : null, canSign,
        canFinish: v.state === 'PUBLISHING' || needsProjection || (v.state === 'PUBLISHED' && (pending || position.complete || position.rejected)),
        canFinishVersion: v.state === 'PUBLISHING' || needsProjection || (v.state === 'PUBLISHED' && (pending || position.complete || position.rejected)) });
    }
    return {
      role: 'TEST', issue: { id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '' },
      parent: parentOf(issue), canEdit,
      draft: draft ? { ...visibleDraft, revision: draft.revision, updatedAt: draft.updatedAt, updatedBy: draft.updatedBy }
        : { ...EMPTY_DRAFT, revision: 0 },
      versions: out,
      runs: runs.map(r => ({ runId: r.runId, executionIssueId: r.executionIssueId, state: r.state, result: r.result,
        versionId: r.testVersionId, createdAt: r.createdAt }))
    };
  }

  async function saveDraft({ issueKey, expectedRevision, draft }, actor) {
    const { issue, projectId } = await resolveSubject(issueKey, deps, 'TEST');
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
    const clean = normaliseDraft(draft);
    if (clean.error) tmFail('INVALID_INPUT');
    if (clean.draft.verifies.length) {
      const refs = [];
      for (const ref of clean.draft.verifies) {
        const source = await deps.readIssueAsUser(ref.issueId || ref.issueKey);
        refs.push({ issueId: String(source.id) });
      }
      const resolved = await deps.resolveTestSources(refs, { projectId, viewer: actor });
      clean.draft.verifies = resolved.map(ref => ({ issueId: ref.issueId, issueKey: ref.issueKey }));
    }
    const revision = await deps.saveDraft({ testIssueId: issue.id, projectId, content: clean.draft,
      expectedRevision: Number(expectedRevision) || 0, now: deps.now(), actor: actor.accountId });
    if (revision == null) tmFail('STALE');
    return view(issueKey, actor);
  }

  async function publish({ issueKey, expectedRevision }, actor) {
    const { issue, project } = await resolveSubject(issueKey, deps, 'TEST');
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
    const parent = parentOf(issue);
    if (!parent) tmFail('NO_PARENT');
    const draft = await deps.readDraft(issue.id);
    if (!draft || draft.revision !== Number(expectedRevision)) tmFail('STALE');
    const problem = publishProblem(draft.content);
    if (problem) tmFail(problem);
    const versions = await deps.listVersions(issue.id);
    const latest = versions[0] ?? null;
    const comparable = (content) => contentDigest({ ...content, versionNo: 0 });
    const resolved = draft.content.verifies?.length
      ? await deps.resolveTestSources(draft.content.verifies, { projectId: project.projectId, viewer: actor, requireTypedLinks: true }) : [];
    const content = versionContent({ testIssueId: issue.id, projectId: project.projectId,
      versionNo: (latest?.versionNo ?? 0) + 1, parentIssueId: parent.id, draft: { ...draft.content, verifies: resolved } });
    if (latest && latest.state !== 'REJECTED' && comparable(latest.content) === comparable(content)) tmFail('NO_CHANGES');
    const version = { versionId: deps.newHexId(), testIssueId: issue.id, projectId: project.projectId,
      versionNo: content.versionNo, content, digest: contentDigest(content), chain: project.versionChain,
      chainDigest: chainDigest(project.versionChain), publishedBy: actor.accountId, publishedAt: deps.now(), publishEventId: deps.newHexId() };
    if (!await deps.insertVersion(version)) tmFail('STALE');
    try {
      await deps.audit({ eventId: Buffer.from(version.publishEventId, 'hex'), eventType: 'TM_VERSION_PUBLISHED', actorAccountId: actor.accountId, issueId: Number(issue.id),
        payload: { versionId: version.versionId, versionNo: version.versionNo, digest: version.digest,
          parentIssueId: parent.id, chainDigest: version.chainDigest } });
    } catch {
      await deps.deleteVersion(version.versionId).catch(() => {});
      tmFail('LEDGER_UNAVAILABLE');
    }
    await deps.activateVersionPublication(version.versionId);
    await deps.supersedePublished(issue.id, version.versionId);
    return view(issueKey, actor);
  }

  async function signVersion({ versionId, code, contentHash, decision = 'SIGN', reason = null }, actor) {
    if (!['SIGN', 'REJECT'].includes(decision)) tmFail('INVALID_INPUT');
    const version = await deps.readVersion(versionId);
    if (!version) tmFail('NOT_FOUND');
    const { issue, project } = await resolveSubject(version.testIssueId, deps, 'TEST');
    if (version.state !== 'PUBLISHED') tmFail('VERSION_NOT_PUBLISHED');
    // The frozen bytes still hash to the stored digest, the signer saw that
    // digest, and the test still sits where it was published.
    if (contentDigest(version.content) !== version.digest || contentHash !== version.digest) tmFail('CONTENT_CHANGED');
    if ((parentOf(issue)?.id ?? null) !== version.content.parentIssueId) tmFail('CONTENT_CHANGED');
    if (decision === 'SIGN' && version.content.verifies?.length) await deps.validateTestSources(version.content.verifies, { projectId: project.projectId, viewer: actor, requireTypedLinks: true });
    const signatures = await deps.listSignatures('TEST_VERSION', versionId);
    if (await deps.hasPendingSignatures('TEST_VERSION', versionId)) tmFail('SIGNATURE_PENDING');
    const position = chainPosition(version.chain, signatures);
    if (position.next == null) tmFail('VERSION_NOT_PUBLISHED');
    if (!await deps.isEligibleFor({ accountId: actor.accountId, projectId: project.projectId,
      issueTypeId: issue.fields?.issuetype?.id, role: position.step.role })) tmFail('NOT_ELIGIBLE');
    const separation = separationProblem(version.chain, signatures, actor.accountId);
    if (separation) tmFail(separation);
    if (decision === 'REJECT' && !String(reason ?? '').trim()) tmFail('REASON_REQUIRED');
    const me = await deps.myself();
    const recorded = await deps.recordSignature({ kind: 'TEST_VERSION', subjectId: versionId, stepIndex: position.next,
      step: position.step, signer: { accountId: actor.accountId, displayName: me?.displayName ?? actor.accountId },
      decision, reason: decision === 'REJECT' ? String(reason).trim() : null, contentHash: version.digest, code,
      issueId: issue.id, payload: { versionNo: version.versionNo, testKey: issue.key } }, deps);
    if (!recorded.ok) {
      if (recorded.message) return { error: recorded.message, reason: recorded.reason };
      tmFail(recorded.reason);
    }
    // Once the audit-confirmed signature exists, an interrupted state update
    // is finished explicitly; the signer is never asked to sign twice.
    if (decision === 'REJECT' || position.next === version.chain.steps.length - 1) await settleVersion(version).catch(() => {});
    return view(issue.key, actor);
  }

  async function settleVersion(version) {
    const position = chainPosition(version.chain, await deps.listSignatures('TEST_VERSION', version.versionId));
    if (!position.complete && !position.rejected) return;
    if (contentDigest(version.content) !== version.digest || chainDigest(version.chain) !== version.chainDigest) tmFail('CONTENT_CHANGED');
    await deps.setVersionState(version.versionId, { from: 'PUBLISHED', to: position.rejected ? 'REJECTED' : 'SIGNED', now: deps.now() });
    if (position.complete && deps.recordSignedSources) await deps.recordSignedSources(await deps.readVersion(version.versionId));
  }

  async function finishVersion({ versionId }, actor) {
    let version = await deps.readVersion(versionId);
    if (!version) tmFail('NOT_FOUND');
    const { issue } = await resolveSubject(version.testIssueId, deps, 'TEST');
    if (version.state === 'PUBLISHING') {
      await deps.activateVersionPublication(versionId);
      version = await deps.readVersion(versionId);
      await deps.supersedePublished(issue.id, versionId);
    }
    await deps.recoverSignatures('TEST_VERSION', versionId, deps.now());
    if (version.state === 'PUBLISHED') await settleVersion(version);
    else if (version.state === 'SIGNED' && deps.recordSignedSources) await deps.recordSignedSources(version);
    return view(issue.key, actor);
  }

  return { view, saveDraft, publish, signVersion, finishVersion };
}

async function runtime() {
  return (await import('../testmgmt/runtime.js')).testManagementRuntime();
}

const call = (fn) => async ({ payload = {}, context }) => tmRespond(async () => {
  const actor = actorFrom(context);
  return fn(createTestAuthoring(await runtime()), payload, actor);
});

export const getTest = call((uc, p, actor) => uc.view(p.issueKey, actor));
export const saveTestDraft = call((uc, p, actor) => uc.saveDraft(p, actor));
export const publishTestVersion = call((uc, p, actor) => uc.publish(p, actor));
export const signTestVersion = call((uc, p, actor) => uc.signVersion(p, actor));
export const finishTestVersion = call((uc, p, actor) => uc.finishVersion(p, actor));
