import api, { route } from '@forge/api';
import { actorFrom, respond, fail } from './panelAccess.js';
import { grantsFor } from '../lib/reviewer.js';
import { rowAuthorises } from '../lib/eligibility.js';
import { gatedReviewStatuses, gatedTransition } from '../db/configStore.js';
import { driftedInProjects, reviewsByIds } from '../db/itemStateStore.js';
import { activeBaseline, activeBaselines } from '../db/baselineStore.js';
import { availableTransitions } from '../lib/transitions.js';
import { resolveActions } from '../lib/journey.js';

const DRIFT_QUEUE_STATES = new Set(['DRIFTED', 'ERROR']);

export async function list({ payload = {}, context }) { return respond(async () => {
  const actor = actorFrom(context);
  const [grants, scopes] = await Promise.all([grantsFor(actor.accountId), gatedReviewStatuses()]);
  const allowed = scopes.filter(s => grants.some(g => rowAuthorises(g, {
    projectId: s.projectId, issueTypeId: scopeIssueTypeForGrant(s, g), role: s.role })));
  const projects = [...new Set(allowed.map(s => Number(s.projectId)).filter(Number.isFinite))];
  if (!projects.length) return { items: [], nextPageToken: null };
  const drifted = await driftedInProjects(projects);
  const clauses = [...new Set(allowed.map(jqlForScope).filter(Boolean))];
  const ids = drifted.map(r => Number(r.issue_id)).filter(Number.isFinite);
  if (ids.length) clauses.push(`id in (${ids.join(',')})`);
  if (!clauses.length) return { items: [] };
  // Search as the user enforces Browse Projects AND per-issue security before
  // any denormalised queue summary can cross the resolver boundary.
  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      jql: `(${clauses.join(' OR ')}) ORDER BY updated DESC`, fields: ['summary', 'status', 'project', 'issuetype'],
      maxResults: 50, ...(payload.nextPageToken ? { nextPageToken: String(payload.nextPageToken) } : {}) }) });
  if (!response.ok) fail('QUEUE_UNAVAILABLE');
  const page = await response.json();
  const issueIds = (page.issues ?? []).map(i => i.id);
  const [rows, activeMap] = await Promise.all([
    reviewsByIds(issueIds),
    activeBaselines(issueIds).catch(() => new Map())
  ]);
  const byId = new Map(rows.map(r => [String(r.issue_id), r]));
  const resolveOne = async issue => {
    let liveIssue = issue;
    try {
      const liveRes = await api.asUser().requestJira(
        route`/rest/api/3/issue/${issue.key}?fields=summary,status,project,issuetype`
      );
      if (liveRes.ok) {
        liveIssue = await liveRes.json();
      }
    } catch {
      liveIssue = issue;
    }

    const actions = await actionsForIssue(liveIssue, grants);
    const row = byId.get(String(issue.id));
    const active = activeMap.get(Number(issue.id));
    const canReviewDrift = Boolean(row) && DRIFT_QUEUE_STATES.has(row.state)
      && await authorisedForDrift(liveIssue, grants);
    if (!canReviewDrift && actions.length === 0) return null;
    const baselineVersion = active?.version ?? row?.baseline_version ?? 0;
    return { issueId: liveIssue.id, issueKey: liveIssue.key, issue_id: liveIssue.id, issue_key: liveIssue.key,
      summary: liveIssue.fields.summary, status: liveIssue.fields.status.name,
      state: row?.state ?? 'UNAPPROVED', baselineVersion,
      driftCount: Number(row?.drift_count ?? 0), materialCount: Number(row?.drifted_field_count ?? 0),
      maxMateriality: row?.max_materiality ?? null, lastDriftAt: row?.last_drift_at ?? null,
      transitionName: actions[0]?.toStatusName ?? actions[0]?.name ?? null,
      transitionLabel: actions[0]?.label ?? null,
      transitionCount: actions.length };
  };
  // Each issue's actionsForIssue() makes its own live Jira transitions call, so
  // resolving a full 50-issue page in one Promise.all fans out up to 50
  // concurrent Jira requests. Bounded batches, same pattern as
  // trackedFields.js's per-issue-type reads, keep this off Jira's rate limit.
  const QUEUE_RESOLUTION_CONCURRENCY = 5;
  const resolved = [];
  const pageIssues = page.issues ?? [];
  for (let i = 0; i < pageIssues.length; i += QUEUE_RESOLUTION_CONCURRENCY) {
    const batch = pageIssues.slice(i, i + QUEUE_RESOLUTION_CONCURRENCY);
    resolved.push(...await Promise.all(batch.map(resolveOne)));
  }
  const items = resolved.filter(Boolean);
  return { items, nextPageToken: page.nextPageToken ?? null };
}); }

function scopeIssueType(scope) {
  return String(scope.issueTypeId ?? scope.issue_type_id ?? '*');
}

function scopeStatus(scope) {
  return String(scope.statusId ?? scope.from_status_id ?? '*');
}

function scopeIssueTypeForGrant(scope, grant) {
  const issueTypeId = scopeIssueType(scope);
  return issueTypeId === '*' ? grant.issue_type_id : issueTypeId;
}

function jqlForScope(scope) {
  const projectId = Number(scope.projectId);
  if (!Number.isFinite(projectId)) return null;
  const parts = [`project = ${projectId}`];
  const issueTypeId = scopeIssueType(scope);
  if (/^\d+$/.test(issueTypeId)) parts.push(`issuetype = ${issueTypeId}`);
  const statusId = scopeStatus(scope);
  if (/^\d+$/.test(statusId)) parts.push(`status = ${statusId}`);
  return `(${parts.join(' AND ')})`;
}

function issueFacts(issue) {
  return {
    projectId: Number(issue.fields?.project?.id),
    issueTypeId: String(issue.fields?.issuetype?.id ?? ''),
    fromStatusId: String(issue.fields?.status?.id ?? '')
  };
}

/**
 * May this person decide the outstanding drift on this item?
 *
 * NOT "are they an approver out of the status it is in now". A signed item
 * carries its drift wherever it goes, and the status it sits in after approval
 * is by definition the one the approval MOVED it to — so the current status
 * describes an edge that has already been travelled, and matching on it
 * answered no for precisely the items with a decision outstanding.
 *
 * Authority belongs to the gate on the BASELINE's own edge. That is the same
 * question usecases/panelAccess.js asks when it resolves the gate from
 * `baseline.from_status_id -> baseline.to_status_id` ("drift outlives review
 * status"), and the same one the signing path then enforces — so an item
 * offered here is one the reviewer can actually sign.
 *
 * Asked per item rather than from the bulk scope list because va_item_state
 * does not record which edge the baseline was captured on. It runs only for
 * rows already known to be DRIFTED/ERROR, which is a small minority of a page.
 */
async function authorisedForDrift(issue, grants) {
  const { projectId, issueTypeId } = issueFacts(issue);
  if (!Number.isFinite(projectId) || !issueTypeId) return false;
  const baseline = await activeBaseline(Number(issue.id)).catch(() => null);
  if (!baseline) return false;
  // Wildcards are resolved inside gatedTransition, so a concrete baseline edge
  // still matches an "any status -> Done" rule.
  const gate = await gatedTransition({ projectId, issueTypeId,
    fromStatusId: String(baseline.from_status_id), toStatusId: String(baseline.to_status_id),
    transitionId: baseline.transition_id }).catch(() => null);
  if (!gate?.required_role) return false;
  return grants.some(g => rowAuthorises(g, { projectId, issueTypeId, role: gate.required_role }));
}

async function actionsForIssue(issue, grants) {
  const { projectId, issueTypeId, fromStatusId } = issueFacts(issue);
  if (!Number.isFinite(projectId) || !issueTypeId || !fromStatusId) return [];
  let offered = [];
  try {
    offered = await availableTransitions(api, issue.key);
  } catch {
    return [];
  }
  const gates = await Promise.all(offered.map((transition) =>
    gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId: transition.toStatusId, transitionId: transition.id })
      .catch(() => null)
  ));
  const eligible = gates.map(gate => gate
    ? grants.some(g => rowAuthorises(g, { projectId, issueTypeId, role: gate.required_role }))
    : false);
  return resolveActions({ offered, gates, eligible, surface: 'queue' }).actions;
}
