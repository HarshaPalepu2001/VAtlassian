import { retryEvent } from './retry.js';
import { withRequestCache } from '../lib/cache.js';

export function isDependencyBundle(value) {
  return typeof value?.collectAffectedTrees === 'function';
}

/**
 * Handle avi:jira:created:issue by checking any governed tree containing the
 * new issue. The new issue cannot be a baseline root yet because capture occurs
 * on an approved transition. It may be a new descendant of an existing tree.
 *
 * affectedTreeRoots() walks native parents to find an indexed root because the
 * new issue itself has no baseline-node entry. Load production dependencies
 * from triggers/runtime.js; tests can supply affectedTreeRoots/collectTree
 * without separate, previously incomplete, default-parameter wiring.
 */
export async function run(event, suppliedDeps = null) {
  return withRequestCache(() => runUncached(event, suppliedDeps));
}

async function runUncached(event, suppliedDeps) {
  const deps = isDependencyBundle(suppliedDeps)
    ? suppliedDeps
    : await (await import('./runtime.js')).triggerRuntime();
  const issue = event?.issue;
  if (!issue?.id) return;
  const issueKey = String(issue.key ?? issue.id);

  try {
    const results = await deps.collectAffectedTrees(event, deps);
    const result = results[0] || { outcome: 'NO_CHANGE' };
    // One event can fan out to several governed roots (collectAffectedTrees);
    // a failure on any of them must not be masked by another root's success.
    const failed = results.find(r => ['ERROR', 'UNREADABLE', 'BUSY'].includes(r.outcome));
    if (failed) return retryEvent(event, failed.outcome);
    return result;
  } catch (e) {
    console.error('created: handler failed', JSON.stringify({ issueKey }), e);
    return retryEvent(event, 'COLLECTION_FAILED');
  }
}
