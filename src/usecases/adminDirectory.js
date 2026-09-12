import { runAdmin } from './adminRuntime.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';

export async function listProjects(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { asApp, route } = deps;
    try {
    const response = await asApp().requestJira(route`/rest/api/3/project/search?maxResults=100`);
    if (!response.ok) return { success: false, error: `Jira returned ${response.status}` };
    const body = await response.json();
    return { success: true, projects: (body.values ?? []).map((p) => ({ id: p.id, key: p.key, name: p.name })) };
  } catch (e) {
    console.error(e);
    return { success: false, error: e.message };
  }
  }, overrides, 'adminDirectory');
}

export async function listIssueTypesForProject(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { asApp, route } = deps;
    const { projectId } = req.payload ?? {};
  if (!projectId) return { success: false, error: 'projectId is required' };
  try {
    const response = await asApp().requestJira(route`/rest/api/3/issuetype/project?projectId=${projectId}`);
    if (!response.ok) return { success: false, error: `Jira returned ${response.status}` };
    const body = await response.json();
    return { success: true, issueTypes: (body ?? []).map((t) => ({ id: t.id, name: t.name })) };
  } catch (e) {
    console.error(e);
    return { success: false, error: e.message };
  }
  }, overrides, 'adminDirectory');
}

export async function listStatuses(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { asApp, route } = deps;
    try {
    const response = await asApp().requestJira(route`/rest/api/3/status`);
    if (!response.ok) return { success: false, error: `Jira returned ${response.status}` };
    const body = await response.json();
    return { success: true, statuses: (body ?? []).map((s) => ({ id: s.id, name: s.name, category: s.statusCategory?.name })) };
  } catch (e) {
    console.error(e);
    return { success: false, error: e.message };
  }
  }, overrides, 'adminDirectory');
}

export async function listStatusesForProject(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { asApp, route } = deps;
    const { projectId, issueTypeId } = req.payload ?? {};
    if (!projectId) return { success: false, error: 'projectId is required' };
    try {
      const response = await asApp().requestJira(route`/rest/api/3/project/${projectId}/statuses`);
      if (!response.ok) return { success: false, error: `Jira returned ${response.status}` };
      const body = await response.json();
      if (issueTypeId && issueTypeId !== '*') {
        const issueTypeObj = (body ?? []).find((it) => it.id === issueTypeId);
        if (!issueTypeObj) return { success: true, statuses: [] };
        return { success: true, statuses: (issueTypeObj.statuses ?? []).map((s) => ({ id: s.id, name: s.name, category: s.statusCategory?.name })) };
      }
      const seen = new Map();
      for (const it of body ?? []) {
        for (const s of it.statuses ?? []) {
          if (!seen.has(String(s.id))) {
            seen.set(String(s.id), { id: String(s.id), name: s.name, category: s.statusCategory?.name });
          }
        }
      }
      return { success: true, statuses: [...seen.values()] };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  }, overrides, 'adminDirectory');
}

export async function searchUsers(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { asApp, route } = deps;
    const { query } = req.payload ?? {};
  if (!query || query.trim().length < 2) return { success: true, users: [] };
  try {
    const response = await asApp().requestJira(route`/rest/api/3/user/search?query=${query.trim()}&maxResults=20`);
    if (!response.ok) return { success: false, error: `Jira returned ${response.status}` };
    const body = await response.json();
    return { success: true, users: (body ?? []).map((u) => ({ accountId: u.accountId, displayName: u.displayName, emailAddress: u.emailAddress })) };
  } catch (e) {
    console.error(e);
    return { success: false, error: e.message };
  }
  }, overrides, 'adminDirectory');
}
