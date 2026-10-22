import api, { route } from '@forge/api';
import crypto from 'crypto';
import { FailClosed } from '../lib/errors.js';

/**
 * The Jira reads and writes test management needs. Reads that decide what a
 * person may do are made AS THAT PERSON, so Jira's own permissions decide
 * visibility. The automatic bug is created AS THE APP (spec: "Created by the
 * app"), because the signer may not hold Create Issues and the bug must exist.
 */

const forge = api?.asUser ? api : api.default;

async function json(response, reason = 'SERVICE_UNAVAILABLE') {
  if (!response?.ok) {
    const error = new FailClosed(response?.status === 404 || response?.status === 403 ? 'NOT_FOUND' : reason);
    error.status = response?.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

const ISSUE_FIELDS = 'summary,status,issuetype,project,parent,attachment,fixVersions';

export async function readIssueAsUser(issueIdOrKey) {
  return json(await forge.asUser().requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=${ISSUE_FIELDS}`));
}

export async function readIssueAsApp(issueIdOrKey) {
  return json(await forge.asApp().requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=${ISSUE_FIELDS}`));
}

/** Does the viewer hold this Jira permission on this issue? */
export async function hasIssuePermission(issueId, permission) {
  const data = await json(await forge.asUser().requestJira(
    route`/rest/api/3/mypermissions?issueId=${issueId}&permissions=${permission}`));
  return data?.permissions?.[permission]?.havePermission === true;
}

export async function myself() {
  return json(await forge.asUser().requestJira(route`/rest/api/3/myself`));
}

export async function projectVersions(projectId) {
  const list = await json(await forge.asUser().requestJira(route`/rest/api/3/project/${projectId}/versions`));
  return (list ?? []).filter(v => !v.archived).map(v => ({ id: String(v.id), name: v.name, released: !!v.released }));
}

export async function projectIssueTypes(projectId) {
  const project = await json(await forge.asApp().requestJira(route`/rest/api/3/project/${projectId}`));
  return {
    style: project?.style ?? null, key: project?.key ?? null, name: project?.name ?? null,
    issueTypes: (project?.issueTypes ?? []).map(t => ({ id: String(t.id), name: t.name, subtask: !!t.subtask,
      hierarchyLevel: t.hierarchyLevel ?? null }))
  };
}

export async function linkTypes() {
  const data = await json(await forge.asApp().requestJira(route`/rest/api/3/issueLinkType`));
  return (data?.issueLinkTypes ?? []).map(t => ({ id: String(t.id), name: t.name, inward: t.inward, outward: t.outward }));
}

/** Issue ids of this type in this project that have a parent (enablement guard). Bounded. */
export async function issuesOfTypeWithParent(projectId, issueTypeId, max = 500) {
  const ids = [];
  let nextPageToken = null;
  do {
    const body = { jql: `project = ${Number(projectId)} AND issuetype = ${Number(issueTypeId)} AND parent is not EMPTY`,
      maxResults: 100, fields: ['id'] };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await json(await forge.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    for (const issue of data?.issues ?? []) ids.push(String(issue.id));
    nextPageToken = data?.nextPageToken ?? null;
    if (ids.length > max) return { ids, complete: false };
  } while (nextPageToken);
  return { ids, complete: true };
}

export const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

/** Read as the current viewer; the usecase first checks membership on the authorized issue. */
export async function readAttachmentBytes(attachmentId) {
  const response = await forge.asUser().requestJira(route`/rest/api/3/attachment/content/${attachmentId}?redirect=false`);
  if (!response?.ok) throw new FailClosed('EVIDENCE_UNREADABLE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new FailClosed('EVIDENCE_TOO_LARGE');
  return bytes;
}

/** The bytes' SHA-256 and size, read as the app after the viewer was shown to see the issue. */
export async function hashAttachment(attachmentId) {
  const response = await forge.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}?redirect=false`);
  if (!response?.ok) throw new FailClosed('EVIDENCE_UNREADABLE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new FailClosed('EVIDENCE_TOO_LARGE');
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

// ── the automatic bug (as the app) ──────────────────────────────────────────
/** `properties` are entity properties set in the same create (testmgmt/bug.js confirms the bug by one). */
export async function createIssueAsApp(fields, properties = []) {
  let response;
  try {
    response = await forge.asApp().requestJira(route`/rest/api/3/issue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields, properties }) });
  } catch {
    throw Object.assign(new Error('create answer lost'), { status: null });
  }
  if (response.status >= 500) throw Object.assign(new Error('create failed'), { status: null });
  if (!response.ok) {
    const raw = response.headers?.get?.('retry-after');
    const seconds = raw != null && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw ?? '') - Date.now();
    throw Object.assign(new Error('create refused'), { status: response.status,
      retryAfterMs: response.status === 429 && Number.isFinite(seconds) ? Math.max(0, seconds) : null });
  }
  const created = await response.json();
  return { id: String(created.id), key: created.key };
}

export async function searchByLabelAsApp(label) {
  const data = await json(await forge.asApp().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql: `labels = "${label.replace(/"/g, '')}"`, maxResults: 5, fields: ['summary'] }) }));
  return { complete: !data?.nextPageToken, issues: (data?.issues ?? []).map(i => ({ id: String(i.id), key: i.key })) };
}

/** The issue's project and the run its va-tm-bug property names, read by id (not through search, so never stale). */
export async function readBugMarkerAsApp(issueId) {
  const issue = await json(await forge.asApp().requestJira(
    route`/rest/api/3/issue/${issueId}?fields=project&properties=va-tm-bug`));
  return { projectId: issue?.fields?.project?.id == null ? null : String(issue.fields.project.id),
    runId: issue?.properties?.['va-tm-bug']?.runId ?? null };
}

export async function linkIssueAsApp({ typeName, inwardId, outwardId }) {
  const present = async () => {
    const issue = await json(await forge.asApp().requestJira(route`/rest/api/3/issue/${inwardId}?fields=issuelinks`));
    if (!Array.isArray(issue?.fields?.issuelinks)) throw new FailClosed('BUG_LINKS_UNREADABLE');
    return issue.fields.issuelinks.some(link => link.type?.name === typeName && String(link.outwardIssue?.id) === String(outwardId));
  };
  if (await present()) return;
  let writeError;
  try {
    await json(await forge.asApp().requestJira(route`/rest/api/3/issueLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: { name: typeName }, inwardIssue: { id: String(inwardId) }, outwardIssue: { id: String(outwardId) } }) }));
  } catch (error) { writeError = error; }
  // An interrupted answer can still have made the link. A direct issue read
  // proves the relationship and also makes retries after a partial repair safe.
  if (!await present()) throw writeError ?? new FailClosed('BUG_LINKS_UNREADABLE');
}

/** Field ids on the create screen for this work type (the bug payload is built from these). */
export async function createScreenFields(projectId, issueTypeId) {
  const ids = new Set();
  let startAt = 0;
  for (let page = 0; page < 10; page++) {
    const data = await json(await forge.asApp().requestJira(
      route`/rest/api/3/issue/createmeta/${projectId}/issuetypes/${issueTypeId}?startAt=${startAt}&maxResults=100`));
    const fields = data?.fields ?? data?.values ?? [];
    for (const f of fields) ids.add(String(f.fieldId ?? f.key));
    startAt += fields.length;
    const total = data?.total == null ? null : Number(data.total);
    const more = (Number.isFinite(total) && startAt < total) || data?.isLast === false;
    if (!more && (data?.isLast === true || Number.isFinite(total) || fields.length < 100)) return ids;
    if (fields.length === 0) throw new FailClosed('CREATE_METADATA_INCOMPLETE');
  }
  throw new FailClosed('CREATE_METADATA_INCOMPLETE');
}
