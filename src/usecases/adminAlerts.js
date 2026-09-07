import { runAdmin } from './adminRuntime.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';

export async function getAlertDestination(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, lookupProjects, undeliveredCount, ALERT_PROJECT_CFG, ALERT_ISSUE_TYPE_CFG } = deps;
    const { accountId } = req.context;
  const [cfg, stuck] = await Promise.all([
    executeQuery('SELECT cfg_key, cfg_value FROM va_config WHERE cfg_key IN (?, ?)', [ALERT_PROJECT_CFG, ALERT_ISSUE_TYPE_CFG]),
    undeliveredCount()
  ]);
  if (!cfg.result) return { success: false, error: 'Failed to read alert destination' };
  const map = Object.fromEntries((cfg.data ?? []).map((r) => [r.cfg_key, r.cfg_value]));
  const projectId = map[ALERT_PROJECT_CFG] ?? null;
  const projects = await lookupProjects();
  return {
    success: true,
    configured: Boolean(projectId && map[ALERT_ISSUE_TYPE_CFG]),
    projectId,
    projectKey: projectId ? (projects.get(String(projectId))?.key ?? null) : null,
    issueTypeId: map[ALERT_ISSUE_TYPE_CFG] ?? null,
    undelivered: stuck
  };
  }, overrides, 'adminAlerts');
}

export async function setAlertDestination(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, append, EVENT, auditStore, newId, ALERT_PROJECT_CFG, ALERT_ISSUE_TYPE_CFG } = deps;
    const { accountId } = req.context;
  const { projectId, issueTypeId } = req.payload ?? {};
  if (!projectId || !issueTypeId) {
    return { success: false, error: 'Choose both a project and a work item type for security alerts.' };
  }
  const now = Date.now();
  for (const [key, value] of [[ALERT_PROJECT_CFG, String(projectId)], [ALERT_ISSUE_TYPE_CFG, String(issueTypeId)]]) {
    const res = await executeQuery(
      `INSERT INTO va_config (cfg_key, cfg_value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
      [key, value, now, accountId]
    );
    if (!res.result) return { success: false, error: 'Failed to save alert destination' };
  }
  await append(auditStore, {
    eventId: newId(),
    actorAccountId: accountId,
    eventType: EVENT.CONTROLLED_TRANSITION_CHANGED,
    payload: { change: 'ALERT_DESTINATION', projectId: String(projectId), issueTypeId: String(issueTypeId) }
  });
  return { success: true };
  }, overrides, 'adminAlerts');
}

export async function listGateFindings(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, lookupProjects, lookupIssueTypes, lookupStatuses } = deps;
    const { accountId } = req.context;
  const includeCleared = req.payload?.includeCleared === true;
  const result = await executeQuery(
    `SELECT finding_key, finding_type, severity, project_id, issue_type_id,
            workflow_id, transition_id, from_status_id, to_status_id,
            detail, first_seen_at, last_seen_at, cleared_at
       FROM va_gate_finding
      ${includeCleared ? '' : 'WHERE cleared_at IS NULL'}
      ORDER BY cleared_at IS NULL DESC, severity ASC, first_seen_at ASC`
  );
  if (!result.result) return { success: false, error: 'Failed to list gate findings' };
  const rows = result.data ?? [];
  const [projects, issueTypes, statuses] = await Promise.all([
    lookupProjects(),
    lookupIssueTypes(),
    lookupStatuses()
  ]);
  const statusName = (id) => (id == null ? null : (id === '*' ? 'Any status' : statuses.get(String(id))?.name ?? null));
  return {
    success: true,
    findings: rows.map((row) => ({
      findingKey: row.finding_key,
      type: row.finding_type,
      severity: row.severity,
      projectKey: projects.get(String(row.project_id))?.key ?? null,
      projectName: projects.get(String(row.project_id))?.name ?? null,
      issueTypeName: issueTypes.get(String(row.issue_type_id))?.name ?? null,
      fromStatusName: statusName(row.from_status_id),
      toStatusName: statusName(row.to_status_id),
      workflowId: row.workflow_id,
      transitionId: row.transition_id,
      detail: row.detail,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      clearedAt: row.cleared_at,
      openForMs: (row.cleared_at ?? Date.now()) - row.first_seen_at
    }))
  };
  }, overrides, 'adminAlerts');
}
