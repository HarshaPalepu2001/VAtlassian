import { actorFrom } from './access.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { normaliseCollectionDraft, collectionContent } from '../testmgmt/planning.js';
import { contentDigest } from '../testmgmt/content.js';
import { chainDigest, chainPosition, separationProblem, validateChain } from '../testmgmt/chain.js';
import { authorProblem, authorsFor, authorsOf, withEditor } from '../testmgmt/authorship.js';
import { requestReads } from '../testmgmt/requestReads.js';

const mapping = { PLAN: 'planTypeId', SET: 'setTypeId', PRECONDITION: 'preconditionTypeId' };
const empty = { objective: '', text: '', members: [], preconditions: [], environment: '', configurations: [], releaseId: null };
const parentId = issue => issue.fields?.parent?.id == null ? null : String(issue.fields.parent.id);

export function createTestPlanning(deps) {
  async function subject(key, expected = null) {
    if (!key) tmFail('INVALID_INPUT');
    const issue = await deps.readIssueAsUser(String(key));
    const projectId = String(issue?.fields?.project?.id ?? '');
    const project = await deps.readProject(projectId);
    if (!project?.enabled || String(project.projectId) !== projectId) tmFail('NOT_ENABLED');
    const type = String(issue?.fields?.issuetype?.id ?? '');
    const role = Object.keys(mapping).find(role => project[mapping[role]] != null && String(project[mapping[role]]) === type);
    if (!role || (expected && role !== expected)) tmFail('NOT_A_COLLECTION');
    return { issue, project, role, projectId };
  }
  async function edit(issue) {
    if (!await deps.hasIssuePermission(issue.id, 'EDIT_ISSUES')) tmFail('NO_EDIT_PERMISSION');
  }
  async function visibleTest(id, project) {
    const issue = await deps.readIssueAsUser(String(id));
    if (String(issue?.fields?.project?.id) !== String(project.projectId) || String(issue?.fields?.issuetype?.id) !== String(project.testTypeId) || String(issue.id) !== String(id)) tmFail('MEMBER_INVALID');
    return issue;
  }
  async function resolveDraftReferences(input, s) {
    const draft = { ...input };
    if (Array.isArray(input?.members)) {
      draft.members = [];
      for (const member of input.members) {
        const key = member?.testIssueKey || member?.testIssueId;
        if (!key) tmFail('MEMBER_INVALID');
        const issue = await deps.readIssueAsUser(String(key));
        await visibleTest(issue.id, s.project);
        draft.members.push({ ...member, testIssueId: String(issue.id) });
      }
    }
    if (Array.isArray(input?.preconditions)) {
      draft.preconditions = [];
      for (const ref of input.preconditions) {
        const condition = await subject(ref?.issueKey || ref?.issueId, 'PRECONDITION');
        if (condition.projectId !== s.projectId) tmFail('MEMBER_INVALID');
        draft.preconditions.push({ ...ref, issueId: String(condition.issue.id) });
      }
    }
    return draft;
  }
  async function signatureProof(kind, record, id) {
    if (!record.chain || validateChain(record.chain).error || chainDigest(record.chain) !== record.chainDigest) tmFail('CONTENT_CHANGED');
    const signatures = await deps.listSignatures(kind, id);
    if (signatures.length > record.chain.steps.length || signatures.some((s, i) => s.state !== 'ACTIVE'
      || !Number.isSafeInteger(s.auditSeq) || s.auditSeq <= 0 || !/^[a-f0-9]{64}$/.test(s.auditHash ?? '')
      || s.role !== record.chain.steps[i]?.role || s.contentHash !== record.digest || !['SIGN', 'REJECT'].includes(s.decision))
      || record.chain.distinctSigners && new Set(signatures.map(s => s.account_id)).size !== signatures.length) tmFail('CONTENT_CHANGED');
    if (chainPosition(record.chain, signatures).corrupt) tmFail('CONTENT_CHANGED');
    return { signatures, position: chainPosition(record.chain, signatures) };
  }
  async function signedVersion(ref, project) {
    const issue = await visibleTest(ref.testIssueId, project);
    const v = ref.versionId ? await deps.readVersion(ref.versionId) : await deps.latestSignedVersion(issue.id);
    if (!v || v.state !== 'SIGNED') tmFail('NO_SIGNED_VERSION');
    if (String(v.testIssueId) !== String(issue.id) || String(v.projectId) !== String(project.projectId)) tmFail('MEMBER_INVALID');
    if (contentDigest(v.content) !== v.digest || (ref.digest != null && ref.digest !== v.digest)) tmFail('CONTENT_CHANGED');
    const proof = await signatureProof('TEST_VERSION', v, v.versionId);
    if (!proof.position.complete) tmFail('NO_SIGNED_VERSION');
    return { testIssueId: String(issue.id), versionId: v.versionId, versionNo: v.versionNo, digest: v.digest, required: ref.required !== false };
  }
  async function condition(ref, project) {
    const s = await subject(ref.issueId, 'PRECONDITION');
    if (s.projectId !== String(project.projectId)) tmFail('MEMBER_INVALID');
    const r = ref.revisionId ? await deps.readCollectionRevision(ref.revisionId)
      : (await revisions(s.issue.id)).find(r => r.state === 'SIGNED');
    if (!r || r.issueId !== String(s.issue.id) || r.projectId !== s.projectId || r.role !== 'PRECONDITION' || r.state !== 'SIGNED') tmFail('PRECONDITION_NOT_SIGNED');
    if (contentDigest(r.content) !== r.digest || (ref.digest != null && ref.digest !== r.digest)) tmFail('CONTENT_CHANGED');
    const proof = await signatureProof('COLLECTION_REVISION', r, r.revisionId);
    if (!proof.position.complete) tmFail('PRECONDITION_NOT_SIGNED');
    return { issueId: String(s.issue.id), revisionId: r.revisionId, revisionNo: r.revisionNo, digest: r.digest, text: r.content.text };
  }
  async function visibleDraft(content, project) {
    for (const member of content.members ?? []) await visibleTest(member.testIssueId, project);
    for (const ref of content.preconditions ?? []) {
      const s = await subject(ref.issueId, 'PRECONDITION');
      if (s.projectId !== String(project.projectId)) tmFail('MEMBER_INVALID');
    }
  }
  async function verifyRevision(r, s) {
    if (r.issueId !== String(s.issue.id) || r.projectId !== s.projectId || r.role !== s.role || contentDigest(r.content) !== r.digest || r.content.parentIssueId !== parentId(s.issue)) tmFail('CONTENT_CHANGED');
    for (const member of r.content.members) await signedVersion(member, s.project);
    for (const ref of r.content.preconditions) await condition(ref, s.project);
    return signatureProof('COLLECTION_REVISION', r, r.revisionId);
  }
  async function revisions(issueId) {
    const result = await deps.listCollectionRevisions(issueId);
    if (!result || result.complete !== true || !Array.isArray(result.items)) tmFail('RECORDS_INCOMPLETE');
    return result.items;
  }
  async function view(issueKey, actor, scoped = false) {
    if (!scoped) return createTestPlanning(requestReads(deps)).view(issueKey, actor, true);
    const s = await subject(issueKey);
    const [draft, list, canEdit, releases] = await Promise.all([deps.readCollectionDraft(s.issue.id), revisions(s.issue.id),
      deps.hasIssuePermission(s.issue.id, 'EDIT_ISSUES'), deps.projectVersions(s.projectId)]);
    if (draft) {
      if (draft.role !== s.role || draft.projectId !== s.projectId) tmFail('CONTENT_CHANGED');
      await visibleDraft(draft.content, s.project);
    }
    const displayDraft = { ...(draft?.content ?? structuredClone(empty)) };
    displayDraft.members = [];
    for (const m of draft?.content.members ?? []) {
      const issue = await visibleTest(m.testIssueId, s.project);
      const pinned = m.versionId ? await deps.readVersion(m.versionId) : null;
      displayDraft.members.push({ ...m, testIssueKey: issue.key, summary: issue.fields?.summary ?? '', versionNo: pinned?.versionNo ?? null });
    }
    displayDraft.preconditions = [];
    for (const ref of draft?.content.preconditions ?? []) {
      const resolved = await subject(ref.issueId, 'PRECONDITION');
      const pinned = ref.revisionId ? await deps.readCollectionRevision(ref.revisionId) : null;
      displayDraft.preconditions.push({ ...ref, issueKey: resolved.issue.key, summary: resolved.issue.fields?.summary ?? '', revisionNo: pinned?.revisionNo ?? null });
    }
    const out = [];
    const latestSigned = list.find(r => r.state === 'SIGNED')?.revisionId;
    for (const r of list) {
      const actionable = r.state === 'PUBLISHED' || r.revisionId === latestSigned;
      if (contentDigest(r.content) !== r.digest || r.issueId !== String(s.issue.id) || r.projectId !== s.projectId || r.role !== s.role) tmFail('CONTENT_CHANGED');
      const proof = actionable ? await verifyRevision(r, s) : await signatureProof('COLLECTION_REVISION', r, r.revisionId);
      const pending = deps.hasPendingSignatures ? await deps.hasPendingSignatures('COLLECTION_REVISION', r.revisionId) : false;
      const nextStep = proof.position.next == null ? null : { index: proof.position.next, ...proof.position.step };
      const signBlocked = r.state === 'PUBLISHED' && nextStep ? authorProblem(r, actor.accountId, s.project.authorSeparation) : null;
      const canSign = canEdit && !pending && r.state === 'PUBLISHED' && !!nextStep && !signBlocked && !separationProblem(r.chain, proof.signatures, actor.accountId)
        && await deps.isEligibleFor({ accountId: actor.accountId, projectId: s.projectId, issueTypeId: s.issue.fields.issuetype.id, role: nextStep.role });
      const memberLabels = {}; const preconditionLabels = {};
      for (const m of r.content.members) {
        const issue = await visibleTest(m.testIssueId, s.project); memberLabels[m.testIssueId] = { key: issue.key, summary: issue.fields?.summary ?? '' };
      }
      for (const ref of r.content.preconditions) {
        const condition = await subject(ref.issueId, 'PRECONDITION'); preconditionLabels[ref.issueId] = { key: condition.issue.key, summary: condition.issue.fields?.summary ?? '' };
      }
      out.push({ ...r, authors: authorsOf(r), signBlocked, memberLabels, preconditionLabels, signatures: proof.signatures.map(sig => ({ stepIndex: sig.step_index, label: sig.label, role: sig.role,
        decision: sig.decision, printedName: sig.printedName, meaning: sig.meaning, reason: sig.reason, signedAt: sig.signedAt,
        assuranceLevel: sig.assuranceLevel, contentHash: sig.contentHash })), nextStep, canSign,
        canRecover: canEdit && r.state === 'PUBLISHED' && (pending || proof.position.complete || proof.position.rejected) });
    }
    return { role: s.role, issue: { id: String(s.issue.id), key: s.issue.key, summary: s.issue.fields?.summary ?? '' },
      canEdit, releases, parent: s.issue.fields?.parent ? { id: parentId(s.issue), key: s.issue.fields.parent.key } : null,
      draft: { ...displayDraft, revision: draft?.revision ?? 0 }, revisions: out };
  }
  async function saveDraft({ issueKey, expectedRevision, draft }, actor) {
    const s = await subject(issueKey); await edit(s.issue);
    if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) tmFail('INVALID_INPUT');
    const clean = normaliseCollectionDraft(await resolveDraftReferences(draft, s), s.role);
    if (clean.error) tmFail(clean.error);
    await visibleDraft(clean.draft, s.project);
    const current = await deps.readCollectionDraft(s.issue.id);
    const revision = await deps.saveCollectionDraft({ issueId: s.issue.id, projectId: s.projectId, role: s.role, content: clean.draft,
      expectedRevision: Number(expectedRevision), now: deps.now(), actor: actor.accountId,
      editors: withEditor(current?.editors, actor.accountId, Number(expectedRevision) + 1) });
    if (revision == null) tmFail('STALE');
    return view(issueKey, actor);
  }
  async function activatePublication(r, s, actor) {
    await deps.audit({ eventType: 'TM_COLLECTION_PUBLISHED', actorAccountId: actor.accountId, issueId: Number(s.issue.id),
      payload: { revisionId: r.revisionId, revisionNo: r.revisionNo, digest: r.digest, role: s.role, chainDigest: r.chainDigest,
        authors: authorsOf(r) } });
    if (!await deps.setCollectionRevisionState(r.revisionId, { from: 'PUBLISHING', to: 'PUBLISHED', now: deps.now() })) tmFail('PUBLICATION_PENDING');
  }
  async function publish({ issueKey, expectedRevision }, actor) {
    const s = await subject(issueKey); await edit(s.issue);
    if (!parentId(s.issue)) tmFail('NO_PARENT');
    const draft = await deps.readCollectionDraft(s.issue.id);
    if (!draft || draft.revision !== Number(expectedRevision)) tmFail('STALE');
    const clean = normaliseCollectionDraft(draft.content, s.role);
    if (clean.error) tmFail(clean.error);
    if (s.role === 'PRECONDITION' && !clean.draft.text.trim()) tmFail('PRECONDITION_EMPTY');
    if (s.role !== 'PRECONDITION' && !clean.draft.members.length) tmFail('COLLECTION_EMPTY');
    if (s.role === 'PLAN' && (!clean.draft.releaseId || !clean.draft.environment.trim() || !clean.draft.configurations.length)) tmFail('PLAN_SCOPE_REQUIRED');
    if (validateChain(s.project.versionChain).error) tmFail('INVALID_INPUT');
    const members = []; for (const ref of clean.draft.members) members.push(await signedVersion(ref, s.project));
    const preconditions = []; for (const ref of clean.draft.preconditions) preconditions.push(await condition(ref, s.project));
    let release = null;
    if (clean.draft.releaseId) {
      const match = (await deps.projectVersions(s.projectId)).find(r => String(r.id) === clean.draft.releaseId);
      if (!match) tmFail('INVALID_INPUT');
      release = { id: String(match.id), name: match.name };
    }
    const list = await revisions(s.issue.id); const latest = list[0];
    const content = collectionContent({ issueId: s.issue.id, projectId: s.projectId, role: s.role, revisionNo: (latest?.revisionNo ?? 0) + 1,
      parentIssueId: parentId(s.issue), draft: clean.draft, members, preconditions, release });
    const same = latest && contentDigest({ ...latest.content, revisionNo: 0 }) === contentDigest({ ...content, revisionNo: 0 });
    if (same && latest.state === 'PUBLISHING') {
      try { await activatePublication(latest, s, actor); } catch (error) { if (error.reason) throw error; tmFail('LEDGER_UNAVAILABLE'); }
      return view(issueKey, actor);
    }
    if (same && latest.state !== 'REJECTED') tmFail('NO_CHANGES');
    const r = { revisionId: deps.newHexId(), issueId: String(s.issue.id), projectId: s.projectId, role: s.role,
      revisionNo: content.revisionNo, draftRevision: draft.revision, content, digest: contentDigest(content), chain: structuredClone(s.project.versionChain),
      chainDigest: chainDigest(s.project.versionChain), publishedAt: deps.now(), publishedBy: actor.accountId,
      authors: authorsFor({ draft, history: list, publisher: actor.accountId }) };
    if (!await deps.insertCollectionRevision(r)) tmFail('STALE');
    try { await activatePublication(r, s, actor); } catch (error) { if (error.reason) throw error; tmFail('LEDGER_UNAVAILABLE'); }
    return view(issueKey, actor);
  }
  async function sign({ revisionId, contentHash, code, decision = 'SIGN', reason = null }, actor) {
    if (!['SIGN', 'REJECT'].includes(decision)) tmFail('INVALID_INPUT');
    const r = await deps.readCollectionRevision(revisionId);
    if (!r) tmFail('NOT_FOUND');
    const s = await subject(r.issueId); await edit(s.issue);
    if (r.state !== 'PUBLISHED') tmFail('COLLECTION_NOT_PUBLISHED');
    if (contentHash !== r.digest) tmFail('CONTENT_CHANGED');
    if (deps.recoverSignatures) await deps.recoverSignatures('COLLECTION_REVISION', revisionId, deps.now());
    if (deps.hasPendingSignatures && await deps.hasPendingSignatures('COLLECTION_REVISION', revisionId)) tmFail('SIGNATURE_PENDING');
    const proof = await verifyRevision(r, s);
    if (proof.position.corrupt) tmFail('CONTENT_CHANGED');
    if (proof.position.next != null) {
      if (!await deps.isEligibleFor({ accountId: actor.accountId, projectId: s.projectId, issueTypeId: s.issue.fields.issuetype.id, role: proof.position.step.role })) tmFail('NOT_ELIGIBLE');
      const separation = authorProblem(r, actor.accountId, s.project.authorSeparation) ?? separationProblem(r.chain, proof.signatures, actor.accountId); if (separation) tmFail(separation);
      if (decision === 'REJECT' && !String(reason ?? '').trim()) tmFail('REASON_REQUIRED');
      const me = await deps.myself();
      const result = await deps.recordSignature({ kind: 'COLLECTION_REVISION', subjectId: revisionId, stepIndex: proof.position.next,
        step: proof.position.step, signer: { accountId: actor.accountId, displayName: me?.displayName ?? actor.accountId },
        decision, reason: decision === 'REJECT' ? String(reason).trim() : null, contentHash: r.digest, code,
        issueId: s.issue.id, payload: { revisionNo: r.revisionNo, role: s.role, authorSeparation: s.project.authorSeparation === true, authors: authorsOf(r) } }, deps);
      if (!result.ok) { if (result.message) return { error: result.message, reason: result.reason }; tmFail(result.reason); }
    }
    const confirmed = await signatureProof('COLLECTION_REVISION', r, revisionId);
    if (confirmed.position.complete || confirmed.position.rejected) {
      const state = confirmed.position.rejected ? 'REJECTED' : 'SIGNED';
      if (!await deps.setCollectionRevisionState(revisionId, { from: 'PUBLISHED', to: state, now: deps.now() })) {
        const current = await deps.readCollectionRevision(revisionId);
        if (current?.state !== state) tmFail('SIGNATURE_STATE_PENDING');
      }
    }
    return view(s.issue.key, actor);
  }
  async function selectRuns({ revisionId, contentHash, testIssueIds = null, configurationIds = null }, actor) {
    const r = await deps.readCollectionRevision(revisionId);
    if (!r) tmFail('NOT_FOUND');
    const s = await subject(r.issueId, 'PLAN');
    if (r.state !== 'SIGNED') tmFail('PLAN_NOT_SIGNED');
    if (contentHash !== r.digest) tmFail('CONTENT_CHANGED');
    const proof = await verifyRevision(r, s);
    if (!proof.position.complete) tmFail('PLAN_NOT_SIGNED');
    const subset = (provided, all) => {
      if (provided == null) return new Set(all);
      if (!Array.isArray(provided) || !provided.length || provided.some(v => typeof v !== 'string') || new Set(provided).size !== provided.length || provided.some(id => !all.includes(id))) tmFail('INVALID_INPUT');
      return new Set(provided);
    };
    const selectedTests = subset(testIssueIds, r.content.members.map(m => m.testIssueId));
    const selectedConfigs = subset(configurationIds, r.content.configurations.map(c => c.id));
    const plan = { issueId: r.issueId, revisionId, revisionNo: r.revisionNo, digest: r.digest };
    const runs = [];
    for (const m of r.content.members) if (selectedTests.has(m.testIssueId)) {
      const issue = await visibleTest(m.testIssueId, s.project);
      for (const cfg of r.content.configurations) if (selectedConfigs.has(cfg.id)) runs.push({ testIssueId: m.testIssueId, testKey: issue.key, testSummary: issue.fields?.summary ?? '', testVersionNo: m.versionNo,
        testVersionId: m.versionId, testDigest: m.digest, required: m.required, configuration: cfg.name, configurationId: cfg.id,
        release: structuredClone(r.content.release), environment: r.content.environment, planRevisionId: revisionId,
        plan: { ...plan }, preconditions: structuredClone(r.content.preconditions) });
    }
    return { plan, runs, digest: contentDigest({ plan, runs }) };
  }
  async function lookup({ issueKey, collectionKey, kind = 'TEST' }, actor) {
    const s = await subject(collectionKey);
    if (!['TEST', 'PRECONDITION'].includes(kind)) tmFail('INVALID_INPUT');
    const issue = await deps.readIssueAsUser(String(issueKey ?? ''));
    let latestSigned = null;
    if (kind === 'TEST') {
      await visibleTest(issue.id, s.project);
      const v = await deps.latestSignedVersion(issue.id);
      if (v) { const checked = await signedVersion({ testIssueId: issue.id, versionId: v.versionId }, s.project);
        latestSigned = { versionId: checked.versionId, versionNo: checked.versionNo }; }
    } else {
      const found = await subject(issue.id, 'PRECONDITION');
      if (found.projectId !== s.projectId) tmFail('MEMBER_INVALID');
      const r = (await revisions(issue.id)).find(r => r.state === 'SIGNED');
      if (r) { const checked = await condition({ issueId: issue.id, revisionId: r.revisionId }, s.project);
        latestSigned = { revisionId: checked.revisionId, revisionNo: checked.revisionNo }; }
    }
    return { issueId: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '', latestSigned };
  }
  async function validateRunPlanningSnapshot(run, actor) {
    const snapshot = run?.planningSnapshot;
    if (snapshot?.plan == null) return { ok: true, current: true, reason: null };
    const descriptor = snapshot.plan;
    if (!descriptor.issueId || !descriptor.revisionId || !descriptor.digest) tmFail('RECORDS_INCOMPLETE');
    const s = await subject(descriptor.issueId, 'PLAN');
    const r = await deps.readCollectionRevision(descriptor.revisionId);
    if (!r || r.state !== 'SIGNED' || r.digest !== descriptor.digest || r.revisionNo !== descriptor.revisionNo) tmFail('CONTENT_CHANGED');
    const proof = await verifyRevision(r, s);
    if (!proof.position.complete) tmFail('PLAN_NOT_SIGNED');
    if (contentDigest(snapshot.preconditions ?? []) !== contentDigest(r.content.preconditions)) tmFail('CONTENT_CHANGED');
    const [draft, list] = await Promise.all([deps.readCollectionDraft(s.issue.id), revisions(s.issue.id)]);
    if (!draft || draft.revision !== r.draftRevision || list[0]?.revisionId !== r.revisionId) return { ok: true, current: false, reason: 'PLAN_CHANGED' };
    for (const ref of r.content.preconditions) {
      const pinned = await deps.readCollectionRevision(ref.revisionId);
      const [current, list] = await Promise.all([deps.readCollectionDraft(ref.issueId), revisions(ref.issueId)]);
      if (!current || current.revision !== pinned?.draftRevision || list[0]?.revisionId !== ref.revisionId) return { ok: true, current: false, reason: 'PRECONDITION_CHANGED' };
    }
    return { ok: true, current: true, reason: null };
  }
  return { view, saveDraft, publish, sign, selectRuns, lookup, validateRunPlanningSnapshot };
}

const call = fn => async ({ payload = {}, context }, suppliedDeps = null) => tmRespond(async () => {
  const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
  return fn(createTestPlanning(deps), payload, actorFrom(context));
});
export const getTestCollection = call((uc, p, actor) => uc.view(p.issueKey, actor));
export const saveTestCollectionDraft = call((uc, p, actor) => uc.saveDraft(p, actor));
export const publishTestCollection = call((uc, p, actor) => uc.publish(p, actor));
export const signTestCollection = call((uc, p, actor) => uc.sign(p, actor));
export const selectTestPlanRuns = call((uc, p, actor) => uc.selectRuns(p, actor));
export const lookupTestCollectionMember = call((uc, p, actor) => uc.lookup(p, actor));
