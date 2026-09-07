/**
 * Id -> display name lookups, for rendering only.
 *
 * WHY THIS EXISTS. The app's own tables store what a decision has to be made
 * against: numeric project ids, issue type ids, status ids, account ids. That
 * is correct — names get renamed, and a rule matched on a name would silently
 * stop matching the day someone edits a workflow status. But it means every
 * admin screen reading those tables had nothing to show except the ids, and
 * so it showed the ids: a table of "712020:8a3f-…" and "10001" that no
 * administrator can act on, and that prints every user's account id on screen
 * for no benefit.
 *
 * So the ids stay in the database and stay in the matching logic, and this
 * module resolves them to names on the way out to a screen.
 *
 * NOTHING HERE MAY BE USED IN A DECISION. These lookups are best-effort by
 * design: every one of them returns an empty map rather than throwing when
 * Jira is unavailable, so that a listing screen degrades to "Unknown issue
 * type" instead of failing to load. That behaviour is safe for display and
 * catastrophic for authorisation — a silently empty map would read as "no
 * matches" to anything gating on it. Gate and eligibility checks must keep
 * comparing ids to ids. See src/gate.js and isEligible() in resolvers/panel.js.
 *
 * asApp, not asUser: an admin console lists rules that may reference projects
 * the reading admin is not themselves a member of, and a rule that renders as
 * blank because of the reader's own project permissions is worse than useless
 * on a compliance configuration screen. Only names are read, never issue
 * content.
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
          // A deactivated user still has a display name, and a grant held by
          // someone who has left is exactly the row an auditor is looking for
          // — so they are resolved and flagged, not omitted.
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
