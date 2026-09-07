import { archive } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';

/** Archive deleted issues; evidence follows the shared retention policy. */
export async function run(event) {
  const issue = event?.issue;
  if (!issue?.id) return;

  const issueId = Number(issue.id);
  const issueKey = String(issue.key ?? issueId);
  const now = Date.now();

  try {
    await archive(issueId, now);
    // Value deletion is governed by the shared verified-export retention policy.

    await tryAppend({
      actorAccountId: event?.atlassianId ?? 'system',
      eventType: EVENT.BASELINE_SUPERSEDED,
      issueId,
      payload: { reason: 'ISSUE_DELETED', issueKey, valuesPurged: false, historyRetained: true }
    });

    console.log('deleted: archived', JSON.stringify({ issueKey }));
  } catch (e) {
    console.error('deleted: handler failed', JSON.stringify({ issueKey }), e);
  }
}
