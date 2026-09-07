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

export function fail(reason) { const error = new Error(reason); error.reason = reason; throw error; }
export function actorFrom(context) {
  if (!context?.accountId) fail('AUTHENTICATION_REQUIRED');
  return { accountId: context.accountId };
}
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
export async function snapshot({ issue, actor, requireAuthority = false, expectedEvidenceHash, includeChangelog = true }) {
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
  let gate = edge.gated ? edge : null;
  if (!gate && baseline) gate = await gatedTransition({ projectId, issueTypeId,
    fromStatusId: baseline.from_status_id, toStatusId: baseline.to_status_id });
  // Drift outlives review status. Resolve authority from configured scope, never assignment.
  if (!gate && baseline) {
    const gates = await listGatedTransitions(projectId);
    gate = gates.find(row => row.state === 'ACTIVE' && [issueTypeId, '*'].includes(String(row.issue_type_id)));
  }
  const eligible = !!gate && await isEligible({ accountId: actor.accountId, projectId, issueTypeId, role: gate.required_role });
  if (requireAuthority && (!config.enabled || !eligible)) fail(config.enabled ? 'NOT_ELIGIBLE' : 'DISABLED');
  if (requireAuthority && !fields.length) fail('NO_TRACKED_FIELDS');
  const [baselineValues, driftRows, changelog] = baseline ? await Promise.all([
    readAllValues(issueId, baseline.version), driftForIssue(issueId, baseline.version, { undecidedOnly: true }),
    includeChangelog ? fetchChangelog(({ startAt, maxResults }) => api.asUser().requestJira(
      route`/rest/api/3/issue/${issue.key}/changelog?startAt=${startAt}&maxResults=${maxResults}`
    ), { sinceMs: Number(baseline.transition_at), maxPages: 5 }) : { entries: [] }
  ]) : [{}, [], { entries: [] }];
  const projection = project(issue.fields, fields);
  const diff = baseline ? diffIssue({ baseline, baselineValues, currentFields: issue.fields,
    controlledFields: fields, driftRows, changelogEntries: changelog.entries, queueThreshold: config.queueThreshold }) : null;
  const evidenceHash = diff?.evidenceHash ?? projection.contentHash;
  if (expectedEvidenceHash != null && expectedEvidenceHash !== evidenceHash) fail('STALE_EVIDENCE');
  return { issue, actor, issueId, projectId, issueTypeId, config, baseline, review, gate,
    eligible, fields, editmeta, baselineValues, driftRows, diff,
    contentHash: projection.contentHash, digests: projection.digests,
    evidenceHash, baselineVersion: baseline?.version ?? 0, driftCount: driftRows.length, reportHash: null };
}
export async function load(args, options = {}) {
  const issue = await readableIssue(args);
  return snapshot({ issue, actor: actorFrom(args.context), ...options });
}
export function serialise(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, serialise(v)]));
  return value;
}
export async function respond(operation) {
  try { return serialise(await operation()); }
  catch (error) { return { error: error.message ?? String(error), reason: error.reason ?? 'ERROR' }; }
}
