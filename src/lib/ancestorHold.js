import { baselineDrift, logLiveDrift } from './liveDrift.js';
import { fieldsForItem } from './tree/nodeFields.js';

export { ancestorDriftMessage } from './errors.js';

/**
 * IS A WORK ITEM ABOVE THIS ONE DRIFTED?
 *
 * Drift is FLAGGED upward and HELD downward (decided by the user 2026-10-12).
 * A drifted work item asks every ancestor for a decision, but holds no
 * ancestor. It holds itself and everything below it: its children were
 * signed through it, so none of them may move while the content above them
 * is undecided. A sibling, or an issue at the other end of a link, is not
 * below it and is never held by it.
 *
 * "Below" is Jira's own `parent` field, walked upward from the item. Each
 * ancestor is judged on ITS OWN tracked fields with the same live comparison
 * the validator holds that ancestor on (lib/liveDrift.js), so an item is held
 * here exactly while its nearest drifted ancestor's own panel offers the
 * decision. An ancestor merely flagged by a drifted child of its own is not
 * drifted, and holds nothing.
 *
 * A read that fails throws: the validator fails closed on it.
 *
 * deps: readIssue(key) → canonicalised Jira issue (fields=*all), projectConfig,
 * activeBaseline, activeRootsForNode, controlledFields, rootNodeDigests.
 */
export const MAX_ANCESTOR_DEPTH = 8;

export async function driftedAncestor(issue, deps, { maxDepth = MAX_ANCESTOR_DEPTH, surface = 'ancestor' } = {}) {
  // A test-management issue was never signed through its parent: it sits
  // outside the parent's governed tree (testmgmt/treeExclusion.js), so the
  // parent's drift does not hold it. `exempt` is absent in older callers, and
  // asked only when there is a parent to be held by.
  let parent = issue?.fields?.parent ?? null;
  if (!parent?.key) return null;
  if (deps.exempt && await deps.exempt(issue)) return null;
  const seen = new Set([String(issue?.id)]);
  for (let depth = 1; parent?.key && depth <= maxDepth; depth += 1) {
    const ancestor = await deps.readIssue(parent.key);
    if (!ancestor?.id || seen.has(String(ancestor.id))) return null;
    seen.add(String(ancestor.id));
    const changed = await ownDrift(ancestor, deps, surface);
    if (changed.length > 0) {
      return { issueId: Number(ancestor.id), issueKey: ancestor.key, depth, changed: changed.slice(0, 40) };
    }
    parent = ancestor.fields?.parent ?? null;
  }
  return null;
}

/**
 * The fields of THIS work item that differ from its active baseline, judged
 * exactly as the validator judges it (lib/liveDrift.js): its own content only,
 * never its children's. [] for no baseline or a project switched off.
 */
export async function ownDrift(issue, deps, surface = 'own') {
  const issueId = Number(issue.id);
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const [config, baseline] = await Promise.all([deps.projectConfig(projectId), deps.activeBaseline(issueId)]);
  // A project switched off in VAtlassian holds nothing for drift (gate.js).
  if (!baseline || config?.enabled === false) return [];
  const declared = await fieldsForItem({ issueId, projectId, issueTypeId },
    { activeRootsForNode: deps.activeRootsForNode, controlledFields: deps.controlledFields });
  const comparison = await baselineDrift({ baseline, issueId, issueFields: issue.fields, declared,
    readRootDigests: deps.rootNodeDigests });
  logLiveDrift(surface, { issueKey: issue.key, issueTypeId, comparison });
  return comparison.changed ?? [];
}

/**
 * The same reads as the viewer, for the surfaces that only display a hold (the
 * panel and the transition-screen field). They are never the authority: the
 * validator and the signing path read for themselves (lib/approval/runtime.js).
 */
export async function viewerAncestorDeps() {
  const [forge, config, baselines, trees, identity] = await Promise.all([import('@forge/api'),
    import('../db/configStore.js'), import('../db/baselineStore.js'), import('../db/baselineTreeStore.js'),
    import('./attachmentIdentity.js')]);
  const api = forge.default?.asUser ? forge.default : forge;
  const readIssue = async key => {
    const response = await api.asUser().requestJira(forge.route`/rest/api/3/issue/${key}?fields=*all`);
    if (!response?.ok) throw new Error(`ancestor ${key} unreadable (${response?.status})`);
    return identity.canonicaliseIssue(await response.json());
  };
  const { testManagementRole } = await import('../testmgmt/treeExclusion.js');
  return { readIssue, projectConfig: config.projectConfig, activeBaseline: baselines.activeBaseline,
    activeRootsForNode: trees.activeRootsForNode, controlledFields: config.controlledFields,
    rootNodeDigests: trees.rootNodeDigests, exempt: async issue => !!(await testManagementRole(issue)) };
}
