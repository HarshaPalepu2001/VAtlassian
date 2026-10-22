import { canonical, sha256Hex } from './hash.js';
import { FailClosed } from './errors.js';

export const LEGACY_LINK_POLICY = Object.freeze({ version: 1 });
const fail = () => { throw new FailClosed('LINK_POLICY_UNREADABLE'); };
const id = value => value == null ? '' : String(value);

/** A stored snapshot, never a lookup of today's configuration. Null is exact v1. */
export function normaliseLinkPolicy(value) {
  if (value == null) return LEGACY_LINK_POLICY;
  let p = value;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return fail(); } }
  if (p?.version === 1) return LEGACY_LINK_POLICY;
  if (p?.version !== 2 || !id(p.verifiesTypeId) || !Array.isArray(p.testTypes)
    || !p.testTypes.length || !Array.isArray(p.internalTypeIds)) return fail();
  const testTypes = p.testTypes.map(t => {
    if (!Number.isSafeInteger(Number(t.projectId)) || Number(t.projectId) <= 0 || !id(t.issueTypeId)) return fail();
    return { projectId: Number(t.projectId), issueTypeId: id(t.issueTypeId) };
  }).sort((a, b) => a.projectId - b.projectId || a.issueTypeId.localeCompare(b.issueTypeId));
  const internalTypeIds = [...new Set(p.internalTypeIds.map(id))].sort();
  if (internalTypeIds.some(t => !t || t === id(p.verifiesTypeId))) return fail();
  return { version: 2, verifiesTypeId: id(p.verifiesTypeId),
    testTypes: testTypes.filter((t, i) => i === 0 || canonical(t) !== canonical(testTypes[i - 1])), internalTypeIds };
}

export const baselineLinkPolicy = baseline => normaliseLinkPolicy(baseline?.link_policy ?? baseline?.linkPolicy);
export const serialiseLinkPolicy = policy => normaliseLinkPolicy(policy).version === 1 ? null : canonical(normaliseLinkPolicy(policy));
export const linkPolicyHash = policy => sha256Hex(canonical(normaliseLinkPolicy(policy)));

/** Only new approvals consult configuration; pending/consumed receipts carry their own snapshot. */
export async function resolveNewLinkPolicy(issue, resolver = null) {
  const resolve = resolver ?? (await import('../testmgmt/linkPolicyConfig.js')).resolveTestManagementLinkPolicy;
  return normaliseLinkPolicy(await resolve(issue));
}

function scope(issue) {
  const fields = issue?.fields ?? issue;
  const projectId = Number(fields?.project?.id ?? issue?.project_id ?? issue?.projectId);
  const issueTypeId = id(fields?.issuetype?.id ?? issue?.issue_type_id ?? issue?.issueTypeId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !issueTypeId) return fail();
  return { projectId, issueTypeId };
}

export function isPolicyTest(issue, policy) {
  const p = normaliseLinkPolicy(policy);
  if (p.version === 1) return false;
  const own = scope(issue);
  return p.testTypes.some(t => t.projectId === own.projectId && t.issueTypeId === own.issueTypeId);
}

/** Exemption belongs to this endpoint. A Test always owns its Verifies links. */
export function excludesLink({ linkPolicy, issue, link }) {
  const p = normaliseLinkPolicy(linkPolicy);
  if (p.version === 1) return false;
  const typeId = id(link?.type?.id);
  if (!typeId) return fail();
  if (p.internalTypeIds.includes(typeId)) return true;
  if (typeId !== p.verifiesTypeId) return false;
  if (isPolicyTest(issue, p)) return false;
  if (!!link.inwardIssue === !!link.outwardIssue) return fail();
  return isPolicyTest(link.inwardIssue ?? link.outwardIssue, p);
}

export function governedLinks(links, { linkPolicy, issue } = {}) {
  const p = normaliseLinkPolicy(linkPolicy);
  if (p.version === 1) return links;
  if (!Array.isArray(links)) return fail();
  return links.filter(link => !excludesLink({ linkPolicy: p, issue, link }));
}

async function defaultReadIssue(issueId) {
  const forge = await import('@forge/api');
  const api = forge.default?.asApp ? forge.default : forge;
  const response = await api.asApp().requestJira(forge.route`/rest/api/3/issue/${issueId}?fields=project,issuetype`);
  if (!response?.ok) return fail();
  return response.json();
}

/** Jira's nested link endpoint need not contain project/type. Read just those facts. */
export async function hydrateLinkPolicyIssue(issue, linkPolicy, readIssue = defaultReadIssue, cache = new Map()) {
  const p = normaliseLinkPolicy(linkPolicy);
  if (p.version === 1) return issue;
  const links = issue?.fields?.issuelinks;
  if (!Array.isArray(links)) return issue;
  const ownTest = isPolicyTest(issue, p);
  const hydrated = await Promise.all(links.map(async link => {
    if (id(link?.type?.id) !== p.verifiesTypeId || ownTest) return link;
    const direction = link.inwardIssue ? 'inwardIssue' : 'outwardIssue';
    const other = link[direction];
    if (!other || (link.inwardIssue && link.outwardIssue)) return fail();
    try { scope(other); return link; } catch {}
    const key = id(other.id ?? other.key);
    if (!key) return fail();
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => readIssue(key)));
    const read = await cache.get(key);
    scope(read);
    if (other.id != null && id(read.id) !== id(other.id)) return fail();
    return { ...link, [direction]: { ...other, fields: { ...other.fields,
      project: read.fields.project, issuetype: read.fields.issuetype } } };
  }));
  return { ...issue, fields: { ...issue.fields, issuelinks: hydrated } };
}

export async function hydrateLinkPolicyNodes(nodes, policyFor, readIssue) {
  const cache = new Map();
  return Promise.all(nodes.map(node => hydrateLinkPolicyIssue(node, policyFor(node), readIssue, cache)));
}

/** Overlaid child baselines can carry a different policy from their covering root. */
export function treeLinkPolicyResolver(tree, fallback = null) {
  const policies = new Map();
  for (const node of tree?.nodes ?? []) {
    const policy = node.linkPolicy ?? tree.linkPolicy ?? fallback;
    for (const key of [node.logicalNodeId, node.originalIssueId, node.currentIssueId, node.id]) {
      if (key != null) policies.set(String(key), policy);
    }
  }
  return node => normaliseLinkPolicy(policies.get(String(node?.logicalNodeId ?? node?.id ?? node?.currentIssueId ?? node?.originalIssueId))
    ?? tree?.linkPolicy ?? fallback);
}

/** Mirror preflight: a SQL Test signature cannot override any native link approval. */
export function nativeMirrorAllowed({ baseline, issue, link }) {
  if (!baseline) return true;
  try { return excludesLink({ linkPolicy: baselineLinkPolicy(baseline), issue, link }); } catch { return false; }
}
