import { linkStateUnknown } from '../lib/restore/linkConflicts.js';
import { baselineLinkPolicy, normaliseLinkPolicy } from '../lib/linkPolicy.js';

/**
 * WHAT THE OTHER END OF A LINK APPROVED.
 *
 * A restore that is about to add or remove a link asks this, for the issue at
 * the other end, before touching it (../lib/restore/linkConflicts.js). The
 * answer is that issue's approved link list, or null when it has none — not
 * governed at all, or governed without tracking links — and so no approval a
 * link change could contradict.
 *
 * Where the answer comes from, most specific first:
 *   1. The tree this restore is returning to, when the other end is in it:
 *      that is the state the same restore is putting it in, child baselines
 *      already standing in for their own records (../lib/tree/childBaselines.js).
 *   2. Its own active single-issue baseline.
 *   3. The tree that covers it — its own, when it is a root, or the most
 *      recently approved tree it is a node of.
 *
 * A governed end whose links were tracked but not retained cannot be checked;
 * that refuses the link (linkStateUnknown) rather than guessing either way.
 */
const LINKS = 'issuelinks';
const nodeIssueId = node => String(node?.currentIssueId ?? node?.originalIssueId ?? '');

function tracksLinks(fieldDigests) {
  if (!fieldDigests) return false;
  try {
    const parsed = typeof fieldDigests === 'string' ? JSON.parse(fieldDigests) : fieldDigests;
    return Object.hasOwn(parsed ?? {}, LINKS);
  } catch { return false; }
}

async function defaultDeps() {
  const [baselines, trees] = await Promise.all([import('./baselineStore.js'), import('./baselineTreeStore.js')]);
  return { activeBaseline: baselines.activeBaseline, readAllValues: baselines.readAllValues,
    readBaselineTree: trees.readBaselineTree, activeRootsForNode: trees.activeRootsForNode };
}

export function approvedLinksResolver({ baselineTree = null } = {}, suppliedDeps = null) {
  const inTree = new Map((baselineTree?.nodes ?? []).map(node => [nodeIssueId(node), node]));
  const cache = new Map();
  let deps = suppliedDeps;

  const retained = (values, issueId, linkPolicy = null, issue = null) => {
    const policy = normaliseLinkPolicy(linkPolicy);
    // In v2 an excluded relationship is no opinion even if governed link
    // values were not retained. The per-link conflict check decides that
    // before requiring a complete list for relationships still in scope.
    if (policy.version === 2) return { links: Array.isArray(values?.[LINKS]) ? values[LINKS] : null,
      linkPolicy: policy, issue };
    if (Array.isArray(values?.[LINKS])) return values[LINKS];
    throw linkStateUnknown(issueId);
  };

  async function fromTree(baselineId, issueId) {
    const tree = await deps.readBaselineTree(baselineId);
    const node = (tree?.nodes ?? []).find(n => nodeIssueId(n) === issueId);
    if (!node || !tracksLinks(node.fieldDigests)) return null;
    return retained(tree.values?.[node.logicalNodeId], issueId, node.linkPolicy ?? tree.linkPolicy, scopeOf(node));
  }

  async function resolve(issueId) {
    const node = inTree.get(issueId);
    if (node) {
      const values = baselineTree.values?.[node.logicalNodeId];
      const policy = normaliseLinkPolicy(node.linkPolicy ?? baselineTree.linkPolicy);
      if (policy.version === 2 && !tracksLinks(node.fieldDigests ?? node.digests)) return null;
      return policy.version === 2 || values && Object.hasOwn(values, LINKS)
        ? retained(values, issueId, policy, scopeOf(node)) : null;
    }
    deps ??= await defaultDeps();
    const own = await deps.activeBaseline(Number(issueId));
    if (own && !own.tree_hash) {
      return tracksLinks(own.field_digests) ? retained(await deps.readAllValues(Number(issueId), own.version), issueId,
        baselineLinkPolicy(own), scopeOf(own)) : null;
    }
    if (own?.tree_hash) return fromTree(own.baseline_id, issueId);
    const roots = await deps.activeRootsForNode(Number(issueId));
    const latest = [...(roots ?? [])].sort((a, b) => Number(b.capturedAt ?? 0) - Number(a.capturedAt ?? 0))[0];
    return latest ? fromTree(latest.baselineId, issueId) : null;
  }

  return issueId => {
    const key = String(issueId);
    if (!cache.has(key)) cache.set(key, resolve(key));
    return cache.get(key);
  };
}

function scopeOf(record) {
  return { id: String(record?.issue_id ?? record?.currentIssueId ?? record?.originalIssueId ?? ''),
    fields: { project: { id: record?.project_id ?? record?.projectId },
      issuetype: { id: record?.issue_type_id ?? record?.issueTypeId } } };
}
