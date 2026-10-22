/** Direct read for uncertain execution-create reconciliation; search alone is insufficient. */
export async function readRetestMarkerAsApp(issueId) {
  const forge = await import('@forge/api');
  const api = forge.default?.asApp ? forge.default : forge.default?.default;
  const response = await api.asApp().requestJira(forge.route`/rest/api/3/issue/${issueId}?fields=project,issuetype,parent&properties=va-tm-retest`);
  if (!response?.ok) throw new Error('Retest issue identity unavailable');
  const issue = await response.json();
  return { projectId: String(issue.fields?.project?.id ?? ''), issueTypeId: String(issue.fields?.issuetype?.id ?? ''),
    parentIssueId: String(issue.fields?.parent?.id ?? ''), requestId: issue.properties?.['va-tm-retest']?.requestId ?? null,
    sourceExecutionIssueId: issue.properties?.['va-tm-retest']?.sourceExecutionIssueId ?? null };
}
