import * as store from './store.js';

/**
 * Track queued link decisions awaiting this issue's record.
 *
 * An approval that decides a link queues a job that records it on the issue at
 * the other end (jobs/linkWorker.js), a few seconds later. Until it lands, that
 * issue still reads as drifted on the link, and nothing tells an open panel or
 * the validator why. This marks the gap: written when the job is queued,
 * cleared when the worker finishes with it.
 *
 * A marker only means "expected shortly". One older than LINK_PENDING_TTL_MS is
 * ignored. A job that never finished must not leave an
 * issue explaining a hold with a decision that is not coming.
 */
export const LINK_PENDING_TTL_MS = 120_000;

export async function markLinkDecisionsPending(jobs, now, query = store.throwing) {
  const rows = (jobs ?? []).map(job => [Number(job.otherIssueId), Number(job.issueId), String(job.issueKey).slice(0, 64), now]);
  if (!rows.length) return;
  await query(`REPLACE INTO va_link_pending (issue_id, decided_on_issue_id, decided_on_key, queued_at)
    VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}`, rows.flat());
}

export async function clearLinkDecisionPending({ issueId, decidedOnIssueId }, query = store.throwing) {
  await query('DELETE FROM va_link_pending WHERE issue_id = ? AND decided_on_issue_id = ?',
    [Number(issueId), Number(decidedOnIssueId)]);
}

/** Which of these issues have a link decision on its way: Set(issueId). */
export async function linkDecisionsPendingFor(issueIds, now = Date.now(), query = store.throwing) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Set();
  const rows = await query(`SELECT DISTINCT issue_id FROM va_link_pending
    WHERE issue_id IN (${ids.map(() => '?').join(', ')}) AND queued_at >= ?`, [...ids, now - LINK_PENDING_TTL_MS]);
  return new Set((rows ?? []).map(row => Number(row.issue_id)));
}

/** The decisions still expected on this issue: [{ decidedOnKey, queuedAt }]. */
export async function linkDecisionsPending(issueId, now = Date.now(), query = store.throwing) {
  const rows = await query(`SELECT decided_on_key AS decidedOnKey, queued_at AS queuedAt FROM va_link_pending
    WHERE issue_id = ? AND queued_at >= ? ORDER BY queued_at`, [Number(issueId), now - LINK_PENDING_TTL_MS]);
  return (rows ?? []).map(row => ({ decidedOnKey: row.decidedOnKey, queuedAt: Number(row.queuedAt) }));
}
