import { nativeMirrorAllowed, normaliseLinkPolicy } from '../lib/linkPolicy.js';

const numericId = value => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const baselineKey = value => Buffer.isBuffer(value) ? value.length === 16 ? value.toString('hex') : null
  : /^[a-f0-9]{32}$/i.test(String(value ?? '')) ? String(value).toLowerCase() : null;

function linkTracking(raw) {
  let digests = raw;
  if (typeof raw === 'string') { try { digests = JSON.parse(raw); } catch { return null; } }
  if (!digests || typeof digests !== 'object' || Array.isArray(digests)) return null;
  if (Object.values(digests).some(value => !/^[a-f0-9]{64}$/i.test(String(value ?? '')))) return null;
  return Object.hasOwn(digests, 'issuelinks');
}

function endpointIdentity(issue, stored) {
  const projectId = stored.projectId ?? stored.project_id ?? issue.fields?.project?.id;
  const issueTypeId = stored.issueTypeId ?? stored.issue_type_id ?? issue.fields?.issuetype?.id;
  if (!numericId(projectId) || !String(issueTypeId ?? '')) return null;
  if (issue.fields?.project?.id != null && String(issue.fields.project.id) !== String(projectId)) return null;
  if (issue.fields?.issuetype?.id != null && String(issue.fields.issuetype.id) !== String(issueTypeId)) return null;
  return { ...issue, fields: { ...issue.fields, project: { id: String(projectId) }, issuetype: { id: String(issueTypeId) } } };
}

/**
 * Mutation authority from the immutable native records, independently of the SQL
 * Test signature. Every covering approval has a veto. Explicitly untracked links
 * express no opinion; unknown protected state never grants a mirror permission.
 * Dependencies are injected reads only: this helper performs no Jira/SQL writes.
 */
export async function endpointAllowsMirror({ issue, link }, deps) {
  try {
    if (!numericId(issue?.id) || !link?.type?.id || !!link.inwardIssue === !!link.outwardIssue ||
        !numericId((link.inwardIssue ?? link.outwardIssue)?.id)) return false;
    const [own, roots] = await Promise.all([deps.activeBaseline(Number(issue.id)), deps.activeRootsForNode(Number(issue.id))]);
    if (!Array.isArray(roots)) return false;
    const checkedTrees = new Set();
    const treeCache = new Map();
    async function treeAllows(id, knownBaseline = null) {
      const key = baselineKey(id);
      if (!key) return false;
      if (checkedTrees.has(key)) return true;
      if (!treeCache.has(key)) treeCache.set(key, Promise.resolve().then(() => deps.readBaselineTree(id)));
      const tree = await treeCache.get(key);
      if (!tree || !Array.isArray(tree.nodes) || !tree.nodes.length || tree.complete === false || tree.truncated === true) return false;
      const matches = tree.nodes.filter(node => {
        // Replacement mappings supersede the original ID. An absent mapping on
        // a legacy node still permits its original identity to be located.
        const current = node?.currentIssueId ?? node?.current_issue_id ?? node?.id;
        const original = node?.originalIssueId ?? node?.original_issue_id;
        return String(current ?? original ?? '') === String(issue.id);
      });
      if (matches.length !== 1) return false;
      const node = matches[0];
      const tracksLinks = linkTracking(node.fieldDigests ?? node.field_digests);
      if (tracksLinks == null) return false;
      if (!tracksLinks) { checkedTrees.add(key); return true; }
      let policy = node.linkPolicy ?? node.link_policy ?? tree.linkPolicy ?? tree.link_policy;
      if (policy == null) {
        const baseline = knownBaseline ?? (deps.baselineById ? await deps.baselineById(id) : null);
        if (baseline && (baselineKey(baseline.baseline_id ?? baseline.baselineId) !== key || baseline.state && baseline.state !== 'ACTIVE')) return false;
        // A legacy record has exact v1 semantics. It therefore vetoes a SQL
        // mirror when links are tracked, even before policy columns existed.
        policy = baseline?.link_policy ?? baseline?.linkPolicy ?? null;
      }
      const identity = endpointIdentity(issue, node);
      if (!identity || !nativeMirrorAllowed({ baseline: { linkPolicy: normaliseLinkPolicy(policy) }, issue: identity, link })) return false;
      checkedTrees.add(key); return true;
    }
    if (own != null) {
      if (!own || typeof own !== 'object' || Array.isArray(own) || !baselineKey(own.baseline_id ?? own.baselineId) ||
          !numericId(own.issue_id ?? own.issueId) || String(own.issue_id ?? own.issueId) !== String(issue.id) || own.state && own.state !== 'ACTIVE') return false;
      if (own.tree_hash ?? own.treeHash) {
        if (!await treeAllows(own.baseline_id ?? own.baselineId, own)) return false;
      } else {
        const tracksLinks = linkTracking(own.field_digests ?? own.fieldDigests);
        if (tracksLinks == null) return false;
        if (tracksLinks) {
          const identity = endpointIdentity(issue, own);
          if (!identity || !nativeMirrorAllowed({ baseline: own, issue: identity, link })) return false;
        }
      }
    }
    for (const root of roots) {
      if (!root || typeof root !== 'object' || !await treeAllows(root.baselineId ?? root.baseline_id)) return false;
    }
    return true;
  } catch { return false; }
}
