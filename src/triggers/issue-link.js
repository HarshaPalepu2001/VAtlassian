import { collect, DETECTED_VIA } from '../lib/collect.js';
import { executeQuery } from '../lib/db.js';

export async function run(event) {
  const issueLink = event?.issueLink;
  if (!issueLink) return;

  const sourceId = Number(issueLink.sourceIssueId);
  const destId = Number(issueLink.destinationIssueId);
  const eventId = String(event?.eventId ?? event?.id ?? '');
  const now = Date.now();

  const actorAccountId = event?.atlassianId ?? null;

  for (const issueId of [sourceId, destId]) {
    if (!issueId) continue;
    try {
      const result = await collect({
        issueId,
        detectedVia: DETECTED_VIA.EVENT,
        actorAccountId,
        now
      });

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
    }
  }
}

async function recordReceipt(eventId, issueId, now, outcome) {
  await executeQuery(
    `REPLACE INTO va_event_receipt (event_id, issue_id, received_at, outcome)
     VALUES (?, ?, ?, ?)`,
    [`${eventId.slice(0, 100)}-${issueId}`, issueId, now, String(outcome ?? 'UNKNOWN').slice(0, 24)]
  );
}
