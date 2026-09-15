import api, { route } from '@forge/api';
import { planCapture, FIDELITY } from './baseline.js';
import { fetchChangelog, highestChangelogId } from './changelog.js';
import { assignReviewer } from './reviewer.js';
import { controlledFields, projectConfig, gatedTransition } from '../db/configStore.js';
import { writeBaseline, currentVersion, baselineForApproval } from '../db/baselineStore.js';
import { upsertBaselined, getReview } from '../db/itemStateStore.js';
import { executeQuery, fromBinaryColumn } from './db.js';
import { tryAppend, isDuplicateKey } from '../db/store.js';
import { EVENT } from './ledger.js';
import { scopeFromIssue } from './trackedFields.js';
import { meetsAssurance } from './approval/levels.js';
import { controlledFieldsHash, requireBaselineProvenance } from './baselinePolicy.js';
import {
  beginTreeBaseline,
  publishTreeBaseline,
  verifyTreeCapture,
  writeTreeCapture
} from '../db/baselineTreeStore.js';

const MAX_VERSION_ATTEMPTS = 3;

/**
 * Two DIFFERENT approvals racing the same issue can both read the same
 * MAX(version) before either write commits. idx_baseline_version(issue_id,
 * version) already turns that into a clean duplicate-key error instead of
 * silent corruption — nobody turned it into a retry. Same shape as
 * lib/ledger.js's append(): read again, try again, bounded attempts.
 * A resumed capture (existing.version already fixed) never retries here;
 * only a fresh version allocation can collide.
 */
async function writeWithVersionRetry(currentVersionFn, issueId, initialVersion, attempt) {
  let version = initialVersion;
  let lastError;
  for (let i = 0; i < MAX_VERSION_ATTEMPTS; i++) {
    try {
      return await attempt(version);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      lastError = error;
      // Someone else took that version. Read the table again — a plain
      // increment would just collide a second time.
      version = (await currentVersionFn(issueId)) + 1;
    }
  }
  throw lastError;
}

/** Trigger capture consumes an existing approval; it never manufactures one. */
export async function captureBaseline(args) {
  try { return await run({ now: Date.now(), ...args }); }
  catch (error) {
    console.error('capture failed', args.issueId, error);
    return { captured: false, reason: 'ERROR', error: String(error.message ?? error) };
  }
}

async function run({ issueId, issueKey, transition, transitionAt, now }) {
  const fromStatusId = String(transition?.from?.id ?? transition?.fromStatus?.id ?? '');
  const toStatusId = String(transition?.to?.id ?? transition?.toStatus?.id ?? '');
  const key = issueKey ?? String(issueId);
  const [issue, editmeta, changelog] = await Promise.all([
    readJson(route`/rest/api/3/issue/${key}?fields=*all`),
    readJson(route`/rest/api/3/issue/${key}/editmeta`),
    fetchChangelog(({ startAt, maxResults }) => api.asApp().requestJira(
      route`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=${maxResults}`
    ), { sinceMs: transitionAt - 1000, maxPages: 3 })
  ]);
  if (!issue) return { captured: false, reason: 'ISSUE_UNREADABLE' };
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const [config, declared, gate] = await Promise.all([
    projectConfig(projectId), controlledFields({ projectId, issueTypeId }),
    gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId,
      transitionId: transition?.transitionId ?? transition?.id ?? null })
  ]);
  if (!config.enabled) return { captured: false, reason: 'DISABLED' };
  if (!gate) return { captured: false, reason: 'NOT_A_GATE' };
  if (!gate.capture_baseline) return { captured: false, reason: 'CAPTURE_DISABLED' };
  const consumed = await recentConsumedApproval(issueId, fromStatusId, toStatusId, transitionAt ?? now);
  const approval = approvalFrom(consumed, gate.required_assurance);
  if (!approval.ok) return { captured: false, reason: approval.reason };
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: editmeta?.fields });
  if (gate.capture_baseline && fields.some(f => f.store_values === false || f.store_values === 0)) return { captured: false, reason: 'BASELINE_VALUES_REQUIRED' };
  return writeCapturedBaseline({ issueId, issueKey: issue.key, projectId, issueTypeId,
    controlledFields: fields, issueFields: issue.fields, editmetaFields: editmeta?.fields ?? {},
    transitionAt, capturedAt: now, approver: approval.approver,
    transitionId: transition?.transitionId ?? transition?.id ?? null, fromStatusId, toStatusId,
    changelogEntries: changelog.entries, changelogFailed: changelog.failed || changelog.truncated,
    requiredRole: gate.required_role, requiredAssurance: gate.required_assurance,
    reviewerFieldId: config.reviewerFieldId ?? null });
}

export async function writeCapturedBaseline({ issueId, issueKey, projectId, issueTypeId,
  controlledFields: fields, issueFields, editmetaFields = {}, transitionAt, capturedAt,
  approver, transitionId = null, fromStatusId = null, toStatusId = null,
  changelogEntries = [], changelogFailed = false, requiredRole, requiredAssurance,
  reviewerFieldId = null },
  deps = { baselineForApproval, currentVersion, writeBaseline, assignReviewer, upsertBaselined, tryAppend, getReview }) {
  if (!fields?.length) return { captured: false, reason: 'NO_TRACKED_FIELDS' };
  if (!approver?.approvalId || !approver?.assuranceLevel) return { captured: false, reason: 'NO_APPROVAL' };
  const existing = await deps.baselineForApproval(issueId, approver.approvalId);
  if (existing && !['ACTIVE', 'SUPERSEDED', 'CAPTURING'].includes(existing.state)) {
    return { captured: false, reason: 'CAPTURE_INCOMPLETE' };
  }
  if (existing && existing.state !== 'CAPTURING') {
    const review = await deps.getReview(issueId);
    if (existing.state === 'SUPERSEDED' || Number(review?.baseline_version) >= Number(existing.version)) {
      return { captured: true, alreadyCaptured: true, baselineId: existing.baseline_id,
        version: existing.version, fidelity: existing.fidelity };
    }
  }
  let version = existing?.version ?? (await deps.currentVersion(issueId)) + 1;
  const plan = planCapture({ issueId, issueKey, projectId, issueTypeId, version,
    controlledFields: fields, issueFields, editmetaFields, transitionAt, capturedAt,
    actorId: approver.accountId, actorName: approver.displayName ?? 'Unknown',
    transitionId: String(transitionId ?? ''), fromStatusId, toStatusId,
    requiredRole, requiredAssurance,
    approvalId: approver.approvalId, assuranceLevel: approver.assuranceLevel,
    changelogEntries, changelogFailed });
  try {
    requireBaselineProvenance(plan.baseline);
  } catch (error) {
    if (error?.reason === 'BASELINE_POLICY_INCOMPLETE') {
      return { captured: false, reason: error.reason };
    }
    throw error;
  }
  if ((!existing || existing.state === 'CAPTURING') && (!approver.contentHash || plan.baseline.content_hash !== approver.contentHash)) {
    return { captured: false, reason: 'CONTENT_CHANGED' };
  }
  if ((!existing || existing.state === 'CAPTURING') && plan.baseline.fidelity !== FIDELITY.EXACT) {
    return { captured: false, reason: 'CAPTURE_NOT_EXACT' };
  }
  if (existing?.state === 'CAPTURING' && existing.content_hash !== plan.baseline.content_hash) {
    return { captured: false, reason: 'CAPTURE_INCOMPLETE' };
  }
  const result = existing && existing.state !== 'CAPTURING' ? { baselineId: existing.baseline_id }
    : existing
      ? await deps.writeBaseline({ ...plan, resume: existing })
      : await writeWithVersionRetry(deps.currentVersion, issueId, version, async freshVersion => {
          version = freshVersion;
          return deps.writeBaseline({ ...plan, baseline: { ...plan.baseline, version: freshVersion }, resume: existing });
        });
  const baseline = existing ?? { ...plan.baseline, version };
  const reviewer = await deps.assignReviewer({ baseline, issueFields, projectId, issueTypeId,
    role: requiredRole, reviewerFieldId });
  // An already durable baseline can repair an interrupted publication to item state.
  await deps.upsertBaselined({ issueId, issueKey, projectId, issueTypeId,
    summary: issueFields.summary ?? '', reviewerAccountId: reviewer.accountId,
    reviewerName: reviewer.displayName, baselineId: result.baselineId, baselineVersion: version,
    contentHash: baseline.content_hash, fieldDigests: baseline.field_digests,
    lastChangelogId: highestChangelogId(changelogEntries), now: capturedAt });
  if (!existing || existing.state === 'CAPTURING') {
    await deps.tryAppend({ actorAccountId: approver.accountId, eventType: EVENT.BASELINE_CAPTURED,
      issueId, approvalId: approver.approvalId,
      payload: { version, fidelity: baseline.fidelity, fieldCount: fields.length,
        assuranceLevel: approver.assuranceLevel, fromStatusId, toStatusId } });
    if (baseline.fidelity !== FIDELITY.EXACT) await deps.tryAppend({ actorAccountId: 'system',
      eventType: EVENT.BASELINE_DEGRADED, issueId, payload: { version, fidelity: baseline.fidelity } });
  }
  return { captured: true, alreadyCaptured: !!existing, baselineId: result.baselineId,
    version, fidelity: baseline.fidelity, reviewer: reviewer.accountId };
}

async function recentConsumedApproval(issueId, fromStatusId, toStatusId, at) {
  const result = await executeQuery(`SELECT TO_BASE64(approval_id) AS approval_id,
    actor_account_id, actor_name, assurance_level, decision, state, content_hash
    FROM va_approval WHERE issue_id = ? AND state = 'CONSUMED' AND decision = 'APPROVE'
    AND from_status_id = ? AND to_status_id = ? AND consumed_at >= ? AND consumed_at <= ?
    ORDER BY consumed_at DESC LIMIT 1`, [issueId, fromStatusId, toStatusId, at - 120000, at + 1000]);
  if (!result.result) throw result.error;
  const row = result.data[0];
  return row ? { ...row, approval_id: fromBinaryColumn(row.approval_id) } : null;
}

async function readJson(path) {
  const response = await api.asApp().requestJira(path);
  return response.ok ? response.json() : null;
}

export function approvalFrom(record, requiredAssurance = 'NATIVE_TRANSITION') {
  if (!record?.approval_id) return { ok: false, reason: 'NO_APPROVAL' };
  if (record.decision !== 'APPROVE' || record.state !== 'CONSUMED') return { ok: false, reason: 'NO_APPROVAL' };
  if (!meetsAssurance(record.assurance_level, requiredAssurance)) return { ok: false, reason: 'INSUFFICIENT_ASSURANCE' };
  return { ok: true, approver: { accountId: record.actor_account_id ?? record.account_id,
    displayName: record.actor_name ?? record.printed_name, approvalId: record.approval_id,
    assuranceLevel: record.assurance_level, contentHash: record.content_hash } };
}



export async function writeCapturedTreeBaseline({
  rootIssue, policy, approval, controlledFields, transitionAt, deps = {}
}) {
  const services = {
    baselineForApproval,
    currentVersion,
    beginTreeBaseline,
    writeTreeCapture,
    verifyTreeCapture,
    publishTreeBaseline,
    upsertBaselined,
    tryAppend,
    ...deps
  };

  if (!Array.isArray(controlledFields) || controlledFields.length === 0) {
    return { captured: false, reason: 'NO_TRACKED_FIELDS' };
  }
  const hasUnretained = controlledFields.some(f => f.store_values === false || f.store_values === 0);
  if (hasUnretained) {
    return { captured: false, reason: 'BASELINE_VALUES_REQUIRED' };
  }
  if (!approval?.approvalId || !approval.accountId || !approval.displayName
    || !approval.assuranceLevel || !approval.content_hash) {
    return { captured: false, reason: 'NO_APPROVAL' };
  }

  const existing = await services.baselineForApproval(rootIssue.id, approval.approvalId);
  if (existing && existing.state !== 'CAPTURING') {
    if (!['ACTIVE', 'SUPERSEDED'].includes(existing.state)
      || !existing.tree_hash
      || existing.content_hash !== approval.content_hash
      || existing.tree_hash !== existing.content_hash
      || Number(existing.node_count) < 1
      || Number(existing.total_field_count) < 1) {
      return { captured: false, reason: 'CAPTURE_INCOMPLETE' };
    }
    // Publication precedes the item-state index write. If that final write
    // failed, a retry must repair the index without rereading Jira or creating
    // another baseline. Never point the index at an older SUPERSEDED version.
    if (existing.state === 'ACTIVE') {
      await services.upsertBaselined({
        issueId: Number(existing.issue_id ?? rootIssue.id),
        issueKey: rootIssue.key,
        projectId: Number(existing.project_id ?? rootIssue.fields?.project?.id),
        issueTypeId: String(existing.issue_type_id ?? rootIssue.fields?.issuetype?.id ?? ''),
        summary: rootIssue.fields?.summary ?? '',
        reviewerAccountId: existing.approved_by ?? approval.accountId,
        reviewerName: existing.approved_name ?? approval.displayName,
        baselineId: existing.baseline_id,
        baselineVersion: Number(existing.version),
        contentHash: existing.content_hash,
        fieldDigests: typeof existing.field_digests === 'string'
          ? existing.field_digests : JSON.stringify(existing.field_digests ?? {}),
        lastChangelogId: null,
        now: existing.captured_at ?? transitionAt ?? Date.now()
      });
    }
    return {
      captured: true,
      alreadyCaptured: true,
      baselineId: existing.baseline_id,
      version: Number(existing.version),
      treeHash: existing.tree_hash,
      nodeCount: Number(existing.node_count),
      fieldCount: Number(existing.total_field_count)
    };
  }

  const provenance = {
    transition_id: policy?.transition_id ?? null,
    from_status_id: policy?.from_status_id ?? null,
    to_status_id: policy?.to_status_id ?? null,
    required_role: policy?.required_role ?? null,
    required_assurance: policy?.required_assurance ?? null,
    controlled_fields_hash: controlledFieldsHash(controlledFields)
  };
  try {
    requireBaselineProvenance(provenance);
  } catch (error) {
    if (error?.reason === 'BASELINE_POLICY_INCOMPLETE') {
      return { captured: false, reason: error.reason };
    }
    throw error;
  }

  const fieldIds = [...new Set([
    ...controlledFields.map(field => field.field_id),
    'project', 'issuetype', 'status', 'parent'
  ])];
  const stable = await services.readStableTree({
    readTree: services.readTree, rootIssueKey: rootIssue.key, fieldIds
  });
  const treePlan = services.planTreeCapture({
    rootIssueId: rootIssue.id, nodes: stable.tree.nodes, controlledFields
  });
  if (treePlan.treeHash !== approval.content_hash) {
    return { captured: false, reason: 'CONTENT_CHANGED' };
  }

  if (existing?.content_hash && existing.content_hash !== treePlan.treeHash) {
    return { captured: false, reason: 'CAPTURE_INCOMPLETE' };
  }

  let version = existing?.version ?? (await services.currentVersion(rootIssue.id)) + 1;
  const rootNode = treePlan.nodes.find(node => Number(node.originalIssueId) === Number(rootIssue.id));
  if (!rootNode) return { captured: false, reason: 'CAPTURE_INCOMPLETE' };
  const capturedAt = Date.now();
  const baseline = {
    issue_id: Number(rootIssue.id),
    issue_key: rootIssue.key,
    project_id: rootNode.projectId,
    issue_type_id: rootNode.issueTypeId,
    version: Number(version),
    state: 'CAPTURING',
    content_hash: treePlan.treeHash,
    field_digests: '{}',
    ...provenance,
    approved_by: approval.accountId,
    approved_name: approval.displayName,
    transition_at: transitionAt,
    captured_at: capturedAt,
    assurance_level: approval.assuranceLevel,
    approval_id: approval.approvalId,
    fidelity: FIDELITY.EXACT,
    field_count: treePlan.totalFieldCount,
    value_bytes: 0,
    tree_hash: treePlan.treeHash,
    node_count: treePlan.nodeCount,
    edge_count: treePlan.edgeCount,
    total_field_count: treePlan.totalFieldCount
  };

  const reserved = existing
    ? await services.beginTreeBaseline({ baseline, resume: existing })
    : await writeWithVersionRetry(services.currentVersion, rootIssue.id, version, async freshVersion => {
        version = freshVersion;
        return services.beginTreeBaseline({ baseline: { ...baseline, version: Number(freshVersion) }, resume: existing });
      });
  const stored = await services.writeTreeCapture({
    baselineId: reserved.baselineId,
    treeHash: treePlan.treeHash,
    nodes: treePlan.nodes,
    values: treePlan.values
  });
  await services.verifyTreeCapture({
    baselineId: reserved.baselineId,
    expectedNodeCount: treePlan.nodeCount,
    expectedFieldCount: treePlan.totalFieldCount,
    expectedTreeHash: treePlan.treeHash
  });
  await services.publishTreeBaseline({
    baselineId: reserved.baselineId,
    issueId: Number(rootIssue.id),
    version: Number(version)
  });

  await services.upsertBaselined({
    issueId: Number(rootIssue.id),
    issueKey: rootIssue.key,
    projectId: rootNode.projectId,
    issueTypeId: rootNode.issueTypeId,
    summary: rootIssue.fields?.summary ?? '',
    reviewerAccountId: approval.accountId,
    reviewerName: approval.displayName,
    baselineId: reserved.baselineId,
    baselineVersion: Number(version),
    contentHash: treePlan.treeHash,
    // va_item_state.field_digests is a JSON/TEXT column. Forge SQL rejects
    // plain objects as bound parameters; the tree values themselves remain
    // stored in the per-node value table above.
    fieldDigests: JSON.stringify({}),
    lastChangelogId: null,
    now: capturedAt
  });
  if (services.tryAppend) {
    await services.tryAppend({
      actorAccountId: approval.accountId,
      eventType: EVENT.BASELINE_CAPTURED,
      issueId: Number(rootIssue.id),
      approvalId: approval.approvalId,
      payload: {
        treeHash: treePlan.treeHash,
        nodeCount: treePlan.nodeCount,
        fieldCount: treePlan.totalFieldCount,
        assuranceLevel: approval.assuranceLevel,
        fromStatusId: policy?.from_status_id ?? null,
        toStatusId: policy?.to_status_id ?? null
      }
    });
  }

  return {
    captured: true,
    nodeCount: treePlan.nodeCount,
    fieldCount: treePlan.totalFieldCount,
    baselineId: reserved.baselineId,
    version: Number(version),
    valueBytes: stored.valueBytes,
    treeHash: treePlan.treeHash
  };
}
