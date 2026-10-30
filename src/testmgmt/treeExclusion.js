import { memo } from '../lib/cache.js';
import { listProjects, bugIssueIdsAmong } from './store.js';

/**
 * Exclude test-management work from its parent's governed tree under owner
 * decision 11, dated 2026-10-21. These issues have their own signatures and
 * history. Including them would create node-added drift and allow parent
 * rejection to delete them.
 *
 * When enabled, exclude mapped Test, Test Plan and Test Execution types.
 * With any test-management configuration, enabled or disabled, exclude bugs
 * identified by immutable tm_bug issue ids regardless of their current type.
 * Do not rely on editable labels or properties. Skip descendants of excluded
 * issues too.
 *
 * Preserve existing signed coverage. Refuse mappings for types already in a
 * stored baseline tree. Remove a type from exclusion only when none of its
 * issues has a parent. Bugs remain excluded while their tm_bug row exists.
 * See usecases/testManagementAdmin.js.
 *
 * All runtime tree readers pass this filter to lib/tree/jira.js. Read failures
 * throw so callers fail closed.
 */
export async function testManagementExclusion(children, deps = {}) {
  const excluded = new Set();
  if (!children?.length) return excluded;
  const projects = new Map((await (deps.listProjects ? deps.listProjects() : memo('tm:projects', listProjects)))
    .map(p => [p.projectId, p]));
  if (projects.size === 0) return excluded;
  const bugCandidates = [];
  for (const child of children) {
    const project = projects.get(String(child?.fields?.project?.id ?? ''));
    if (!project) continue;
    const typeId = String(child?.fields?.issuetype?.id ?? '');
    if (project.enabled && [project.testTypeId, project.executionTypeId, project.planTypeId, project.setTypeId, project.preconditionTypeId].includes(typeId)) excluded.add(String(child.id));
    else bugCandidates.push(child.id);
  }
  if (bugCandidates.length) {
    for (const id of await (deps.bugIssueIdsAmong ?? bugIssueIdsAmong)(bugCandidates)) excluded.add(String(id));
  }
  return excluded;
}

/**
 * Is this one issue a test-management issue (ancestor-hold exemption, gate
 * guard)? `bugs: false` skips the bug lookup for a caller that only asks about
 * the mapped types, so the gate pays no SQL read for it on every transition.
 */
export async function testManagementRole(issue, { bugs = true } = {}) {
  const projectId = String(issue?.fields?.project?.id ?? '');
  const typeId = String(issue?.fields?.issuetype?.id ?? '');
  if (!projectId || !typeId) return null;
  const projects = await memo('tm:projects', listProjects);
  const project = projects.find(p => p.projectId === projectId);
  if (!project) return null;
  if (project.enabled) {
    if (typeId === project.testTypeId) return { role: 'TEST', project };
    if (typeId === project.executionTypeId) return { role: 'EXECUTION', project };
    if (project.planTypeId && typeId === project.planTypeId) return { role: 'PLAN', project };
    if (project.setTypeId && typeId === project.setTypeId) return { role: 'SET', project };
    if (project.preconditionTypeId && typeId === project.preconditionTypeId) return { role: 'PRECONDITION', project };
  }
  // A test-management bug stays one, as it stays out of the tree above.
  if (bugs && (await bugIssueIdsAmong([issue.id])).size === 1) return { role: 'BUG', project };
  return null;
}
