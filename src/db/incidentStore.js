import { toBinaryParam } from '../lib/db.js';
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
 * a subsequent baseline does not prove the underlying workflow was repaired. */
export async function issueControlStatus({ issueId, projectId, issueTypeId }) {
  const [incidents, gateFindings] = await Promise.all([
    throwing(`SELECT event_type, occurred_at FROM va_incident
      WHERE issue_id = ? ORDER BY occurred_at DESC LIMIT 5`, [Number(issueId)]),
    projectId != null && issueTypeId != null ? throwing(
      `SELECT finding_type, severity, detail, last_seen_at FROM va_gate_finding
       WHERE project_id = ? AND (issue_type_id = ? OR issue_type_id = '*')
         AND cleared_at IS NULL ORDER BY last_seen_at DESC LIMIT 5`,
      [String(projectId), String(issueTypeId)]
    ) : []
  ]);
  return { incidents, gateFindings };
}
