/** New approvals may opt into this snapshot; existing baselines retain their stored policy. */
export async function resolveTestManagementLinkPolicy(issue, deps = null) {
  const { readProject } = deps ?? await import('./store.js');
  const projectId = String(issue?.fields?.project?.id ?? '');
  if (!/^\d+$/.test(projectId)) return { version: 1 };
  const project = await readProject(projectId);
  if (!project?.enabled || !/^\d+$/.test(String(project.sourceLinkTypeId ?? '')) || !/^\d+$/.test(String(project.testTypeId ?? ''))) return { version: 1 };
  return { version: 2, verifiesTypeId: String(project.sourceLinkTypeId),
    testTypes: [{ projectId: Number(projectId), issueTypeId: String(project.testTypeId) }], internalTypeIds: [] };
}
