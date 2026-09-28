import { Queue } from '@forge/events';

export const LINK_QUEUE_KEY = 'va-link-queue';
const linkQueue = new Queue({ key: LINK_QUEUE_KEY });

/** Forge accepts at most this many events in one push. */
const PUSH_LIMIT = 50;

/**
 * Queue the link decisions one approval made: one job per other issue
 * (lib/approval/linkPropagation.js's linkDecisionJobs), handled by
 * jobs/linkWorker.js. One job at a time per other issue, so two approvals
 * deciding links on the same issue never write its record together. Never
 * throws: returns the jobs that were not queued, each with its error.
 */
export async function enqueueLinkDecisions(jobs, { queue = linkQueue } = {}) {
  const failed = [];
  const events = (jobs ?? []).map(body => ({ body, concurrency: { key: `link:${body.otherIssueId}`, limit: 1 } }));
  for (let start = 0; start < events.length; start += PUSH_LIMIT) {
    const batch = events.slice(start, start + PUSH_LIMIT);
    try {
      await queue.push(batch);
    } catch (error) {
      failed.push(...batch.map(event => ({ body: event.body, error })));
    }
  }
  return { failed };
}
