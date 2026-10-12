import api, { route } from '@forge/api';
import { planCapture, FIDELITY } from './baseline.js';
import { fetchChangelog, highestChangelogId } from './changelog.js';
import { assignReviewer } from './reviewer.js';
import { controlledFields, projectConfig, gatedTransition } from '../db/configStore.js';
import { writeBaseline, currentVersion, baselineForApproval, activeBaselines } from '../db/baselineStore.js';
import { upsertBaselined, getReview } from '../db/itemStateStore.js';
import { executeQuery, fromBinaryColumn } from './db.js';
import { tryAppend, isDuplicateKey } from '../db/store.js';
import { EVENT } from './ledger.js';
import { scopeFromIssue } from './trackedFields.js';
import { meetsAssurance } from './approval/levels.js';
import { controlledFieldsHash, requireBaselineProvenance } from './baselinePolicy.js';
import { readTreeWithNodeFields, fieldScope } from './tree/nodeFields.js';
import { canonicaliseIssue, recordedAttachments } from './attachmentIdentity.js';
import { FailClosed } from './errors.js';
import { versionEvidence, linkRows, trackedLinks, linkedIssueIds, CAUSE } from './evidence/versionEvidence.js';
import { treeCaptureEvidence, nodeSecurityLevels } from './evidence/treeEvidence.js';
import { writeVersionEvidence, pinChildVersions, recordNodeSecurity } from '../db/evidenceStore.js';
import { planChildBaselines, nextVersions, writeChildBaselines, publishChildBaselines } from '../db/childBaselineStore.js';
import {
  activeRootsForNode,
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

/** A capture that threw: a governed refusal keeps its reason, so the trigger retries it as that. */
export function captureFailure(error) {
  return { captured: false, reason: error instanceof FailClosed ? error.reason : 'ERROR',
    error: String(error?.message ?? error) };
}

/** Trigger capture consumes an existing approval; it never manufactures one. */
export async function captureBaseline(args) {
  try { return await run({ now: Date.now(), ...args }); }
  catch (error) {
    console.error('capture failed', args.issueId, error);
    return captureFailure(error);
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
  await canonicaliseIssue(issue);
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const [config, scoped, gate] = await Promise.all([
    // The same set the validator's signature check hashed (approval/runtime.js).
    projectConfig(projectId),
    fieldScope({ issueId: Number(issue.id), projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
    gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId,
      transitionId: transition?.transitionId ?? transition?.id ?? null })
  ]);
  const declared = scoped.fields;
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
    reviewerFieldId: config.reviewerFieldId ?? null,
    ruleScope: scoped.ruleScope, cause: CAUSE.OWN_TRANSITION });
}

export async function writeCapturedBaseline({ issueId, issueKey, projectId, issueTypeId,
  controlledFields: fields, issueFields, editmetaFields = {}, transitionAt, capturedAt,
  approver, transitionId = null, fromStatusId = null, toStatusId = null,
  changelogEntries = [], changelogFailed = false, requiredRole, requiredAssurance,
  reviewerFieldId = null, cause = CAUSE.OWN_TRANSITION, ruleScope = null },
  deps = { baselineForApproval, currentVersion, writeBaseline, assignReviewer, upsertBaselined, tryAppend, getReview,
    activeBaselines }) {
  if (!fields?.length) return { captured: false, reason: 'NO_TRACKED_FIELDS' };
  if (!approver?.approvalId || !approver?.assuranceLevel) return { captured: false, reason: 'NO_APPROVAL' };
  // Which rule required these fields is part of the record (evidence/versionEvidence.js).
  if (!ruleScope) return { captured: false, reason: 'BASELINE_POLICY_INCOMPLETE' };
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
  // THE EVIDENCE THIS VERSION PUBLISHES WITH. Built from exactly what was
  // projected and checked above; writeBaseline writes it before publishing and
  // refuses to publish without it.
  const writesVersion = !existing || existing.state === 'CAPTURING';
  let evidence = null;
  if (writesVersion) {
    const links = trackedLinks(fields, issueFields);
    const others = linkedIssueIds(links);
    const otherVersions = others.length ? await deps.activeBaselines(others) : new Map();
    evidence = {
      required: true,
      cause,
      links: linkRows({ links, otherVersions }),
      evidence: versionEvidence({
        fields, digests: plan.digests, writable: plan.writable,
        rule: { ...ruleScope, transitionId, approvers: [{ role: requiredRole, assurance: requiredAssurance }],
          controlledFieldsHash: plan.baseline.controlled_fields_hash },
        signature: { approvalId: approver.approvalId, signerAccountId: approver.accountId,
          signerName: approver.displayName, role: requiredRole, assurance: approver.assuranceLevel,
          cause, transitionId, fromStatusId, toStatusId, transitionAt,
          statusAtCapture: issueFields?.status?.id ?? null, signedAt: capturedAt }
      })
    };
  }
  const result = existing && existing.state !== 'CAPTURING' ? { baselineId: existing.baseline_id }
    : existing
      ? await deps.writeBaseline({ ...plan, resume: existing, evidence })
      : await writeWithVersionRetry(deps.currentVersion, issueId, version, async freshVersion => {
          version = freshVersion;
          return deps.writeBaseline({ ...plan, baseline: { ...plan.baseline, version: freshVersion }, resume: existing, evidence });
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
    version, fidelity: baseline.fidelity, reviewer: reviewer.accountId,
    attachments: recordedAttachments(plan.raw, fields) };
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



// `expectedTreeHash`: a per-field decision signs the candidate hash but captures its verified post-restore state.
export async function writeCapturedTreeBaseline({
  rootIssue, policy, approval, controlledFields, transitionAt, ruleScope = null, cause = CAUSE.OWN_TRANSITION, deps = {}, expectedTreeHash = null
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
    nextVersions,
    writeChildBaselines,
    publishChildBaselines,
    getReview,
    writeVersionEvidence,
    pinChildVersions,
    recordNodeSecurity,
    activeBaselines,
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
  // Which rule required these fields is part of every record this writes.
  if (!ruleScope) return { captured: false, reason: 'BASELINE_POLICY_INCOMPLETE' };

  const existing = await services.baselineForApproval(rootIssue.id, approval.approvalId);
  if (existing && existing.state !== 'CAPTURING') {
    if (!['ACTIVE', 'SUPERSEDED'].includes(existing.state)
      || !existing.tree_hash
      || (expectedTreeHash == null && existing.content_hash !== approval.content_hash)
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
      // Children publish after their parent. A retry after a failure between
      // the two finishes the job; publication is idempotent.
      if (Number(existing.node_count) > 1) {
        const { children } = await services.publishChildBaselines({ parentBaselineId: existing.baseline_id });
        for (const child of children) {
          const review = await services.getReview(child.issue_id);
          await publishChildItemState(services,
            { ...child, issue_key: child.issue_key ?? review?.issue_key ?? String(child.issue_id) },
            { summary: review?.summary ?? '', approval,
            now: existing.captured_at ?? Date.now() });
        }
      }
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

  // Every node with the ROOT's fields: the parent's signature authenticates
  // each child's content over the fields the parent is approved on, which is
  // what the child's own baseline below records.
  const stable = await readTreeWithNodeFields({
    readStableTree: services.readStableTree, readTree: services.readTree,
    rootIssueKey: rootIssue.key, rootFields: controlledFields, extraFieldIds: ['status', 'parent', 'security']
  });
  const { fieldsFor } = stable;
  const nodeOf = issueId => stable.tree.nodes.find(node => Number(node.id) === Number(issueId));
  const treePlan = services.planTreeCapture({
    rootIssueId: rootIssue.id, nodes: stable.tree.nodes, controlledFields, fieldsFor
  });
  if (treePlan.treeHash !== (expectedTreeHash ?? approval.content_hash)) {
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

  // EVERY CHILD GETS ITS OWN BASELINE (db/childBaselineStore.js), at its own
  // next version, over its own fields, authenticated by this approval. Written
  // before the parent publishes and published after it, so a child never has a
  // standing baseline from a parent capture that did not complete.
  const childRows = planChildBaselines({ treePlan, rootIssueId: rootIssue.id, fieldsFor, nodeOf,
    parent: { baselineId: reserved.baselineId, approvalId: approval.approvalId, accountId: approval.accountId,
      displayName: approval.displayName, assuranceLevel: approval.assuranceLevel, policy,
      transitionAt, capturedAt },
    nextVersion: childRowsNeeded(treePlan, rootIssue.id)
      ? await services.nextVersions(treePlan.nodes.map(node => node.currentIssueId ?? node.originalIssueId))
      : () => 1 });
  const children = childRows.length
    ? await services.writeChildBaselines({ rows: childRows, parentBaselineId: reserved.baselineId })
    : [];

  // THE EVIDENCE OF EVERY VERSION THIS CAPTURE WRITES (evidence/treeEvidence.js),
  // before anything publishes: publication requires it.
  await services.writeVersionEvidence({ entries: await treeCaptureEvidence({
    rootIssueId: rootIssue.id, parentBaselineId: reserved.baselineId, parentVersion: version,
    rootDigests: rootNode.fieldDigests, controlledFields, children, nodeOf, fieldsFor, ruleScope, cause, policy, approval,
    transitionAt, signedAt: capturedAt, controlledFieldsHash: provenance.controlled_fields_hash,
    activeBaselines: services.activeBaselines }) });
  if (children.length) {
    await services.pinChildVersions({ parentBaselineId: reserved.baselineId,
      pins: children.map(child => ({ issueId: child.issue_id, baselineId: child.baseline_id, version: child.version })) });
  }
  // An unseen level is UNKNOWN, not "no level" (evidence/treeEvidence.js).
  await services.recordNodeSecurity({ baselineId: reserved.baselineId, levels: nodeSecurityLevels(stable.tree.nodes) });

  await services.publishTreeBaseline({
    baselineId: reserved.baselineId,
    issueId: Number(rootIssue.id),
    version: Number(version),
    requireEvidence: true
  });
  if (children.length) await services.publishChildBaselines({ parentBaselineId: reserved.baselineId, requireEvidence: true });

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
        toStatusId: policy?.to_status_id ?? null,
        childBaselines: children.length
      }
    });
  }
  for (const child of children) {
    await publishChildItemState(services, child, { summary: child.summary, approval, now: capturedAt });
    if (services.tryAppend) {
      await services.tryAppend({
        actorAccountId: approval.accountId,
        eventType: EVENT.BASELINE_CAPTURED,
        issueId: Number(child.issue_id),
        approvalId: approval.approvalId,
        payload: {
          version: Number(child.version),
          fidelity: FIDELITY.EXACT,
          fieldCount: child.field_count,
          assuranceLevel: approval.assuranceLevel,
          capturedBy: { issueId: Number(rootIssue.id), issueKey: rootIssue.key, version: Number(version) }
        }
      });
    }
  }

  // What each new baseline recorded as its files: the vault copies exactly
  // these (jobs/vaultWorker.js), for the parent and for every child.
  return {
    captured: true,
    children: children.map(child => ({ issueId: Number(child.issue_id), version: Number(child.version),
      baselineId: child.baseline_id, issueKey: child.issue_key, projectId: Number(child.project_id),
      attachments: recordedAttachments(child.raw, fieldsFor(nodeOf(child.issue_id)
        ?? { projectId: child.project_id, issueTypeId: child.issue_type_id })) })),
    attachments: recordedAttachments(treePlan.values?.[rootNode.logicalNodeId], controlledFields),
    nodeCount: treePlan.nodeCount,
    fieldCount: treePlan.totalFieldCount,
    baselineId: reserved.baselineId,
    version: Number(version),
    valueBytes: stored.valueBytes,
    treeHash: treePlan.treeHash
  };
}

/** Whether any non-root node was captured at all: only then are versions read. */
function childRowsNeeded(treePlan, rootIssueId) {
  return (treePlan?.nodes ?? []).some(node => Number(node.originalIssueId) !== Number(rootIssueId));
}

/** A child baselined by its parent's capture joins the queue index as BASELINED. */
async function publishChildItemState(services, child, { summary, approval, now }) {
  await services.upsertBaselined({
    issueId: Number(child.issue_id),
    issueKey: child.issue_key,
    projectId: Number(child.project_id),
    issueTypeId: String(child.issue_type_id),
    summary: summary ?? '',
    reviewerAccountId: approval.accountId,
    reviewerName: approval.displayName,
    baselineId: child.baseline_id,
    baselineVersion: Number(child.version),
    contentHash: child.content_hash,
    fieldDigests: typeof child.field_digests === 'string' ? child.field_digests : JSON.stringify(child.field_digests ?? {}),
    lastChangelogId: null,
    now
  });
}
