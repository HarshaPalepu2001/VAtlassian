import { collectAffectedTrees, affectedTreeRoots, collectTree } from '../lib/collect.js';
import { executeQuery } from '../lib/db.js';
import { retryEvent } from './retry.js';

/**
 * avi:jira:updated:issue — the fast path for aggregate drift detection.
 *
 * THE PAYLOAD IS A WAKE-UP ONLY. Nothing here reads the event's changelog for
 * values: it varies by field, is sometimes absent, and is reportedly absent
 * entirely in team-managed projects. collectAffectedTrees() re-reads the whole
 * governed tree the updated node belongs to and diffs it against the signed
 * baseline, which is why the same collector serves this trigger, issue
 * creation, issue deletion, and the hourly reconcile without a second
 * implementation.
 *
 * That also makes redelivery harmless. Forge guarantees neither exactly-once
 * nor ordered delivery; a repeated event recomputes the same tree, finds the
 * same state, and writes nothing.
 *
 * NEVER THROWS.
 */
export async function run(event, deps = { collectAffectedTrees, affectedTreeRoots, collectTree, recordReceipt }) {
  const issue = event?.issue;
  if (!issue?.id || !issue?.key) return;

  const issueId = Number(issue.id);
  const issueKey = String(issue.key);
  const eventId = String(event?.eventId ?? event?.id ?? '');
  const now = Date.now();

  try {
    const results = await deps.collectAffectedTrees(event, deps);
    const result = results[0] || { outcome: 'NO_CHANGE' };
    if (['ERROR', 'UNREADABLE', 'BUSY'].includes(result.outcome)) return retryEvent(event, result.outcome);

    // Not required for correctness — the diff is already idempotent — but the
    // audit trail should be able to say WHY a check ran and whether an event
    // was seen twice. Pruned by the daily job after 30 days.
    if (eventId) await deps.recordReceipt(eventId, issueId, now, result.outcome);

    // NO_CHANGE is the overwhelming majority of these events (comments,
    // worklogs, sprint moves) and logging it would drown everything useful.
    if (result.outcome === 'DRIFT_RECORDED') {
      console.log('updated: drift', JSON.stringify({
        issueKey,
        inserted: result.inserted,
        kinds: result.kinds
      }));
    }
    return result;
  } catch (e) {
    console.error('updated: handler failed', JSON.stringify({ issueKey }));
    return retryEvent(event, 'COLLECTION_FAILED');
  }
}

async function recordReceipt(eventId, issueId, now, outcome) {
  // REPLACE rather than INSERT: a redelivered event should update its receipt,
  // not fail on a duplicate key and take the handler down with it.
  await executeQuery(
    `REPLACE INTO va_event_receipt (event_id, issue_id, received_at, outcome)
     VALUES (?, ?, ?, ?)`,
    [eventId.slice(0, 128), issueId, now, String(outcome ?? 'UNKNOWN').slice(0, 24)]
  );
}
