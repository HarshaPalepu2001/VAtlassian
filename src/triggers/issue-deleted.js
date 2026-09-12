import { archive } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
import { collectAffectedTrees, affectedTreeRoots, collectTree } from '../lib/collect.js';

/**
 * avi:jira:deleted:issue.
 *
 * COLLECT BEFORE ARCHIVING. The deleted node's tree membership is read from
 * the baseline's own node index — archive() only ever touches this issue's
 * own va_item_state row, which affectedTreeRoots()'s indexed lookup does not
 * depend on either way, but there is no reason to race the two when running
 * the tree lookup first costs nothing.
 */
export async function run(event, deps = { collectAffectedTrees, affectedTreeRoots, collectTree }) {
  const issue = event?.issue;
  if (!issue?.id) return;
  const issueId = Number(issue.id);
  const issueKey = String(issue.key ?? issueId);
  const now = Date.now();

  try {
    const results = await deps.collectAffectedTrees(event, deps);
    await archive(issueId, now);

    await tryAppend({
      actorAccountId: event?.atlassianId ?? 'system',
      eventType: EVENT.BASELINE_SUPERSEDED,
      issueId,
      payload: { reason: 'ISSUE_DELETED', issueKey, valuesPurged: false, historyRetained: true }
    });

    console.log('deleted: archived', JSON.stringify({ issueKey }));
    return results[0] || { outcome: 'NO_CHANGE' };
  } catch (e) {
    console.error('deleted: handler failed', JSON.stringify({ issueKey }), e);
  }
}
