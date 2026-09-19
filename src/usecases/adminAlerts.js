import { runAdmin, query, validScope } from './adminRuntime.js';
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
  if (!validScope(projectId, issueTypeId) || issueTypeId === '*') throw new Error('Choose a valid project and work item type.');
  const response = await deps.asApp().requestJira(deps.route`/rest/api/3/issuetype/project?projectId=${projectId}`);
  if (!response.ok) throw new Error('Could not validate the alert destination in Jira.');
  const types = await response.json();
  if (!Array.isArray(types) || !types.some(t => String(t.id) === String(issueTypeId) && t.subtask !== true)) {
    throw new Error('Choose a standard work item type belonging to the alert project. Subtasks require a parent and cannot receive alerts.');
  }
  const now = Date.now();
  await append(auditStore, {
    eventId: newId(), actorAccountId: accountId, eventType: EVENT.CONFIG_CHANGED,
    payload: { change: 'ALERT_DESTINATION', action: 'SAVE_REQUESTED', projectId: String(projectId), issueTypeId: String(issueTypeId) }
  });
  await query(deps, `INSERT INTO va_config (cfg_key, cfg_value, updated_at, updated_by)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
    [ALERT_PROJECT_CFG, String(projectId), now, accountId, ALERT_ISSUE_TYPE_CFG, String(issueTypeId), now, accountId]);
  return { success: true };
  }, overrides, 'adminAlerts');
}

export async function listGateFindings(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, lookupProjects, lookupIssueTypes, lookupStatuses } = deps;
    const { accountId } = req.context;
  const includeCleared = req.payload?.includeCleared === true;
  const [result, missingTransitionResult] = await Promise.all([
    executeQuery(
      `SELECT finding_key, finding_type, severity, project_id, issue_type_id,
              workflow_id, transition_id, from_status_id, to_status_id,
              detail, first_seen_at, last_seen_at, cleared_at
         FROM va_gate_finding
        ${includeCleared ? '' : 'WHERE cleared_at IS NULL'}
        ORDER BY cleared_at IS NULL DESC, severity ASC, first_seen_at ASC`
    ),
    // Rows saved before an exact transition id was required. gatedTransition()
    // now matches on transition_id exactly, so a row with none can never match
    // any Jira transition again — it is not "gating everything out of this
    // status", it is silently gating nothing. That failure mode has no
    // gatecheck signature to diff against a live workflow, so it is surfaced
    // here directly rather than guessed at as one edge or another.
    executeQuery(
      `SELECT TO_BASE64(ct_id) AS ct_id, project_id, issue_type_id, from_status_id, to_status_id, created_at
         FROM va_controlled_transition
        WHERE state = 'ACTIVE' AND transition_id IS NULL`
    )
  ]);
  if (!result.result) return { success: false, error: 'Failed to list gate findings' };
  if (!missingTransitionResult.result) throw new Error('Could not check rules missing an exact transition. Control health is unavailable.');
  const rows = result.data ?? [];
  const missingRows = missingTransitionResult.result ? (missingTransitionResult.data ?? []) : [];
  const [projects, issueTypes, statuses] = await Promise.all([
    lookupProjects(),
    lookupIssueTypes(),
    lookupStatuses()
  ]);
  const statusName = (id) => (id == null ? null : (id === '*' ? 'Any status' : statuses.get(String(id))?.name ?? null));
  const issueTypeName = (id) => (id === '*' ? 'All work item types' : issueTypes.get(String(id))?.name ?? null);
  const missingTransitionFindings = missingRows.map((row) => ({
    findingKey: `MISSING_TRANSITION_ID:${row.ct_id}`,
    type: 'MISSING_TRANSITION_ID',
    severity: 'CRITICAL',
    projectKey: projects.get(String(row.project_id))?.key ?? null,
    projectName: projects.get(String(row.project_id))?.name ?? null,
    issueTypeName: issueTypeName(row.issue_type_id),
    fromStatusName: statusName(row.from_status_id),
    toStatusName: statusName(row.to_status_id),
    workflowId: null,
    transitionId: null,
    detail: 'This controlled transition has no exact Jira transition selected, so it can no longer be enforced. Edit it and choose the exact transition it governs.',
    firstSeenAt: row.created_at,
    lastSeenAt: Date.now(),
    clearedAt: null,
    openForMs: Date.now() - Number(row.created_at)
  }));
  return {
    success: true,
    findings: [
      ...missingTransitionFindings,
      ...rows.map((row) => ({
        findingKey: row.finding_key,
        type: row.finding_type,
        severity: row.severity,
        projectKey: projects.get(String(row.project_id))?.key ?? null,
        projectName: projects.get(String(row.project_id))?.name ?? null,
        issueTypeName: issueTypeName(row.issue_type_id),
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
    ]
  };
  }, overrides, 'adminAlerts');
}
