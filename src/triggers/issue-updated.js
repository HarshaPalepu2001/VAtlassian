import { collectAffectedTrees, affectedTreeRoots, collectTree, collect, ownFlatBaseline } from '../lib/collect.js';
import { executeQuery } from '../lib/db.js';
import { retryEvent, eventTime } from './retry.js';
import { withRequestCache } from '../lib/cache.js';

export function isDependencyBundle(value) {
  return typeof value?.collectAffectedTrees === 'function';
}

/**
 * Handle avi:jira:updated:issue by checking current content for drift.
 *
 * Use the event only to identify affected work. Its changelog varies by field,
 * may be absent, and is reportedly absent entirely in team-managed projects.
 * collectAffectedTrees() re-reads each governed tree and compares it with its
 * signed baseline. Creation, deletion and hourly reconciliation use the same
 * collector.
 *
 * Forge does not guarantee exactly-once or ordered delivery. Repeated delivery
 * recomputes current state and writes nothing when it is unchanged.
 * The handler does not throw.
 */
export async function run(event, suppliedDeps = null) {
  return withRequestCache(() => runUncached(event, suppliedDeps));
}

async function runUncached(event, suppliedDeps) {
  // Forge invokes a trigger as (event, context). Context is not our test
  // dependency bundle; treating it as one silently skipped every update.
  const deps = isDependencyBundle(suppliedDeps)
    ? { recordReceipt, ...suppliedDeps }
    // collect/ownFlatBaseline: a child baselined by its parent's capture has a
    // single-issue baseline, measured by the single-issue collector.
    : { collectAffectedTrees, affectedTreeRoots, collectTree, collect, ownFlatBaseline, recordReceipt };
  const issue = event?.issue;
  if (!issue?.id || !issue?.key) return;

  const issueId = Number(issue.id);
  const issueKey = String(issue.key);
  const eventId = String(event?.eventId ?? event?.id ?? '');
  const now = Date.now();

  try {
    const eventAt = eventTime(event) ?? now;
    const results = await deps.collectAffectedTrees({ ...event, eventId, eventAt }, deps);
    const result = results[0] || { outcome: 'NO_CHANGE' };
    // One event can fan out to several governed roots (collectAffectedTrees);
    // a failure on any of them must not be masked by another root's success.
    const failed = results.find(r => ['ERROR', 'UNREADABLE', 'BUSY'].includes(r.outcome));
    if (failed) return retryEvent(event, failed.outcome);

    // The diff is already idempotent, but the
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
    console.error('updated: handler failed', JSON.stringify({ issueKey }), e);
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
