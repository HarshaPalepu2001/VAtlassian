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
