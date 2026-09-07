export async function fetchIssueDisplays(issueIds, { request }) {
  const map = new Map();
  if (!issueIds || issueIds.length === 0) return map;
  
  try {
    const jql = `id in (${issueIds.join(',')})`;
    const res = await request({ jql, maxResults: 100, fields: ["summary", "status"] });
    if (!res.ok) {
      const text = await res.text();
      console.warn('fetchIssueDisplays: search failed', res.status, text);
      return map;
    }
    const data = await res.json();
    for (const issue of (data.issues || [])) {
      map.set(Number(issue.id), {
        issue_key: issue.key,
        summary: issue.fields?.summary || '',
        status_name: issue.fields?.status?.name || ''
      });
    }
  } catch (e) {
    console.error('fetchIssueDisplays error', e);
  }
  return map;
}
