import api, { route } from '@forge/api';

export async function checkWriteIdentity(issueId, accountId) {
  const req = accountId ? api.asUser() : api.asApp();
  const response = await req.requestJira(route`/rest/api/3/issue/${issueId}/editmeta`);
  if (!response.ok) return false;
  const data = await response.json();
  return data.fields && Object.keys(data.fields).length > 0;
}
