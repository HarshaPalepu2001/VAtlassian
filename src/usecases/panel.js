import api from '@forge/api';
import { load, respond, actorFrom, fail } from './panelAccess.js';
import { getReview } from '../db/itemStateStore.js';
import { baselineHistory } from '../db/baselineStore.js';
import { buildRecord } from '../lib/record.js';
import { availableTransitions } from '../lib/transitions.js';
import { gatedTransition } from '../db/configStore.js';
import { isEligible } from '../lib/reviewer.js';
import { approvalById, pendingApprovalForActor } from '../db/approvalStore.js';
import { issueControlStatus } from '../db/incidentStore.js';
import { credentialState } from '../db/credentialStore.js';

export async function getState(args) { return respond(async () => {
  const state = await load(args);
  const { issue, baseline, actor, projectId, issueTypeId } = state;
  const [history, available, approvalRecord, controls, stranded, credential] = await Promise.all([
    baselineHistory(state.issueId), availableTransitions(api, issue.key),
    baseline?.approval_id ? approvalById(baseline.approval_id) : null,
    issueControlStatus({ issueId: state.issueId, projectId, issueTypeId }).catch(() => ({ unavailable: true, incidents: [], gateFindings: [] })),
    // A recorded approval whose Jira transition did not land. Held in component
    // state by the panel, which does not survive a reload — so without this the
    // reviewer's only route back to approval:retryTransition disappears.
    pendingApprovalForActor({ issueId: state.issueId, accountId: actor.accountId,
      fromStatusId: String(issue.fields.status?.id) }).catch(() => null),
    // Whether this reviewer can sign at all. Unreadable is left `undefined`
    // rather than false: telling an enrolled signer to go and enrol is worse
    // than saying nothing, and the panel's notice keys on `=== false`.
    credentialState(actor.accountId).then(row => row?.state === 'ACTIVE').catch(() => undefined)
  ]);
  // Look up all gates in parallel, then check eligibility for confirmed gates
  // in parallel. The original serial for-loop did await gatedTransition() +
  // await isEligible() per transition, costing 2×N sequential round trips.
  // Promise.all fires them all at once; the memo in gatedTransition / getConfig
  // means most will be served from the in-process cache.
  const gateResults = await Promise.all(
    available.map((transition) =>
      gatedTransition({ projectId, issueTypeId,
        fromStatusId: String(issue.fields.status?.id), toStatusId: transition.toStatusId, transitionId: transition.id })
    )
  );
  const eligibilityResults = await Promise.all(
    gateResults.map((gate) =>
      gate ? isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: gate.required_role }) : false
    )
  );
  const transitions = [];
  for (let i = 0; i < available.length; i++) {
    const gate = gateResults[i];
    if (!gate) continue;
    transitions.push({ transitionId: available[i].id, toStatusId: available[i].toStatusId,
      name: available[i].name, requiredRole: gate.required_role, requiredAssurance: gate.required_assurance, meaning: gate.meaning ?? 'Approved',
      eligible: eligibilityResults[i] });
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
      pending: pendingApproval(stranded, transitions), meaning: 'Approved' }, record, actorName: actor.displayName,
    credentialEnrolled: credential,
    drift: { count: state.diff?.changedFieldCount ?? 0, materialCount: state.diff?.materialFieldCount ?? 0,
      evidenceHash: state.evidenceHash, fields: state.diff?.fields ?? [] }, transitions, controls };
}); }

/**
 * The stranded approval, only if retrying it could actually work.
 *
 * retryTransition resolves the transition by id and requires its to-status to
 * match the signed row. If Jira is no longer offering that transition the retry
 * is certain to be refused, and a button that cannot succeed is worse than no
 * button — so it is not advertised.
 */
function pendingApproval(row, transitions) {
  if (!row?.approval_id || !row.transition_id) return null;
  const offered = transitions.some(t => t.transitionId === String(row.transition_id)
    && String(t.toStatusId) === String(row.to_status_id));
  if (!offered) return null;
  return { approvalId: Buffer.from(row.approval_id).toString('hex'),
    transitionId: String(row.transition_id), state: row.state, expiresAt: Number(row.expires_at) };
}

/** Rendered on every issue view: exactly one primary-key read, no Jira fan-out. */
export async function getGlanceState({ context }) { return respond(async () => {
  actorFrom(context);
  const issueId = context.extension?.issue?.id;
  if (!issueId) fail('ISSUE_CONTEXT_REQUIRED');
  const [row, controls] = await Promise.all([
    getReview(Number(issueId)),
    issueControlStatus({ issueId: Number(issueId), projectId: context.extension?.project?.id,
      issueTypeId: context.extension?.issue?.typeId })
  ]);
  return { state: row?.state ?? 'UNAPPROVED', baselineVersion: row?.baseline_version ?? null,
    driftCount: Number(row?.drift_count ?? 0), materialCount: Number(row?.drifted_field_count ?? 0),
    maxMateriality: row?.max_materiality ?? null, controls };
}); }
