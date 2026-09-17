import { retryEvent } from './retry.js';
import { withRequestCache } from '../lib/cache.js';

export function isDependencyBundle(value) {
  return typeof value?.collectAffectedTrees === 'function';
}

/**
 * avi:jira:created:issue — wakes any governed tree the new issue was born
 * into.
 *
 * THE NEW ISSUE IS NEVER ITSELF A ROOT HERE. A baseline is only ever captured
 * on an approved transition, and this issue was just created, so it can only
 * ever be a new descendant of a tree baselined before it existed. It is not
 * yet in any baseline's node index, which is exactly the case
 * affectedTreeRoots()'s ancestor walk exists for: it climbs the native parent
 * chain until it finds a root that is already indexed.
 *
 * Real dependencies come from triggers/runtime.js so a test can supply its
 * own affectedTreeRoots/collectTree without this module needing its own
 * (previously incomplete) default-parameter wiring.
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
