import { checkWriteIdentity as check } from '../lib/restore/writeIdentity.js';
import api, { route } from '@forge/api';

export async function checkWriteIdentity() {
  // Get a recent issue to check against
  const search = await api.asApp().requestJira(route`/rest/api/3/search?jql=order%20by%20created%20DESC&maxResults=1`);
  if (!search.ok) return { canEdit: false, error: 'Could not fetch issue' };
  const searchData = await search.json();
  const issueId = searchData.issues?.[0]?.id;
  if (!issueId) return { canEdit: false, error: 'No issues found' };
  
  const canEdit = await check(issueId);
  return { canEdit, issueId };
}
