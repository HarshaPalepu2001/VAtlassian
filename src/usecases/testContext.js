/**
 * What the Test management panel should show on this work item: a test, an
 * execution, a bug test management created, or nothing.
 */
import { actorFrom } from './access.js';
import { tmRespond } from '../testmgmt/messages.js';

export async function testContext({ payload = {}, context }, suppliedDeps = null) {
  return tmRespond(async () => {
    actorFrom(context);
    const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
    const issue = await deps.readIssueAsUser(String(payload.issueKey ?? ''));
    const projectId = String(issue?.fields?.project?.id ?? '');
    const project = await deps.readProject(projectId);
    if (!project?.enabled) return { role: null, enabled: false };
    const tm = await deps.testManagementRole(issue);
    return { role: tm?.role ?? 'SOURCE', enabled: true, issueKey: issue.key };
  });
}
