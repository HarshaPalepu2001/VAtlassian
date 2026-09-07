import api from '@forge/api';
import { load, respond, actorFrom, fail } from './panelAccess.js';
import { getReview } from '../db/itemStateStore.js';
import { baselineHistory } from '../db/baselineStore.js';
import { buildRecord } from '../lib/record.js';
import { availableTransitions } from '../lib/transitions.js';
import { gatedTransition } from '../db/configStore.js';
import { isEligible } from '../lib/reviewer.js';
import { approvalById } from '../db/approvalStore.js';

export async function getState(args) { return respond(async () => {
  const state = await load(args);
  const { issue, baseline, actor, projectId, issueTypeId } = state;
  const [history, available, approvalRecord] = await Promise.all([
    baselineHistory(state.issueId), availableTransitions(api, issue.key),
    baseline?.approval_id ? approvalById(baseline.approval_id) : null
  ]);
  const transitions = [];
  for (const transition of available) {
    const gate = await gatedTransition({ projectId, issueTypeId,
      fromStatusId: String(issue.fields.status?.id), toStatusId: transition.toStatusId });
    if (!gate) continue;
    transitions.push({ transitionId: transition.id, toStatusId: transition.toStatusId,
      name: transition.name, requiredRole: gate.required_role, requiredAssurance: gate.required_assurance, meaning: gate.meaning ?? 'Approved',
      eligible: await isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: gate.required_role }) });
  }
  const record = buildRecord({ baseline, controlledFields: state.fields, baselineValues: state.baselineValues,
    digests: baseline ? JSON.parse(baseline.field_digests || '{}') : {}, approval: approvalRecord });
  if (record) record.history = history;
  const extractText = (doc) => {
    if (!doc || !doc.content) return '';
    return doc.content.map(c => (c.type === 'paragraph' ? (c.content || []).map(n => n.text).join('') : '')).join('\n').trim();
  };
  const desc = extractText(issue.fields.description);
  const descriptionTruncated = desc.length > 500;
  const descriptionEmpty = desc.length === 0;
  const description = descriptionTruncated ? desc.substring(0, 500) + '…' : desc;

  return { issue: { id: issue.id, key: issue.key, summary: issue.fields.summary, status: issue.fields.status,
    description, descriptionEmpty, descriptionTruncated, assignee: issue.fields.assignee, reporter: issue.fields.reporter },
    eligibility: { eligible: state.eligible, reason: state.eligible ? null : 'NOT_ELIGIBLE' },
    approval: { requiredRole: state.gate?.required_role ?? null, requiredAssurance: state.gate?.required_assurance ?? transitions[0]?.requiredAssurance ?? 'ESIGNATURE',
      pending: null, meaning: 'Approved' }, record, actorName: actor.displayName,
    drift: { count: state.diff?.changedFieldCount ?? 0, materialCount: state.diff?.materialFieldCount ?? 0,
      evidenceHash: state.evidenceHash, fields: state.diff?.fields ?? [] }, transitions };
}); }

/** Rendered on every issue view: exactly one primary-key read, no Jira fan-out. */
export async function getGlanceState({ context }) { return respond(async () => {
  actorFrom(context);
  const issueId = context.extension?.issue?.id;
  if (!issueId) fail('ISSUE_CONTEXT_REQUIRED');
  const row = await getReview(Number(issueId));
  return { state: row?.state ?? 'UNAPPROVED', baselineVersion: row?.baseline_version ?? null,
    driftCount: Number(row?.drift_count ?? 0), materialCount: Number(row?.drifted_field_count ?? 0),
    maxMateriality: row?.max_materiality ?? null };
}); }
