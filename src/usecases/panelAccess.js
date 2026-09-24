import api, { route } from '@forge/api';
import { controlledFields, projectConfig, gateActiveOutOf, gatedTransition, listGatedTransitions } from '../db/configStore.js';
import { activeBaseline, readAllValues } from '../db/baselineStore.js';
import { getReview } from '../db/itemStateStore.js';
import { driftForIssue } from '../db/driftStore.js';
import { isEligible } from '../lib/reviewer.js';
import { scopeFromIssue } from '../lib/trackedFields.js';
import { project } from '../lib/content.js';
import { diffIssue } from '../lib/diff/index.js';
import { fetchChangelog } from '../lib/changelog.js';
import { createTreeReader } from '../lib/tree/jira.js';
import { readStableTree } from '../lib/tree/stableRead.js';
import { planTreeCapture } from '../lib/tree/capturePlan.js';
import { logicalNodeId } from '../lib/tree/model.js';
import { diffTree } from '../lib/tree/diff.js';
import { treeReviewDiff } from '../lib/tree/reviewDiff.js';
import { readBaselineTree, activeRootsForNode } from '../db/baselineTreeStore.js';
import { maxMateriality } from '../lib/materiality.js';
import { fail, actorFrom, serialise, respond } from './access.js';

export { fail, actorFrom, serialise, respond };
export async function readableIssue({ payload = {}, context }) {
  actorFrom(context);
  const key = payload.issueKey ?? payload.issueId ?? context.extension?.issue?.key ?? context.extension?.issue?.id;
  if (!key) fail('ISSUE_REQUIRED');
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${String(key)}?fields=*all`);
  if (!response.ok) fail('ISSUE_ACCESS_DENIED');
  const issue = await response.json();
  if (!issue.id || !issue.fields?.project?.id || !issue.fields?.issuetype?.id) fail('ISSUE_UNREADABLE');
  return issue;
}
export async function snapshot({ issue, actor, requireAuthority = false, expectedEvidenceHash, includeChangelog = true,
  transition = null, authorityPolicy = null }) {
  if (!actor?.accountId) fail('AUTHENTICATION_REQUIRED');
  const issueId = Number(issue.id);
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const fromStatusId = String(issue.fields.status?.id ?? '');
  const [declared, config, baseline, review, edge, editResponse] = await Promise.all([
    controlledFields({ projectId, issueTypeId }), projectConfig(projectId), activeBaseline(issueId),
    getReview(issueId), gateActiveOutOf({ projectId, issueTypeId, fromStatusId }),
    api.asUser().requestJira(route`/rest/api/3/issue/${issue.key}/editmeta`)
  ]);
  const editmeta = editResponse.ok ? (await editResponse.json()).fields ?? {} : {};
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: editmeta });
  let gate = authorityPolicy;
  if (!gate && transition) gate = await gatedTransition({ projectId, issueTypeId, fromStatusId,
    toStatusId: String(transition.toStatusId), transitionId: transition.id });
  if (!gate && !transition && baseline) {
    if (baseline.required_assurance) {
      gate = {
        transition_id: String(baseline.transition_id),
        from_status_id: String(baseline.from_status_id),
        to_status_id: String(baseline.to_status_id),
        required_role: baseline.required_role,
        required_assurance: baseline.required_assurance,
        meaning: 'REVIEW_REJECTED',
        capture_baseline: true
      };
    } else {
      gate = await gatedTransition({ projectId, issueTypeId,
        fromStatusId: baseline.from_status_id, toStatusId: baseline.to_status_id, transitionId: baseline.transition_id });
    }
  }
  // Drift outlives review status. Resolve authority from configured scope, never assignment.
  if (!gate && !transition && !baseline) gate = edge.gated ? edge : null;
  const eligible = !!gate && await isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: gate.required_role });
  if (requireAuthority && (!config.enabled || !eligible)) fail(config.enabled ? 'NOT_ELIGIBLE' : 'DISABLED');
  if (requireAuthority && !fields.length) fail('NO_TRACKED_FIELDS');
  const [baselineValues, driftRows, changelog] = baseline ? await Promise.all([
    readAllValues(issueId, baseline.version), driftForIssue(issueId, baseline.version, { undecidedOnly: true }),
    includeChangelog ? fetchChangelog(({ startAt, maxResults }) => api.asUser().requestJira(
      route`/rest/api/3/issue/${issue.key}/changelog?startAt=${startAt}&maxResults=${maxResults}`
    ), { sinceMs: Number(baseline.transition_at), maxPages: 5 }) : { entries: [] }
  ]) : [{}, [], { entries: [] }];
  // The map the restore planner reads, which is deliberately NOT the one above.
  //
  // `editmeta` is what THIS reviewer may edit, and capture records `writable`
  // from it, so widening it would change what that column means. The planner
  // needs a different question answered: what can be written back AT ALL. A
  // declared field that is not on this issue type's edit screen is absent from
  // the user-scoped read, and the planner would refuse to restore exactly the
  // field the reviewer rejected. Asked as the app, with the same overrides the
  // executor writes under, so plan and write agree about what is possible.
  const restoreEditmeta = requireAuthority && baseline
    ? await overrideEditmeta(issue.key) ?? editmeta
    : editmeta;
  const projection = project(issue.fields, fields);
  const diff = baseline && !baseline.tree_hash ? diffIssue({ baseline, baselineValues, currentFields: issue.fields,
    controlledFields: fields, driftRows, changelogEntries: changelog.entries, queueThreshold: config.queueThreshold }) : null;
  if (diff) {
    diff.historyTruncated = changelog.truncated === true;
    diff.historyUnavailable = changelog.failed === true;
  }
  
  // A work item with no baseline of its own may still be governed: it can be a
  // node inside a parent's tree baseline, covered by that approval. Without
  // this the child's panel said "not baselined" about an item a reviewer had
  // signed for, and an auditor could not trace the approval from the record it
  // governs. See activeRootsForNode() for why coverage rather than a separate
  // signature is the right model.
  // Wrapped rather than `.catch()`-ed: a store that throws synchronously would
  // otherwise take the whole panel down over a supplementary read.
  const coveredBy = baseline ? [] : await (async () => {
    try { return await activeRootsForNode(issueId); } catch { return []; }
  })();

  let tree = null, currentTree = null, baselineTree = null, treeDiff = null, treeHash = null;
  const useTree = gate?.capture_baseline || baseline?.tree_hash;
  if (useTree) {
    const stable = await readStableTree({
      readTree: createTreeReader({ api, route }).read,
      rootIssueKey: issue.key,
      fieldIds: fields.map(f => f.field_id)
    });
    tree = stable.tree;
    
    const plan = planTreeCapture({
      rootIssueId: issue.id,
      nodes: tree.nodes,
      controlledFields: fields
    });
    currentTree = { nodes: plan.nodes, values: plan.values };
    tree = {
      ...stable.tree,
      nodes: stable.tree.nodes.map(n => ({ ...n, logicalNodeId: logicalNodeId(n.id) }))
    };
    treeHash = plan.treeHash;
    
    if (baseline?.tree_hash) {
      baselineTree = await readBaselineTree(baseline.baseline_id);
      treeDiff = diffTree({
        baselineTree,
        currentTree,
        controlledFields: fields
      });
    }
  }
  
  const reviewDiff = treeDiff
    ? treeReviewDiff({ baseline, baselineTree, currentTree, treeDiff, controlledFields: fields,
      changelogEntries: changelog.entries, changelogUnavailable: changelog.failed === true,
      changelogTruncated: changelog.truncated === true })
    : diff;
  if (reviewDiff && treeDiff) reviewDiff.evidenceHash = treeHash;
  const evidenceHash = treeDiff ? null : (diff?.evidenceHash ?? projection.contentHash);
  if (expectedEvidenceHash != null && expectedEvidenceHash !== (useTree ? treeHash : evidenceHash)) fail('STALE_EVIDENCE');
  const reviewDriftCount = reviewDiff?.changedFieldCount ?? treeDiff?.changes?.length ?? 0;
  return { issue, actor, issueId, projectId, issueTypeId, config, baseline, review, gate,
    coveredBy, eligible, fields, editmeta, restoreEditmeta, baselineValues, driftRows, diff,
    contentHash: useTree ? treeHash : projection.contentHash, digests: projection.digests,
    evidenceHash: useTree ? treeHash : evidenceHash, baselineVersion: baseline?.version ?? 0,
    tree, currentTree, baselineTree, treeDiff, treeHash,
    reviewDiff, driftCount: useTree ? reviewDriftCount : Math.max(driftRows.length, diff?.changedFieldCount ?? 0), reportHash: null };
}
/** null, never {}, so the caller can tell "nothing extra" from "could not ask"
 *  and fall back to the user-scoped map rather than refusing every field. */
async function overrideEditmeta(issueKey) {
  try {
    const res = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/editmeta?overrideScreenSecurity=true&overrideEditableFlag=true`);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.fields && Object.keys(body.fields).length ? body.fields : null;
  } catch (error) {
    console.error('panelAccess: override editmeta unavailable', error);
    return null;
  }
}

/**
 * DESCENDANT ISSUE SECURITY SCHEMES, ENFORCED FOR THE VIEWER.
 *
 * createTreeReader walks the recursive hierarchy with asApp() (full tenant
 * privilege, needed so capture/restore/drift-detection see the true tree
 * regardless of who triggered them). That is correct for the authoritative
 * computation in snapshot(), but wrong for anything handed back to a human:
 * a reviewer who cannot browse a security-scheme-protected child issue must
 * not receive its key or live field content just because the app can see it.
 * readableIssue() already gates the root the same way; this is the same
 * boundary applied to the rest of the tree, checked with the viewer's own
 * privilege via the bulk permission-check endpoint (one request regardless
 * of tree size, so this cannot reintroduce a per-node round-trip).
 *
 * Only the LIVE current tree needs this. Baseline-side history (removed
 * nodes, retained digests) was already legitimately visible when it was
 * captured and carries no current Jira read.
 */
export async function filterViewableTree(tree) {
  if (!tree?.nodes?.length) return tree;
  const ids = [...new Set(tree.nodes.map(n => String(n.id ?? '')).filter(Boolean))];
  if (!ids.length) return { ...tree, nodes: [] };
  let body;
  try {
    const response = await api.asUser().requestJira(route`/rest/api/3/permissions/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPermissions: [{ issues: ids.map(Number).filter(Number.isFinite), permissions: ['BROWSE_PROJECTS'] }]
      })
    });
    // Fail closed: an unreadable permission check hides the whole tree
    // rather than risk showing a node nobody proved the viewer can see.
    if (!response.ok) return { ...tree, nodes: [] };
    body = await response.json();
  } catch {
    return { ...tree, nodes: [] };
  }
  const visible = new Set((body?.projectPermissions ?? [])
    .filter(grant => grant?.permission === 'BROWSE_PROJECTS')
    .flatMap(grant => grant?.issues ?? [])
    .map(String));
  return { ...tree, nodes: tree.nodes.filter(n => visible.has(String(n.id ?? ''))) };
}

/** Drops treeDiff changes describing LIVE content on a node the viewer's
 *  filtered tree no longer contains. NODE_REMOVED changes describe baseline
 *  history, not live content, and are never filtered. */
export function filterViewableTreeDiff(treeDiff, visibleTree) {
  if (!treeDiff?.changes) return treeDiff;
  const visibleIds = new Set((visibleTree?.nodes ?? []).map(n => n.logicalNodeId));
  return { ...treeDiff, changes: treeDiff.changes.filter(c => c.kind === 'NODE_REMOVED' || visibleIds.has(c.logicalNodeId)) };
}

/**
 * The same visibility boundary as filterViewableTreeDiff(), applied to the
 * reviewer-facing field list — lib/tree/reviewDiff.js's per-node issue key,
 * field names, and before/after content, not just the structural tree change
 * it was rendered from. Every caller that surfaces reviewDiff.fields
 * (panel:getState, panel:getEvidence, the report) must filter through this
 * before returning it; the raw reviewDiff is not safe to hand back as-is.
 *
 * `reviewDiff` here is snapshot()'s field: treeReviewDiff()'s output when a
 * real treeDiff exists, but the plain root-issue diffIssue() result — never
 * carrying logicalNodeId — for a gate that says capture_baseline but whose
 * active baseline predates the tree feature. That fallback is inherently
 * root-scoped (gated by the ordinary issue read, not by tree-node
 * visibility), so a field with no logicalNodeId passes through untouched.
 */
export function filterViewableReviewDiff(reviewDiff, visibleTree) {
  if (!reviewDiff?.fields) return reviewDiff;
  const visibleIds = new Set((visibleTree?.nodes ?? []).map(n => n.logicalNodeId));
  const fields = reviewDiff.fields.filter(f => f.logicalNodeId == null || f.nodeRemoved === true || visibleIds.has(f.logicalNodeId));
  const materialFields = fields.filter(f => f.semanticChange && f.materiality !== 'COSMETIC');
  return {
    ...reviewDiff,
    fields,
    changedFieldCount: fields.length,
    materialFieldCount: materialFields.length,
    maxMateriality: materialFields.length ? maxMateriality(materialFields.map(f => f.materiality)) : null
  };
}

export async function load(args, options = {}) {
  const [issue, myself] = await Promise.all([
    readableIssue(args),
    api.asUser().requestJira(route`/rest/api/3/myself`).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  const actor = { ...actorFrom(args.context), displayName: myself?.displayName ?? null };
  return snapshot({ issue, actor, ...options });
}
