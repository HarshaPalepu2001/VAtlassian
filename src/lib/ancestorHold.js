import { baselineDrift, logLiveDrift } from './liveDrift.js';
import { fieldsForItem } from './tree/nodeFields.js';

export { ancestorDriftMessage } from './errors.js';

/**
 * Check whether an ancestor's own tracked fields have drifted.
 *
 * The 2026-10-12 decision flags drift upward and holds transitions downward.
 * A drifted item appears for review on every ancestor, but does not hold those
 * ancestors. It holds itself and its descendants. Siblings and linked issues
 * are outside that descendant set.
 *
 * Walk Jira's parent field upward. Compare each ancestor's own tracked fields
 * through lib/liveDrift.js, as its validator does. An ancestor merely flagged
 * because of another child's drift does not itself hold descendants.
 *
 * Failed reads throw so the validator can refuse the transition.
 *
 * deps supplies readIssue(key), returning a canonicalised issue with fields=*all,
 * and projectConfig, activeBaseline, activeRootsForNode, controlledFields and
 * rootNodeDigests.
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
