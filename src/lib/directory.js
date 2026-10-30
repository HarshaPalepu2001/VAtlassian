/**
 * Resolve stored IDs to display names without affecting decisions.
 *
 * Rules and matching retain numeric project, issue-type and status IDs and
 * account IDs because names can change. Resolve names only when rendering.
 * When Jira is unavailable, return empty maps and let the UI show unknown-name
 * labels. Gate and eligibility checks must continue to compare IDs directly;
 * these best-effort lookups must never determine authorization.
 *
 * Read asApp because configuration may reference projects the viewing
 * administrator does not belong to. Read names only, never issue content.
 */

import { asApp, route } from '@forge/api';

/** Jira caps `user/bulk` at 200 account ids per request. */
const USER_BULK_PAGE = 200;

/** One page of `project/search`. */
const PROJECT_PAGE = 100;

async function getJson(path) {
  const response = await asApp().requestJira(path);
  if (!response.ok) {
    console.warn(`directory lookup failed: ${path.value ?? path} returned ${response.status}`);
    return null;
  }
  return response.json();
}

/**
 * Display names for a set of account ids.
 *
 * @param {Iterable<string>} accountIds
 * @returns {Promise<Map<string, { displayName: string, active: boolean }>>}
 */
export async function lookupUsers(accountIds) {
  const unique = [...new Set([...accountIds].filter((id) => typeof id === 'string' && id.length > 0))];
  const result = new Map();
  if (unique.length === 0) return result;

  try {
    for (let offset = 0; offset < unique.length; offset += USER_BULK_PAGE) {
      const params = new URLSearchParams();
      params.set('maxResults', String(USER_BULK_PAGE));
      for (const accountId of unique.slice(offset, offset + USER_BULK_PAGE)) {
        params.append('accountId', accountId);
      }
      const body = await getJson(route`/rest/api/3/user/bulk?${params}`);
      for (const user of body?.values ?? []) {
        if (!user?.accountId) continue;
        result.set(user.accountId, {
          // Resolve deactivated users' names and flag their status. Retain their grants
          // in the listing so administrators can review former signers.
          displayName: user.displayName ?? null,
          active: user.active !== false
        });
      }
    }
  } catch (e) {
    console.error('lookupUsers failed', e);
  }
  return result;
}

/**
 * Every issue type on the site, by id.
 *
 * @returns {Promise<Map<string, { name: string, subtask: boolean }>>}
 */
export async function lookupIssueTypes() {
  const result = new Map();
  try {
    const body = await getJson(route`/rest/api/3/issuetype`);
    for (const type of body ?? []) {
      if (!type?.id) continue;
      result.set(String(type.id), { name: type.name ?? null, subtask: type.subtask === true });
    }
  } catch (e) {
    console.error('lookupIssueTypes failed', e);
  }
  return result;
}

/**
 * Every status on the site, by id.
 *
 * @returns {Promise<Map<string, { name: string, category: string | null }>>}
 */
export async function lookupStatuses() {
  const result = new Map();
  try {
    const body = await getJson(route`/rest/api/3/status`);
    for (const status of body ?? []) {
      if (!status?.id) continue;
      result.set(String(status.id), {
        name: status.name ?? null,
        category: status.statusCategory?.key ?? null
      });
    }
  } catch (e) {
    console.error('lookupStatuses failed', e);
  }
  return result;
}

/**
 * Every project, by id.
 *
 * Paginated: a site with more than one page of projects would otherwise have
 * had its later rules render as "Unknown project" depending on where the
 * project happened to fall in the ordering, which is the kind of bug that
 * looks like data corruption.
 *
 * @returns {Promise<Map<string, { key: string, name: string }>>}
 */
export async function lookupProjects() {
  const result = new Map();
  try {
    let startAt = 0;
    for (;;) {
      const params = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(PROJECT_PAGE)
      });
      const body = await getJson(route`/rest/api/3/project/search?${params}`);
      const values = body?.values ?? [];
      for (const project of values) {
        if (!project?.id) continue;
        result.set(String(project.id), { key: project.key ?? null, name: project.name ?? null });
      }
      if (body?.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
  } catch (e) {
    console.error('lookupProjects failed', e);
  }
  return result;
}
