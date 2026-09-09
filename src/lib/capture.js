import api, { route } from '@forge/api';
import { planCapture, FIDELITY } from './baseline.js';
import { fetchChangelog, highestChangelogId } from './changelog.js';
import { assignReviewer } from './reviewer.js';
import { controlledFields, projectConfig, gatedTransition } from '../db/configStore.js';
import { writeBaseline, currentVersion, baselineForApproval } from '../db/baselineStore.js';
import { upsertBaselined, getReview } from '../db/itemStateStore.js';
import { executeQuery, fromBinaryColumn } from './db.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';
import { scopeFromIssue } from './trackedFields.js';
import { meetsAssurance } from './approval/levels.js';

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
    gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId })
  ]);
  if (!config.enabled) return { captured: false, reason: 'DISABLED' };
  if (!gate) return { captured: false, reason: 'NOT_A_GATE' };
  if (!gate.capture_baseline) return { captured: false, reason: 'CAPTURE_DISABLED' };
  const consumed = await recentConsumedApproval(issueId, fromStatusId, toStatusId, transitionAt ?? now);
  const approval = approvalFrom(consumed, gate.required_assurance);
  if (!approval.ok) return { captured: false, reason: approval.reason };
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: editmeta?.fields });
  return writeCapturedBaseline({ issueId, issueKey: issue.key, projectId, issueTypeId,
    controlledFields: fields, issueFields: issue.fields, editmetaFields: editmeta?.fields ?? {},
    transitionAt, capturedAt: now, approver: approval.approver,
    transitionId: transition?.transitionId ?? transition?.id ?? null, fromStatusId, toStatusId,
    changelogEntries: changelog.entries, changelogFailed: changelog.failed || changelog.truncated,
    requiredRole: gate.required_role, reviewerFieldId: config.reviewerFieldId ?? null });
}

export async function writeCapturedBaseline({ issueId, issueKey, projectId, issueTypeId,
  controlledFields: fields, issueFields, editmetaFields = {}, transitionAt, capturedAt,
  approver, transitionId = null, fromStatusId = null, toStatusId = null,
  changelogEntries = [], changelogFailed = false, requiredRole, reviewerFieldId = null },
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
  const version = existing?.version ?? (await deps.currentVersion(issueId)) + 1;
  const plan = planCapture({ issueId, issueKey, projectId, issueTypeId, version,
    controlledFields: fields, issueFields, editmetaFields, transitionAt, capturedAt,
    actorId: approver.accountId, actorName: approver.displayName ?? 'Unknown',
    transitionId: String(transitionId ?? ''), fromStatusId, toStatusId,
    approvalId: approver.approvalId, assuranceLevel: approver.assuranceLevel,
    changelogEntries, changelogFailed });
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
    : await deps.writeBaseline({ ...plan, resume: existing });
  const baseline = existing ?? plan.baseline;
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
