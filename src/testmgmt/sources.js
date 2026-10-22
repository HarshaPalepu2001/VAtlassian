import { contentDigest } from './content.js';
import { governedLinks, normaliseLinkPolicy } from '../lib/linkPolicy.js';

const fail = reason => { throw Object.assign(new Error(reason === 'SOURCE_UNAVAILABLE' ? 'A source is unavailable or outside this project.' : reason), { reason }); };
const validHash = value => /^[a-f0-9]{64}$/i.test(String(value ?? ''));
const idOf = value => Buffer.isBuffer(value) ? value.toString('hex') : String(value ?? '');

export function sourceBaseline(value) {
  if (!value) return null;
  const baseline = { id: idOf(value.id ?? value.baseline_id), version: Number(value.version), hash: String(value.hash ?? value.content_hash ?? '') };
  return /^[a-f0-9]{32}$/i.test(baseline.id) && Number.isSafeInteger(baseline.version) && baseline.version > 0 && validHash(baseline.hash) ? baseline : null;
}

/** A cached item-state row cannot replace a live comparison, particularly for tree baselines. */
export function sourceStateFromReadback({ issue, baseline, review, comparison, tree, linkPolicy = null }) {
  const fallback = () => contentDigest({ issueId: String(issue.id), fields: issue.fields });
  if (!baseline) {
    const fields = { ...issue.fields };
    // Jira can update these when the signed Test mirrors its own association.
    // They describe transport/view activity, not the source acceptance content.
    delete fields.updated;
    delete fields.lastViewed;
    if (normaliseLinkPolicy(linkPolicy).version === 2) {
      fields.issuelinks = governedLinks(fields.issuelinks, { issue, linkPolicy });
    }
    return { complete: true, sourceDigest: contentDigest({ issueId: String(issue.id), fields }), baseline: null, governedReady: false, drifted: false };
  }
  const approved = sourceBaseline(baseline);
  const stateBaseline = review ? sourceBaseline({ baseline_id: review.baseline_id, version: review.baseline_version, content_hash: baseline.content_hash }) : null;
  const agrees = !!approved && !!stateBaseline && approved.id === stateBaseline.id && approved.version === stateBaseline.version &&
    String(review.project_id) === String(issue.fields.project.id) && review.state === 'BASELINED';
  const readable = comparison?.diagnostics?.baselineReadable === true && validHash(comparison.contentHash);
  const treeRequired = !!(baseline.tree_hash || baseline.captured_by_baseline_id);
  const treeReadable = !treeRequired || (tree?.complete === true && tree.baselineId === approved?.id && validHash(tree.contentHash));
  const drifted = !agrees || !readable || (comparison.changed ?? []).length > 0 || !treeReadable || (treeRequired && tree.driftCount !== 0);
  return { complete: true, baseline: approved, sourceDigest: treeReadable && treeRequired ? tree.contentHash : comparison?.contentHash ?? fallback(),
    governedReady: agrees && readable && treeReadable && !drifted, drifted };
}

/** The Test owns these associations. This module never mutates source issues or their signed link policies. */
export function createTestSources(deps) {
  async function resolveTestSources(refs, { projectId, viewer, requireTypedLinks = false } = {}) {
    if (!viewer?.accountId || !/^\d+$/.test(String(projectId ?? '')) || !Array.isArray(refs) || refs.length > 50) fail('SOURCE_UNAVAILABLE');
    const siteId = String(await deps.siteIdentity(viewer) ?? '');
    if (!siteId) fail('SOURCE_UNAVAILABLE');
    const project = deps.readProject ? await deps.readProject(projectId) : null;
    const linkTypeId = project?.sourceLinkTypeId == null ? null : String(project.sourceLinkTypeId);
    if (requireTypedLinks && refs.length && !/^[1-9]\d*$/.test(linkTypeId ?? '')) fail('SOURCE_LINK_TYPE_REQUIRED');
    const seen = new Set();
    const out = [];
    for (const ref of refs) {
      const issueId = String(ref?.issueId ?? '');
      if (!/^\d+$/.test(issueId) || seen.has(issueId) || (ref.projectId && String(ref.projectId) !== String(projectId)) || (ref.siteId && ref.siteId !== siteId)) fail('SOURCE_UNAVAILABLE');
      seen.add(issueId);
      let issue, current;
      try {
        // Authorization precedes every SQL baseline/state read and every returned title.
        issue = await deps.readIssueAsUser(issueId, viewer);
        if (String(issue?.id) !== issueId || String(issue?.fields?.project?.id) !== String(projectId)) fail('SOURCE_UNAVAILABLE');
        current = await deps.getSourceState(issue, { viewer });
      } catch { fail('SOURCE_UNAVAILABLE'); }
      if (current?.complete !== true || !validHash(current.sourceDigest)) fail('SOURCE_UNAVAILABLE');
      const baseline = sourceBaseline(current.baseline);
      const drifted = current.drifted !== false;
      out.push({ issueId, issueKey: String(issue.key ?? ''), projectId: String(projectId), siteId, linkTypeId,
        sourceDigest: current.sourceDigest, baseline,
        governedReady: !!baseline && !drifted && current.governedReady !== false, drifted });
    }
    return out;
  }

  async function validateTestSources(refs, context) {
    const current = await resolveTestSources(refs, context);
    for (let i = 0; i < current.length; i++) {
      const pinned = refs[i];
      if (!pinned.siteId || !pinned.projectId || !validHash(pinned.sourceDigest) ||
        pinned.sourceDigest !== current[i].sourceDigest || contentDigest(sourceBaseline(pinned.baseline)) !== contentDigest(current[i].baseline) ||
        pinned.drifted !== current[i].drifted || (pinned.linkTypeId ?? null) !== current[i].linkTypeId) fail('SOURCE_CHANGED');
    }
    return current;
  }

  async function recordSignedSources(version) {
    if (version?.state !== 'SIGNED' || !version.versionId || contentDigest(version.content) !== version.digest) fail('SOURCE_CHANGED');
    const proof = deps.verifyVersionProof ? await deps.verifyVersionProof(version) : null;
    if (!(proof === true || proof?.ok === true)) fail('SOURCE_CHANGED');
    await deps.beginSignedSourceProjection({ ...version, signedAt: version.signedAt ?? deps.now() });
    for (const ref of version.content.verifies ?? []) {
      if (!ref.siteId || !ref.projectId || ref.projectId !== String(version.projectId) || !validHash(ref.sourceDigest)) fail('SOURCE_CHANGED');
      await deps.insertSignedSourceAssociation({ versionId: version.versionId, testIssueId: String(version.testIssueId), projectId: String(version.projectId),
        sourceIssueId: ref.issueId, source: ref, signedAt: version.signedAt ?? deps.now() });
    }
    await deps.finishSignedSourceProjection(version);
  }
  return { resolveTestSources, validateTestSources, recordSignedSources };
}
