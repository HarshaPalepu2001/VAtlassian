import { toBinaryParam, executeQuery } from '../lib/db.js';
import { SEVERITY } from '../lib/gateDrift.js';
import { newId, throwing } from './store.js';

export async function recordIncident(issueId, accountId, eventType, now) {
  const incidentId = newId();
  await throwing(
    `INSERT INTO va_incident (incident_id, issue_id, account_id, event_type, occurred_at) VALUES (FROM_BASE64(?), ?, ?, ?, ?)`,
    [toBinaryParam(incidentId), issueId, accountId ?? null, eventType, now]
  );
  return incidentId.toString('hex');
}

/** Read-only control alerts. Incidents are historical facts and stay visible;
 * a subsequent baseline does not prove the underlying workflow was repaired.
 *
 * Excludes RECALL_* findings (see recordRecallFinding below) because those
 * carry offered transition ids and Jira's own error text, which is a
 * configuration conversation for an administrator, not a fact to hand an
 * ordinary reviewer looking at one issue. Their gate visibility here stays
 * limited to what gatecheck.js actually found wrong with the workflow itself. */
export async function issueControlStatus({ issueId, projectId, issueTypeId }) {
  const [incidents, gateFindings] = await Promise.all([
    throwing(`SELECT event_type, occurred_at FROM va_incident
      WHERE issue_id = ? ORDER BY occurred_at DESC LIMIT 5`, [Number(issueId)]),
    projectId != null && issueTypeId != null ? throwing(
      `SELECT finding_type, severity, detail, last_seen_at FROM va_gate_finding
       WHERE project_id = ? AND (issue_type_id = ? OR issue_type_id = '*')
         AND cleared_at IS NULL AND finding_type NOT LIKE 'RECALL\\_%'
       ORDER BY last_seen_at DESC LIMIT 5`,
      [String(projectId), String(issueTypeId)]
    ) : []
  ]);
  return { incidents, gateFindings };
}

/**
 * Administrator-only finding for a drift recall that could not be applied automatically.
 *
 * Reuses va_gate_finding rather than a parallel table. A recall stuck behind
 * an ambiguous route, a transition screen, a Jira refusal, or incomplete
 * baseline provenance is a control-health fact of exactly the shape
 * jobs/gatecheck.js already reports. It is dated, deduplicated and read by the
 * same admin health list
 * (usecases/adminAlerts.js's listGateFindings). It is deliberately excluded
 * from issueControlStatus() above: an ordinary reviewer needs to know a
 * recall did not happen, not which transition ids collided or what Jira's
 * error body said.
 *
 * The deduplication key is the baseline id/version plus the failure type, so repeated
 * drift against the same stuck baseline advances one row's `last_seen_at` to the last retry time instead of adding a row
 * per attempt.
 */
/**
 * Administrator-only count of open control findings touching this
 * issue, without the LIMIT-5 detail issueControlStatus() returns.
 *
 * The panel summary shows this as a number so an administrator knows to open
 * the full detail view; it must never be the number itself that decides
 * anything, only a hint to go look.
 */
export async function adminIncidentCount({ issueId, projectId, issueTypeId }) {
  const [incidentRows, findingRows] = await Promise.all([
    throwing(`SELECT COUNT(*) AS n FROM va_incident WHERE issue_id = ?`, [Number(issueId)]),
    projectId != null && issueTypeId != null ? throwing(
      `SELECT COUNT(*) AS n FROM va_gate_finding
       WHERE project_id = ? AND (issue_type_id = ? OR issue_type_id = '*')
         AND cleared_at IS NULL AND finding_type NOT LIKE 'RECALL\\_%'`,
      [String(projectId), String(issueTypeId)]
    ) : [{ n: 0 }]
  ]);
  return Number(incidentRows?.[0]?.n ?? 0) + Number(findingRows?.[0]?.n ?? 0);
}

export async function recordRecallFinding({
  baselineId, baselineVersion, issueId, projectId, issueTypeId, failureType,
  currentStatusId, targetStatusId, offeredTransitionIds, hasScreen, jiraResponse, now
}) {
  const findingKey = `RECALL:${baselineId}:${baselineVersion}:${failureType}`;
  const offered = offeredTransitionIds ?? [];
  const detail = JSON.stringify({
    issueId: issueId ?? null,
    offeredTransitionIds: offered,
    hasScreen: !!hasScreen,
    jiraResponse: jiraResponse ?? null
  });
  const res = await executeQuery(
    `INSERT INTO va_gate_finding
       (finding_key, finding_type, severity, project_id, issue_type_id,
        workflow_id, transition_id, from_status_id, to_status_id,
        detail, first_seen_at, last_seen_at, cleared_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       last_seen_at = VALUES(last_seen_at),
       detail       = VALUES(detail),
       cleared_at   = NULL`,
    [
      findingKey, `RECALL_${failureType}`, SEVERITY.WARNING,
      projectId != null ? String(projectId) : null,
      issueTypeId != null ? String(issueTypeId) : null,
      offered.length === 1 ? String(offered[0]) : null,
      currentStatusId != null ? String(currentStatusId) : null,
      targetStatusId != null ? String(targetStatusId) : null,
      detail, now, now
    ]
  );
  if (!res.result) console.error(`incidentStore: could not record recall finding ${findingKey}`, res.error);
  return res.result === true;
}

export async function clearRecallFindings({ baselineId, baselineVersion, now = Date.now() }) {
  const prefix = `RECALL:${baselineId}:${baselineVersion}:%`;
  const res = await executeQuery(
    `UPDATE va_gate_finding
     SET cleared_at = ?
     WHERE finding_key LIKE ? AND cleared_at IS NULL`,
    [now, prefix]
  );
  if (!res.result) console.error(`incidentStore: could not clear recall findings for ${baselineId}`, res.error);
  return res.result === true;
}
