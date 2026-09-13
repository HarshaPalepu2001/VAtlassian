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
import { readBaselineTree } from '../db/baselineTreeStore.js';
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
  if (!gate && !transition && baseline) gate = await gatedTransition({ projectId, issueTypeId,
    fromStatusId: baseline.from_status_id, toStatusId: baseline.to_status_id, transitionId: baseline.transition_id });
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
  
  const evidenceHash = treeDiff ? null : (diff?.evidenceHash ?? projection.contentHash);
  if (expectedEvidenceHash != null && expectedEvidenceHash !== (useTree ? treeHash : evidenceHash)) fail('STALE_EVIDENCE');
  return { issue, actor, issueId, projectId, issueTypeId, config, baseline, review, gate,
    eligible, fields, editmeta, restoreEditmeta, baselineValues, driftRows, diff,
    contentHash: useTree ? treeHash : projection.contentHash, digests: projection.digests,
    evidenceHash: useTree ? treeHash : evidenceHash, baselineVersion: baseline?.version ?? 0,
    tree, currentTree, baselineTree, treeDiff, treeHash,
    driftCount: useTree ? (treeDiff?.changes?.length ?? 0) : Math.max(driftRows.length, diff?.changedFieldCount ?? 0), reportHash: null };
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

export async function load(args, options = {}) {
  const [issue, myself] = await Promise.all([
    readableIssue(args),
    api.asUser().requestJira(route`/rest/api/3/myself`).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  const actor = { ...actorFrom(args.context), displayName: myself?.displayName ?? null };
  return snapshot({ issue, actor, ...options });
}
