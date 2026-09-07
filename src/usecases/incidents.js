import { recordIncident as dbRecordIncident } from '../db/incidentStore.js';

export async function recordIncident(issueId, accountId, eventType, now) {
  return await dbRecordIncident(issueId, accountId, eventType, now);
}
