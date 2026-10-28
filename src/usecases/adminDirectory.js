import { runAdmin } from './adminRuntime.js';
import { isOurGate, isDisabled } from '../lib/gateDrift.js';
import { MODULE_KEY } from '../lib/workflowSource.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';

export async function listProjects(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { asApp, route } = deps;
    try {
    const projects = new Map();
    let startAt = 0;
    for (;;) {
      const response = await asApp().requestJira(route`/rest/api/3/project/search?maxResults=100&startAt=${startAt}`);
      if (!response.ok) throw new Error(`Could not load all projects: Jira returned ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.values)) throw new Error('Jira returned an unreadable project list.');
      const before = projects.size;
      for (const p of body.values) projects.set(String(p.id), { id: String(p.id), key: p.key, name: p.name });
      startAt += body.values.length;
      if (body.isLast === true || (body.isLast !== false && (body.total == null || startAt >= body.total))) break;
      if (projects.size === before) throw new Error('Jira project pagination did not advance. Please retry.');
    }
    return { success: true, projects: [...projects.values()] };
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
  if (projectId !== '*' && !/^[1-9]\d*$/.test(String(projectId ?? ''))) return { success: false, error: 'Choose a project or all projects.' };
  try {
    const response = await asApp().requestJira(projectId === '*'
      ? route`/rest/api/3/issuetype`
      : route`/rest/api/3/issuetype/project?projectId=${projectId}`);
    if (!response.ok) return { success: false, error: `Jira returned ${response.status}` };
    const body = await response.json();
    return { success: true, issueTypes: (body ?? []).map((t) => ({ id: String(t.id), name: t.name, subtask: t.subtask === true })) };
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

/**
 * Every exact transition Jira's live workflow offers for one project + issue
 * type, normalized for the admin picker.
 *
 * WHY THIS EXISTS. The old console asked an administrator to name a from-
 * status and a to-status and typed those into va_controlled_transition
 * directly. Two workflow transitions can share a destination status
 * (gatedTransition() in db/configStore.js), so a rule saved that way could
 * describe an edge Jira does not actually have, or silently collide with a
 * sibling transition the admin never meant to touch. This reads the workflow
 * Jira is actually running and hands back one row per real edge, so the
 * console can offer an exact transition id instead of a guess.
 *
 * NEVER TRUSTS THE BROWSER. Every field here — including whether our own
 * va-gate validator is attached — comes from this live read, re-verified on
 * every call. createControlledTransition/updateControlledTransition
 * (transitionsValidation.js#verifyControlledTransition) read the same source
 * again at save time rather than trusting whatever this call returned
 * earlier.
 *
 * INITIAL transitions (issue creation) are excluded — they have no
 * from-status, so they can never be a controlled edge (see
 * gateDrift.js#transitionCovers). A DIRECTED transition reachable from
 * several statuses is exploded into one row per from-status, because that is
 * the exact edge the picker and the controlled-transition table both key on;
 * a GLOBAL transition is reachable from every status and is represented once
 * with the `fromStatusId: '*'` wildcard gateDrift.js already uses for that.
 */
export async function listWorkflowTransitions(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { readWorkflowForPair, runtimeAppId, lookupStatuses } = deps;
    const { projectId, issueTypeId } = req.payload ?? {};
    if (!/^\d+$/.test(String(projectId ?? '')) || !/^\d+$/.test(String(issueTypeId ?? ''))) {
      return { success: false, error: 'An exact project and work item type are required.' };
    }
    const workflow = await readWorkflowForPair({ projectId: String(projectId), issueTypeId: String(issueTypeId) });
    if (!workflow) {
      return { success: false, error: 'Could not read the live Jira workflow for this project and work item type.' };
    }
    const appId = runtimeAppId();
    const statuses = await lookupStatuses();
    const statusName = (id) => (id === '*' ? 'Any status' : statuses.get(String(id))?.name ?? null);

    const rows = [];
    for (const t of workflow.transitions ?? []) {
      if (t.type === 'INITIAL') continue;
      const ours = (t.validators ?? []).filter((v) => isOurGate(v, { appId, moduleKey: MODULE_KEY }));
      const base = {
        transitionId: String(t.id),
        name: t.name,
        toStatusId: String(t.toStatusReference),
        toStatusName: statusName(t.toStatusReference),
        hasScreen: Boolean(t.transitionScreen),
        jiraRules: {
          conditions: Boolean(t.conditions),
          otherValidators: (t.validators ?? []).length - ours.length,
          postFunctions: (t.postFunctions ?? []).length
        },
        validatorAttached: ours.length > 0 && !ours.every(isDisabled)
      };
      if (t.type === 'GLOBAL') {
        rows.push({ ...base, fromStatusId: '*', fromStatusName: 'Any status', global: true });
        continue;
      }
      for (const link of t.links ?? []) {
        rows.push({
          ...base,
          fromStatusId: String(link.fromStatusReference),
          fromStatusName: statusName(link.fromStatusReference),
          global: false
        });
      }
    }
    return { success: true, transitions: rows };
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
    return { success: true, users: (body ?? []).filter(u => u.active !== false && u.accountType !== 'app').map((u) => ({ accountId: u.accountId, displayName: u.displayName, emailAddress: u.emailAddress })) };
  } catch (e) {
    console.error(e);
    return { success: false, error: e.message };
  }
  // Jira administrators need the same picker to repair the administrator roster.
  }, overrides, 'adminDirectory', { allowJiraAdmin: true });
}
