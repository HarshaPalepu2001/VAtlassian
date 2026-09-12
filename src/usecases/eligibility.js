import { runAdmin, validId, validScope } from './adminRuntime.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';

export async function listAvailableRoles(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery } = deps;
    const { projectId, issueTypeId } = req.payload ?? {};
    if (!projectId) return { success: true, roles: [] };
    const query = (issueTypeId && issueTypeId !== '*')
      ? {
          sql: `SELECT DISTINCT role FROM va_eligibility 
                WHERE state = ? AND (issue_type_id = ? OR issue_type_id = '*') AND (project_id = ? OR project_id IS NULL) 
                ORDER BY role ASC`,
          params: [ACTIVE, issueTypeId, String(projectId)]
        }
      : {
          sql: `SELECT DISTINCT role FROM va_eligibility 
                WHERE state = ? AND (project_id = ? OR project_id IS NULL) 
                ORDER BY role ASC`,
          params: [ACTIVE, String(projectId)]
        };
    const result = await executeQuery(query.sql, query.params);
    if (!result.result) return { success: false, error: 'Failed to list roles' };
    return { success: true, roles: (result.data ?? []).map(r => r.role) };
  }, overrides, 'eligibility');
}

export async function listEligibility(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, fromBinaryColumn, lookupProjects, lookupIssueTypes, lookupUsers, describeScope } = deps;
    const { issueTypeId } = req.payload ?? {};
  const query = issueTypeId
    ? { sql: `SELECT TO_BASE64(el_id) AS el_id, account_id, issue_type_id, role, state, granted_at, granted_by, project_id
               FROM va_eligibility WHERE state = ? AND (issue_type_id = ? OR issue_type_id = '*') ORDER BY granted_at DESC`, params: [ACTIVE, issueTypeId] }
    : { sql: `SELECT TO_BASE64(el_id) AS el_id, account_id, issue_type_id, role, state, granted_at, granted_by, project_id
               FROM va_eligibility WHERE state = ? ORDER BY granted_at DESC`, params: [ACTIVE] };
  const result = await executeQuery(query.sql, query.params);
  if (!result.result) return { success: false, error: 'Failed to list eligibility grants' };
  const rows = result.data ?? [];
  const [issueTypes, users, projects] = await Promise.all([
    lookupIssueTypes(),
    lookupUsers(rows.flatMap((r) => [r.account_id, r.granted_by])),
    lookupProjects()
  ]);
  return {
    success: true,
    grants: rows.map((row) => {
      const signer = users.get(row.account_id);
      const projectName = row.project_id == null
        ? null
        : (projects.get(String(row.project_id))?.name ?? null);
      return {
        elId: fromBinaryColumn(row.el_id).toString('hex'),
        accountId: row.account_id, projectId: row.project_id == null ? null : String(row.project_id), issueTypeId: row.issue_type_id,
        signerName: signer?.displayName ?? null,
        signerActive: signer?.active !== false,
        issueTypeName: row.issue_type_id === '*' ? 'All work item types' : issueTypes.get(String(row.issue_type_id))?.name ?? null,
        role: row.role,
        scope: describeScope(row, projectName),
        siteWide: row.project_id == null,
        grantedAt: row.granted_at,
        grantedByName: users.get(row.granted_by)?.displayName ?? null
      };
    })
  };
  }, overrides, 'eligibility');
}

export async function grantEligibility(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, toBinaryParam, append, EVENT, auditStore, newId, lookupUsers } = deps;
    const { accountId } = req.context;
  const { targetAccountId, issueTypeId, role, projectId = null } = req.payload ?? {};
  if (!targetAccountId || !issueTypeId || !role) {
    return { success: false, error: 'targetAccountId, issueTypeId, and role are all required' };
  }
  if (typeof role !== 'string' || !role.trim() || role !== role.trim() || role.length > 32) return { success: false, error: 'role must be 32 characters or fewer' };
  if (!validScope(projectId ?? '1', issueTypeId) || typeof targetAccountId !== 'string' || targetAccountId.length > 128) throw new Error('Invalid eligibility scope or account.');
  const target = (await lookupUsers([targetAccountId])).get(targetAccountId);
  if (!target || target.active === false) throw new Error('Choose an active Jira user.');
  const elId = newId();
  const now = Date.now();
  const insertResult = await executeQuery(
    `INSERT INTO va_eligibility (el_id, account_id, issue_type_id, role, state, granted_at, granted_by, project_id)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?)`,
    [toBinaryParam(elId), targetAccountId, issueTypeId, role, ACTIVE, now, accountId, projectId == null ? null : String(projectId)]
  );
  if (!insertResult.result) return { success: false, error: 'Failed to grant eligibility' };
  await append(auditStore, {
    eventId: newId(),
    actorAccountId: accountId,
    eventType: EVENT.ELIGIBILITY_CHANGED,
    payload: {
      action: 'GRANTED', targetAccountId, issueTypeId, role,
      scope: projectId == null ? 'ALL_PROJECTS' : 'PROJECT',
      projectId: projectId == null ? null : String(projectId)
    }
  });
  return { success: true, elId: elId.toString('hex') };
  }, overrides, 'eligibility');
}

export async function revokeEligibility(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, toBinaryParam, append, EVENT, auditStore, newId } = deps;
    const { accountId } = req.context;
  const { elId } = req.payload ?? {};
  if (!validId(elId)) return { success: false, error: 'elId is required' };
  const updateResult = await executeQuery(
    `UPDATE va_eligibility SET state = ? WHERE el_id = FROM_BASE64(?)`,
    [REVOKED, toBinaryParam(Buffer.from(elId, 'hex'))]
  );
  if (!updateResult.result) return { success: false, error: 'Failed to revoke eligibility' };
  await append(auditStore, {
    eventId: newId(),
    actorAccountId: accountId,
    eventType: EVENT.ELIGIBILITY_CHANGED,
    payload: { action: 'REVOKED', elId }
  });
  return { success: true };
  }, overrides, 'eligibility');
}
