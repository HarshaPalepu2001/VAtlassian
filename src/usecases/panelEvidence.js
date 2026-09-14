import { load, respond, fail } from './panelAccess.js';
import { baselineHistory } from '../db/baselineStore.js';
import { restoresForIssue } from '../db/restoreStore.js';
import { approvalById } from '../db/approvalStore.js';
import { buildRecord } from '../lib/record.js';

/**
 * THE HEAVY READ — recursive tree, retained values, changelog attribution,
 * full differences, baseline history, and restoration history.
 *
 * Loaded after the summary, or when the evidence section opens. Uses
 * panelAccess.js's snapshot() mechanics unchanged: this module adds no new
 * Jira or SQL reads of its own beyond the two narrow history lists, it only
 * shapes what snapshot() already produces into the evidence half of the panel
 * model. Every approval challenge/submit/retry still performs its own fresh
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

  const record = buildRecord({ baseline, controlledFields: prepared.fields, baselineValues: prepared.baselineValues,
    digests: baseline ? JSON.parse(baseline.field_digests || '{}') : {}, approval: approvalRecord });
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
  const { groupedDrift, deleteIssueKeys, recreateCount } = buildTreeRejection(prepared);

  return {
    baselineId: baseline?.baseline_id ? Buffer.from(baseline.baseline_id).toString('hex') : null,
    baselineVersion: baseline?.version ?? 0,
    evidenceHash: prepared.evidenceHash ?? null,
    description, descriptionEmpty, descriptionTruncated,
    assignee: issue.fields.assignee, reporter: issue.fields.reporter,
    record,
    drift: { fields: prepared.diff?.fields ?? [], ...groupedDrift },
    rejection: { deleteIssueKeys, recreateCount },
    restoreHistory: restores
  };
}); }
