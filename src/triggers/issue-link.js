import { collectAffectedTrees, affectedTreeRoots, collectTree, collect, ownFlatBaseline } from '../lib/collect.js';
import { executeQuery } from '../lib/db.js';
import { retryEvent } from './retry.js';
import { withRequestCache } from '../lib/cache.js';

/**
 * avi:jira:created:issuelink / deleted:issuelink — a link is one object both
 * issues list, so both ends are measured.
 *
 * Each end goes the way an issue update goes (triggers/issue-updated.js): the
 * governed tree it belongs to, and its own single-issue record when it has one.
 * It used to run the single-issue collector directly, which for a tree baseline
 * (every capture writes one) compared the item against the row's empty digest
 * map and recorded every tracked field as drift.
 */
export async function run(event, suppliedDeps = null) {
  return withRequestCache(() => runUncached(event, suppliedDeps));
}

async function runUncached(event, suppliedDeps) {
  const issueLink = event?.issueLink;
  if (!issueLink) return;
  const deps = typeof suppliedDeps?.collectAffectedTrees === 'function'
    ? { recordReceipt, ...suppliedDeps }
    : { collectAffectedTrees, affectedTreeRoots, collectTree, collect, ownFlatBaseline, recordReceipt };

  const eventId = String(event?.eventId ?? event?.id ?? '');
  const now = Date.now();
  let failed = null;

  for (const issueId of [Number(issueLink.sourceIssueId), Number(issueLink.destinationIssueId)]) {
    if (!issueId) continue;
    try {
      const results = await deps.collectAffectedTrees({ ...event, issue: { id: String(issueId) } }, deps);
      const bad = results.find(r => ['ERROR', 'UNREADABLE', 'BUSY'].includes(r?.outcome));
      if (bad) { failed = bad.outcome; continue; }
      const outcome = results.find(r => r?.outcome === 'DRIFT_RECORDED')?.outcome ?? results[0]?.outcome ?? 'NO_CHANGE';
      if (eventId) await deps.recordReceipt(eventId, issueId, now, outcome);
      if (outcome === 'DRIFT_RECORDED') console.log('linked: drift', JSON.stringify({ issueId }));
    } catch (e) {
      console.error('linked: handler failed', JSON.stringify({ issueId }), e);
      failed = 'LINK_COLLECTION_FAILED';
    }
  }
  if (failed) return retryEvent(event, failed);
}

async function recordReceipt(eventId, issueId, now, outcome) {
  await executeQuery(
    `REPLACE INTO va_event_receipt (event_id, issue_id, received_at, outcome)
     VALUES (?, ?, ?, ?)`,
    [`${eventId.slice(0, 100)}-${issueId}`, issueId, now, String(outcome ?? 'UNKNOWN').slice(0, 24)]
  );
}
