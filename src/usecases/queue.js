import api, { route } from '@forge/api';
import { actorFrom, respond, fail } from './panelAccess.js';
import { grantsFor } from '../lib/reviewer.js';
import { rowAuthorises } from '../lib/eligibility.js';
import { gatedReviewStatuses } from '../db/configStore.js';
import { driftedInProjects, reviewsByIds } from '../db/itemStateStore.js';

export async function list({ payload = {}, context }) { return respond(async () => {
  const actor = actorFrom(context);
  const [grants, scopes] = await Promise.all([grantsFor(actor.accountId), gatedReviewStatuses()]);
  const allowed = scopes.filter(s => grants.some(g => rowAuthorises(g, {
    projectId: s.projectId, issueTypeId: g.issue_type_id, role: s.role })));
  const projects = [...new Set(allowed.map(s => Number(s.projectId)).filter(Number.isFinite))];
  if (!projects.length) return { items: [], nextPageToken: null };
  const drifted = await driftedInProjects(projects);
  const clauses = allowed.filter(s => /^\d+$/.test(s.statusId)).map(s =>
    `(project = ${Number(s.projectId)} AND status = ${s.statusId})`);
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
  const rows = await reviewsByIds((page.issues ?? []).map(i => i.id));
  const byId = new Map(rows.map(r => [String(r.issue_id), r]));
  const items = (page.issues ?? []).filter(issue => allowed.some(s =>
    Number(issue.fields.project.id) === Number(s.projectId) && grants.some(g => rowAuthorises(g, {
      projectId: s.projectId, issueTypeId: String(issue.fields.issuetype.id), role: s.role })))).map(issue => {
    const row = byId.get(String(issue.id));
    return { issueId: issue.id, issueKey: issue.key, issue_id: issue.id, issue_key: issue.key,
      summary: issue.fields.summary, status: issue.fields.status.name,
      state: row?.state ?? 'UNAPPROVED', baselineVersion: row?.baseline_version ?? 0,
      driftCount: Number(row?.drift_count ?? 0), materialCount: Number(row?.drifted_field_count ?? 0),
      maxMateriality: row?.max_materiality ?? null, lastDriftAt: row?.last_drift_at ?? null };
  });
  return { items, nextPageToken: page.nextPageToken ?? null };
}); }
