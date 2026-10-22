import { memo } from '../lib/cache.js';
import { listProjects, bugIssueIdsAmong } from './store.js';

/**
 * TEST-MANAGEMENT ISSUES ARE NOT PART OF THEIR PARENT'S GOVERNED TREE.
 *
 * Owner decision 11 (2026-10-21). A baselined Epic's tree takes in every
 * descendant, so a Test, an Execution or the automatic bug created under it
 * would be "node added" drift: the Epic would be held, and rejecting that
 * drift would delete the new issue. These issues have their own signatures
 * and history; the Epic's baseline does not cover them.
 *
 * Excluded:
 *   - in a project with test management enabled, every issue of a mapped
 *     Test, Test Plan or Test Execution type;
 *   - in any project with a test-management configuration, enabled or not,
 *     every bug test management created, by issue id from its own tm_bug rows
 *     (never by a label or property, which any editor could set), whatever
 *     its work type is now.
 * An excluded issue's own children are not walked either.
 *
 * NO SIGNED BASELINE IS RE-READ UNDER A DIFFERENT RULE. Enablement refuses to
 * map a type that already has an issue inside a stored baseline tree, a type
 * leaves the exclusion only while none of its issues has a parent
 * (usecases/testManagementAdmin.js), and a test-management bug is excluded
 * from the moment it exists for as long as its tm_bug row does. So nothing
 * excluded here can have been part of what anyone signed, and nothing once
 * excluded comes back into a signed tree.
 *
 * Every tree reader the runtime builds passes this in (lib/tree/jira.js). A
 * failed read throws: the caller fails closed, as for any unreadable tree.
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
