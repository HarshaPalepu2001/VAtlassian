import { collect, DETECTED_VIA } from '../lib/collect.js';
import { executeQuery } from '../lib/db.js';
import { retryEvent, eventTime } from './retry.js';
import { withRequestCache } from '../lib/cache.js';

export async function run(event) {
  return withRequestCache(() => runUncached(event));
}

async function runUncached(event) {
  const issueLink = event?.issueLink;
  if (!issueLink) return;

  const sourceId = Number(issueLink.sourceIssueId);
  const destId = Number(issueLink.destinationIssueId);
  const eventId = String(event?.eventId ?? event?.id ?? '');
  const now = Date.now();

  const actorAccountId = event?.atlassianId ?? null;
  let failed = false;

  for (const issueId of [sourceId, destId]) {
    if (!issueId) continue;
    try {
      const result = await collect({
        issueId,
        detectedVia: DETECTED_VIA.EVENT,
        actorAccountId,
        eventId, eventAt: eventTime(event),
        now
      });
      if (['ERROR', 'UNREADABLE', 'BUSY'].includes(result.outcome)) { failed = true; continue; }

      if (eventId) await recordReceipt(eventId, issueId, now, result.outcome);

      if (result.outcome === 'DRIFT_RECORDED') {
        console.log('linked: drift', JSON.stringify({
          issueId,
          inserted: result.inserted,
          fields: result.fields,
          driftCount: result.driftCount
        }));
      }
    } catch (e) {
      console.error('linked: handler failed', JSON.stringify({ issueId }), e);
      failed = true;
    }
  }
  if (failed) return retryEvent(event, 'LINK_COLLECTION_FAILED');
}

async function recordReceipt(eventId, issueId, now, outcome) {
  await executeQuery(
    `REPLACE INTO va_event_receipt (event_id, issue_id, received_at, outcome)
     VALUES (?, ?, ?, ?)`,
    [`${eventId.slice(0, 100)}-${issueId}`, issueId, now, String(outcome ?? 'UNKNOWN').slice(0, 24)]
  );
}
