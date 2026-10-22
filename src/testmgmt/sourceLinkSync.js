import { contentDigest } from './content.js';
import { tmFail } from './messages.js';

const id = value => /^\d+$/.test(String(value ?? ''));
const same = (a, b) => contentDigest(a) === contentDigest(b);
const key = link => `${link.typeId}:${link.direction}:${link.sourceIssueId}`;
const exact = (links, row) => links.length === row.desired.length && new Set(links.map(key)).size === links.length
  && links.every(link => link.direction === 'OUTWARD' && link.typeId === row.typeId && row.desired.includes(link.sourceIssueId));
const proof = value => Number.isSafeInteger(value?.seq) && value.seq > 0 && /^[a-f0-9]{64}$/.test(value.entryHash ?? '');
const typeCompatible = (prior, typeId) => prior.typeId === typeId
  || Array.isArray(prior.desired) && Array.isArray(prior.previous) && !prior.desired.length && !prior.previous.length;
const matchesVersion = (row, version) => row.digest === version.digest && row.testIssueId === String(version.testIssueId)
  && Number(row.versionNo) === Number(version.versionNo) && row.projectId === String(version.projectId)
  && same(row.desired, (version.content.verifies ?? []).map(ref => String(ref.issueId)).sort())
  && (version.content.verifies ?? []).every(ref => String(ref.linkTypeId) === row.typeId);

/** Only signed versions enter this durable, single-Test reconciler. Drafts never mutate Jira. */
export function createSourceLinkSync(deps) {
  async function validVersion(version) {
    if (!version || version.state !== 'SIGNED' || contentDigest(version.content) !== version.digest
      || !(await deps.verifyVersionProof(version))?.ok) tmFail('VERSION_PROOF_INVALID');
  }
  async function validateAncestry(row, seen = new Set()) {
    if (seen.has(row.versionId) || seen.size >= 50 || !Array.isArray(row.previous) || row.previous.length > 1000) tmFail('CONTENT_CHANGED');
    seen.add(row.versionId);
    const version = await deps.readVersion(row.versionId); await validVersion(version);
    if (!matchesVersion(row, version)) tmFail('CONTENT_CHANGED');
    if (!row.previousVersionId) { if (row.previous.length || row.previousDigest) tmFail('CONTENT_CHANGED'); return; }
    const prior = await deps.readSourceLinkIntent(row.previousVersionId);
    if (!prior || prior.digest !== row.previousDigest || !typeCompatible(prior, row.typeId)
      || prior.testIssueId !== row.testIssueId || prior.projectId !== row.projectId || Number(prior.versionNo) >= Number(row.versionNo)) tmFail('CONTENT_CHANGED');
    const priorVersion = await deps.readVersion(prior.versionId); await validVersion(priorVersion);
    if (!matchesVersion(prior, priorVersion)) tmFail('CONTENT_CHANGED');
    if (prior.state === 'COMMITTED') { if (!proof(prior.proof)) tmFail('CONTENT_CHANGED'); }
    else await validateAncestry(prior, seen);
    const scope = [...new Set([...prior.desired, ...(prior.state === 'COMMITTED' ? [] : prior.previous)])].sort();
    if (!same(scope, row.previous)) tmFail('CONTENT_CHANGED');
  }
  async function enqueue(version) {
    await validVersion(version);
    const refs = version.content.verifies ?? [];
    const project = await deps.readProject(version.projectId);
    if (refs.length > 50 || refs.some(ref => !id(ref.issueId) || !id(ref.linkTypeId) || String(ref.projectId) !== String(version.projectId))) tmFail('SOURCE_LINK_TYPE_REQUIRED');
    const types = new Set(refs.map(ref => String(ref.linkTypeId)));
    if (types.size > 1 || new Set(refs.map(ref => ref.issueId)).size !== refs.length) tmFail('SOURCE_LINK_TYPE_REQUIRED');
    const existing = await deps.readSourceLinkIntent(version.versionId);
    if (existing) { if (!matchesVersion(existing, version)) tmFail('CONTENT_CHANGED'); return existing; }
    const previous = await deps.latestSourceLinkIntent(version.testIssueId, { beforeVersionNo: version.versionNo });
    if (previous) await validateAncestry(previous);
    const typeId = refs[0]?.linkTypeId == null ? previous?.typeId ?? project?.sourceLinkTypeId ?? null : String(refs[0].linkTypeId);
    if (previous && !typeCompatible(previous, typeId)) tmFail('SOURCE_LINK_CONFIGURATION_CHANGED');
    const row = { versionId: version.versionId, testIssueId: String(version.testIssueId), projectId: String(version.projectId),
      versionNo: version.versionNo, digest: version.digest, typeId,
      desired: refs.map(ref => String(ref.issueId)).sort(),
      previous: [...new Set([...(previous?.desired ?? []), ...(previous?.state === 'COMMITTED' ? [] : previous?.previous ?? [])])].sort(),
      previousVersionId: previous?.versionId ?? null, previousDigest: previous?.digest ?? null, state: 'PENDING', createdAt: deps.now() };
    await deps.insertSourceLinkIntent(row);
    const stored = await deps.readSourceLinkIntent(version.versionId);
    if (!stored || stored.digest !== row.digest || !same(stored.desired, row.desired) || stored.typeId !== typeId) tmFail('CONTENT_CHANGED');
    return stored;
  }
  async function readLinks(testIssueId, typeId, viewer = null) {
    if (!typeId) return [];
    const result = viewer ? await deps.readSourceLinksAsUser(testIssueId, typeId, viewer) : await deps.readSourceLinksAsApp(testIssueId, typeId);
    if (!result || result.complete !== true || !Array.isArray(result.links) || result.links.length > 100) tmFail('SOURCE_LINK_PROOF_UNAVAILABLE');
    if (result.links.some(link => !link.id || !id(link.sourceIssueId) || link.typeId !== typeId || !['OUTWARD', 'INWARD'].includes(link.direction))) tmFail('SOURCE_LINK_PROOF_UNAVAILABLE');
    return result.links;
  }
  async function sync(versionId, { maxWrites = 10, deadline = deps.now() + 20000 } = {}) {
    if (!Number.isSafeInteger(maxWrites) || maxWrites < 1 || maxWrites > 100 || !Number.isFinite(deadline)) tmFail('INVALID_INPUT');
    const row = await deps.readSourceLinkIntent(versionId);
    if (!row || row.state === 'COMMITTED' || row.state === 'SUPERSEDED') return row;
    let version;
    try { version = await deps.readVersion(versionId); await validVersion(version); await validateAncestry(row); }
    catch (error) { await deps.setSourceLinkIntentState(versionId, 'BLOCKED', error?.reason ?? 'SOURCE_LINK_PROOF_UNAVAILABLE'); throw error; }
    const token = deps.newHexId();
    if (!await deps.claimSourceLinkLease(row.testIssueId, token, deps.now())) return row;
    const budget = () => { if (deps.now() >= deadline) tmFail('SOURCE_LINK_WRITE_PENDING'); };
    const held = async () => {
      budget();
      if (!await deps.ownsSourceLinkLease(row.testIssueId, token, deps.now())) tmFail('SOURCE_LINK_BUSY');
      if ((await deps.latestSignedVersion(row.testIssueId))?.versionId !== versionId) tmFail('SOURCE_LINK_WRITE_PENDING');
    };
    try {
      const refreshed = await deps.readSourceLinkIntent(versionId);
      if (refreshed?.state === 'COMMITTED' || refreshed?.state === 'SUPERSEDED') return refreshed;
      if (!refreshed || !same(refreshed, row)) tmFail('SOURCE_LINK_BUSY');
      budget();
      const latest = await deps.latestSignedVersion(row.testIssueId);
      if (latest?.versionId !== versionId) { await deps.setSourceLinkIntentState(versionId, 'SUPERSEDED'); return deps.readSourceLinkIntent(versionId); }
      const [test, project] = await Promise.all([deps.readIssueAsApp(row.testIssueId), deps.readProject(row.projectId)]);
      if (!project?.enabled || String(test.fields?.project?.id) !== row.projectId || String(test.fields?.issuetype?.id) !== String(project.testTypeId)
        || String(test.fields?.parent?.id ?? '') !== String(version.content.parentIssueId ?? '')) tmFail('CONTENT_CHANGED');
      let current = await readLinks(row.testIssueId, row.typeId);
      const allowed = new Set([...row.previous, ...row.desired]);
      if (current.some(link => link.direction !== 'OUTWARD' || !allowed.has(link.sourceIssueId))
        || new Set(current.map(key)).size !== current.length) tmFail('SOURCE_LINK_DRIFT');
      const removed = current.filter(link => !row.desired.includes(link.sourceIssueId));
      const added = row.desired.filter(source => !current.some(link => link.sourceIssueId === source));
      const mutationAllowed = async sourceIssueId => {
        const [freshTest, source] = await Promise.all([deps.readIssueAsApp(row.testIssueId), deps.readIssueAsApp(sourceIssueId)]);
        if (String(freshTest.fields?.project?.id) !== row.projectId || String(freshTest.fields?.issuetype?.id) !== String(project.testTypeId)
          || String(freshTest.fields?.parent?.id ?? '') !== String(version.content.parentIssueId ?? '')
          || String(source.fields?.project?.id) !== row.projectId || !await deps.sourceLinkMutationAllowed({
            testIssueId: row.testIssueId, sourceIssueId, typeId: row.typeId, test: freshTest, source })) tmFail('SOURCE_LINK_POLICY_BLOCKED');
      };
      // Authorize every affected endpoint before the first write. A v1 native baseline keeps its original rule.
      for (const sourceIssueId of new Set([...removed.map(link => link.sourceIssueId), ...added])) {
        await held();
        await mutationAllowed(sourceIssueId);
      }
      let writes = 0;
      const writable = async sourceIssueId => { await held(); if (writes >= maxWrites) tmFail('SOURCE_LINK_WRITE_PENDING'); await mutationAllowed(sourceIssueId); writes++; };
      for (const link of removed) { await writable(link.sourceIssueId); await deps.deleteSourceLink(link.id); }
      for (const sourceIssueId of added) { await writable(sourceIssueId); await deps.createSourceLink({ testIssueId: row.testIssueId, sourceIssueId, typeId: row.typeId }); }
      current = await readLinks(row.testIssueId, row.typeId);
      if (!exact(current, row)) tmFail('SOURCE_LINK_WRITE_PENDING');
      await held();
      if ((await deps.latestSignedVersion(row.testIssueId))?.versionId !== versionId) tmFail('SOURCE_LINK_WRITE_PENDING');
      const receipt = await deps.auditSourceLinkCommit(row);
      if (!proof(receipt)) tmFail('LEDGER_UNAVAILABLE');
      await deps.setSourceLinkIntentState(versionId, 'COMMITTED', null, receipt);
    } catch (error) {
      const retryable = ['SOURCE_LINK_WRITE_PENDING', 'SOURCE_LINK_BUSY', 'LEDGER_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(error?.reason);
      await deps.setSourceLinkIntentState(versionId, retryable || !error?.reason ? 'PENDING' : 'BLOCKED', error?.reason ?? 'SOURCE_LINK_WRITE_PENDING');
    } finally { await deps.releaseSourceLinkLease(row.testIssueId, token); }
    return deps.readSourceLinkIntent(versionId);
  }
  async function verify(version, actor) {
    try {
      await validVersion(version);
      if (!actor?.accountId || (await deps.latestSignedVersion(version.testIssueId))?.versionId !== version.versionId) return { ok: false };
      const row = await deps.readSourceLinkIntent(version.versionId);
      if (!row || row.state !== 'COMMITTED' || !matchesVersion(row, version) || !proof(row.proof)) return { ok: false };
      const [test, project] = await Promise.all([deps.readIssueAsUser(row.testIssueId, actor), deps.readProject(row.projectId)]);
      if (!project?.enabled || String(test.fields?.project?.id) !== row.projectId || String(test.fields?.issuetype?.id) !== String(project.testTypeId)
        || String(test.fields?.parent?.id ?? '') !== String(version.content.parentIssueId ?? '')
        || row.desired.length && String(project.sourceLinkTypeId) !== row.typeId) return { ok: false };
      for (const source of row.desired) {
        const issue = await deps.readIssueAsUser(source, actor);
        if (String(issue.fields?.project?.id) !== row.projectId) return { ok: false };
      }
      if (deps.nativeTestProofCurrent && !await deps.nativeTestProofCurrent(row.testIssueId, actor)) return { ok: false };
      const [appLinks, visibleLinks] = await Promise.all([readLinks(row.testIssueId, row.typeId), readLinks(row.testIssueId, row.typeId, actor)]);
      return { ok: exact(appLinks, row) && exact(visibleLinks, row) && same(appLinks.map(key).sort(), visibleLinks.map(key).sort()) };
    } catch { return { ok: false }; }
  }
  return { enqueue, sync, verify };
}
