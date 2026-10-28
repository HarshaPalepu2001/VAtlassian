import { load, readableIssue, respond, fail, filterViewableTree, filterViewableTreeDiff, filterViewableReviewDiff } from './panelAccess.js';
import { baselineHistory, activeBaseline, baselineByVersion, readAllValues } from '../db/baselineStore.js';
import { readBaselineTree } from '../db/baselineTreeStore.js';
import { controlledFields } from '../db/configStore.js';
import { restoresForIssue } from '../db/restoreStore.js';
import { driftForIssueVersions } from '../db/driftStore.js';
import { approvalById } from '../db/approvalStore.js';
import { recordSnapshot, compareBaselineSnapshots } from '../lib/baselineVersions.js';
import { logicalNodeId } from '../lib/tree/model.js';
import { withStoredAttribution } from '../lib/tree/reviewAttribution.js';
import { attachmentRejection, removedNodeFiles } from '../lib/restore/attachmentPreflight.js';
import { mixedEligibility } from '../lib/approval/mixedDecision.js';
import { projectRestoreRows } from './viewerProjection.js';

/**
 * THE HEAVY READ — recursive tree, retained values, changelog attribution,
 * full differences, baseline history, and restoration history.
 *
 * Loaded after the summary, or when the evidence section opens. Uses
 * panelAccess.js's snapshot() for the authoritative state, then reads saved
 * version history and descendant drift attribution for the review display.
 * Every approval challenge/submit/retry still performs its own fresh
 * authoritative read — this is presentation, not authorization.
 */

/** Flatten ADF description into a bounded preview. Shared with panel.js so the
 *  compatibility adapter does not keep a second copy of the same rule. */
export function extractDescription(doc) {
  const extractText = (d) => {
    if (!d || !d.content) return '';
    return d.content.map(c => (c.type === 'paragraph' ? (c.content || []).map(n => n.text).join('') : '')).join('\n').trim();
  };
  const desc = extractText(doc);
  const descriptionTruncated = desc.length > 500;
  const descriptionEmpty = desc.length === 0;
  const description = descriptionTruncated ? desc.substring(0, 500) + '…' : desc;
  return { description, descriptionEmpty, descriptionTruncated };
}

/**
 * The exact destructive consequences of a rejection: which added issues would
 * be deleted, and how many removed nodes would need recreating. Shared with
 * panel.js for the same reason as extractDescription() above.
 */
export function buildTreeRejection({ treeDiff, tree }) {
  const groupedDrift = { addedNodes: [], removedNodes: [], movedNodes: [], changedFields: [] };
  const deleteIssueKeys = [];
  let recreateCount = 0;
  if (treeDiff?.changes) {
    const currentNodesById = new Map(tree?.nodes?.map(n => [n.logicalNodeId, n]) ?? []);
    for (const change of treeDiff.changes) {
      if (change.kind === 'NODE_ADDED') {
        const node = currentNodesById.get(change.logicalNodeId);
        groupedDrift.addedNodes.push(node);
        if (node?.key) deleteIssueKeys.push(node.key);
      } else if (change.kind === 'NODE_REMOVED') {
        groupedDrift.removedNodes.push(change);
        recreateCount++;
      } else if (change.kind === 'NODE_MOVED') {
        groupedDrift.movedNodes.push(change);
      } else if (change.kind === 'FIELD_CHANGED') {
        groupedDrift.changedFields.push(change);
      }
    }
  }
  return { groupedDrift, deleteIssueKeys, recreateCount };
}

export async function getEvidence(args) { return respond(async () => {
  const payload = args.payload ?? {};
  const prepared = await load(args);
  const { baseline, issue } = prepared;

  // A newer baseline than the one the caller last saw makes this evidence
  // stale before it is even assembled — the client must refresh its summary
  // and re-request evidence against the current version, never render mixed
  // vintages of baseline/tree/diff together.
  if (payload.expectedBaselineVersion != null
    && Number(payload.expectedBaselineVersion) !== Number(baseline?.version ?? 0)) fail('STALE_EVIDENCE');
  if (payload.expectedBaselineId != null) {
    const expected = Buffer.isBuffer(payload.expectedBaselineId)
      ? payload.expectedBaselineId : Buffer.from(String(payload.expectedBaselineId), 'hex');
    if (!baseline?.baseline_id || !Buffer.from(baseline.baseline_id).equals(expected)) fail('STALE_EVIDENCE');
  }

  const [history, restores, approvalRecord] = await Promise.all([
    baselineHistory(prepared.issueId),
    restoresForIssue(prepared.issueId),
    baseline?.approval_id ? approvalById(baseline.approval_id) : null
  ]);

  const record = prepared.baselineTree
    ? recordSnapshot({ baseline, nodes: prepared.baselineTree?.nodes ?? [],
      values: prepared.baselineTree?.values ?? {} }, prepared.fields)
    : baseline ? recordSnapshot({ baseline, values: prepared.baselineValues }, prepared.fields) : null;
  if (record && approvalRecord && !record.signedAt) record.signedAt = approvalRecord.signed_at ?? approvalRecord.decided_at ?? null;
  if (record) {
    record.history = (history ?? []).map(h => ({
      version: Number(h.version),
      approvedName: h.approved_name ?? h.approvedName ?? 'Reviewer',
      approvedAt: h.transition_at ?? h.captured_at ?? h.approvedAt ?? null,
      capturedAt: h.captured_at ?? h.capturedAt ?? null,
      assuranceLevel: h.assurance_level ?? h.assuranceLevel ?? null,
      approved_name: h.approved_name ?? h.approvedName,
      transition_at: h.transition_at ?? h.approvedAt,
      assurance_level: h.assurance_level ?? h.assuranceLevel
    }));
  }

  const { description, descriptionEmpty, descriptionTruncated } = extractDescription(issue.fields.description);
  const viewableTree = prepared.tree ? await filterViewableTree(prepared.tree) : prepared.tree;
  const viewableTreeDiff = filterViewableTreeDiff(prepared.treeDiff, viewableTree);
  const viewableReviewDiff = filterViewableReviewDiff(prepared.reviewDiff, viewableTree);
  const descendantPairs = (viewableReviewDiff?.groups ?? [])
    .filter(group => group.kind === 'ISSUE' && !group.isRoot && group.issueId && group.baselineVersion)
    .map(group => ({ issueId: group.issueId, version: group.baselineVersion }));
  let storedHistory = { rows: [], truncated: false };
  let storedHistoryUnavailable = false;
  if (descendantPairs.length) {
    try { storedHistory = await driftForIssueVersions(descendantPairs); }
    catch { storedHistoryUnavailable = true; }
  }
  const attributedReviewDiff = withStoredAttribution(viewableReviewDiff, storedHistory.rows);
  const { groupedDrift, deleteIssueKeys, recreateCount } = buildTreeRejection({ tree: viewableTree, treeDiff: viewableTreeDiff });
  // Files a rejection deletes, re-uploads from the vault, or cannot restore.
  const attachments = baseline ? await attachmentRejection({
    reviewFields: attributedReviewDiff?.fields ?? prepared.diff?.fields ?? [],
    issue: { issueId: prepared.issueId, issueKey: issue.key },
    removedNodes: removedNodeFiles({ treeDiff: viewableTreeDiff, baselineTree: prepared.baselineTree })
  }) : null;

  return {
    baselineId: baseline?.baseline_id ? Buffer.from(baseline.baseline_id).toString('hex') : null,
    baselineVersion: baseline?.version ?? 0,
    evidenceHash: prepared.evidenceHash ?? null,
    description, descriptionEmpty, descriptionTruncated,
    assignee: issue.fields.assignee, reporter: issue.fields.reporter,
    record,
    drift: {
      count: Number(prepared.treeDiff
        ? attributedReviewDiff?.changedFieldCount ?? 0
        : prepared.driftCount ?? attributedReviewDiff?.changedFieldCount ?? prepared.diff?.changedFieldCount ?? 0),
      materialCount: Number(attributedReviewDiff?.materialFieldCount ?? prepared.diff?.materialFieldCount ?? 0),
      fields: attributedReviewDiff?.fields ?? prepared.diff?.fields ?? [],
      historyTruncated: prepared.reviewDiff?.historyTruncated === true || storedHistory.truncated,
      historyUnavailable: prepared.reviewDiff?.historyUnavailable === true || storedHistoryUnavailable,
      // A tree parent's review, one section per issue (lib/tree/groupedReview.js),
      // recomputed after the visibility filter. Absent for a single-issue diff.
      ...(attributedReviewDiff?.groups ? { groups: attributedReviewDiff.groups } : {}),
      // Whether this review can be decided field by field, and each decidable
      // field's restorability. Built from the viewer-filtered fields; the server
      // re-checks an exact map against its own unfiltered reading, so a map that
      // omits a field this viewer cannot see is refused rather than guessed.
      mixed: mixedEligibility({ baseline, baselineTree: prepared.baselineTree,
        reviewFields: attributedReviewDiff?.fields ?? [],
        authoritativeCount: prepared.reviewDiff?.fields?.length ?? null }),
      ...groupedDrift
    },
    rejection: { deleteIssueKeys, recreateCount, attachments },
    restoreHistory: await projectRestoreRows(restores, prepared)
  };
}); }

function versionNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || String(value).trim() === '') fail('INVALID_BASELINE_VERSION');
  return number;
}

async function savedSnapshot(baseline) {
  if (baseline.tree_hash) return { baseline, ...await readBaselineTree(baseline.baseline_id) };
  const id = logicalNodeId(baseline.issue_id);
  return { baseline, nodes: [{ logicalNodeId: id, originalIssueId: baseline.issue_id,
    currentIssueId: baseline.issue_id, issueKey: null, parentLogicalNodeId: null,
    projectId: baseline.project_id, issueTypeId: baseline.issue_type_id,
    fieldDigests: baseline.field_digests }],
  values: { [id]: await readAllValues(baseline.issue_id, baseline.version) } };
}

/** Lazy, read-only comparison of two published signatures; no live Jira value becomes either side. */
export async function compareVersions(args) { return respond(async () => {
  const issue = await readableIssue(args);
  const issueId = Number(issue.id);
  const fromVersion = versionNumber(args.payload?.fromVersion);
  const toVersion = versionNumber(args.payload?.toVersion);
  const active = await activeBaseline(issueId);
  if (args.payload?.expectedBaselineVersion != null && Number(args.payload.expectedBaselineVersion) !== Number(active?.version ?? 0)) fail('STALE_EVIDENCE');
  if (!active || fromVersion > Number(active.version) || toVersion > Number(active.version)) fail('BASELINE_VERSION_UNAVAILABLE');
  const [fromBaseline, toBaseline] = await Promise.all([
    baselineByVersion(issueId, fromVersion), baselineByVersion(issueId, toVersion)
  ]);
  if (!fromBaseline || !toBaseline) fail('BASELINE_VERSION_UNAVAILABLE');
  const [from, to] = await Promise.all([savedSnapshot(fromBaseline), savedSnapshot(toBaseline)]);

  // Both historical trees are stored under app authority. Check every node
  // against the viewer's current Jira browse permission before it enters the
  // response. The root's direct asUser issue read already proves root access.
  const all = [...from.nodes, ...to.nodes];
  const checks = await filterViewableTree({ nodes: all.map(node => ({ ...node,
    id: node.currentIssueId ?? node.originalIssueId })) });
  const allowedIds = new Set((checks?.nodes ?? []).map(node => String(node.id)));
  allowedIds.add(String(issueId));
  // A single-issue baseline is saved without its key, and a node with no key
  // was labelled with its internal 64-character id. The root's key is known.
  const named = node => node.issueKey ? node
    : String(node.currentIssueId ?? node.originalIssueId) === String(issueId) ? { ...node, issueKey: issue.key } : node;
  const visible = snapshot => ({ ...snapshot,
    nodes: snapshot.nodes.filter(node => allowedIds.has(String(node.currentIssueId ?? node.originalIssueId))).map(named) });
  // A deleted or now restricted historical child has no current browse grant.
  // Keep its content private, but do not label a partial comparison an exact match.
  const incomplete = visible(from).nodes.length !== from.nodes.length
    || visible(to).nodes.length !== to.nodes.length;
  const scopeKeys = new Map();
  for (const node of [...visible(from).nodes, ...visible(to).nodes]) {
    const projectId = Number(node.projectId ?? issue.fields.project.id);
    const issueTypeId = String(node.issueTypeId ?? issue.fields.issuetype.id);
    scopeKeys.set(`${projectId}:${issueTypeId}`, { projectId, issueTypeId });
  }
  const definitions = (await Promise.all([...scopeKeys.values()].map(scope => controlledFields(scope)))).flat();
  return { ...compareBaselineSnapshots(visible(from), visible(to), definitions), incomplete };
}); }
