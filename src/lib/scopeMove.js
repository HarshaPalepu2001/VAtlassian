import { moveScope } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

/**
 * A BASELINED WORK ITEM MOVED TO ANOTHER PROJECT OR ISSUE TYPE.
 *
 * Decided 2026-09-24: the item follows the destination's configuration from
 * then on, as a tracker item does after a move in codebeamer — the destination's
 * tracked fields decide what drift is, and a destination with none holds
 * nothing. The move itself must not pass silently, so it is recorded once in the
 * audit trail with where the item came from, where it went, and whether the
 * destination tracks anything.
 *
 * Returns true when the item was found in a new scope (whether or not this call
 * was the one that recorded it), so a caller that chose its tracked fields from
 * the old scope knows to re-read under the new one.
 */
export async function recordScopeMove({ issueId, review, projectId, issueTypeId, actorAccountId = null,
  destinationFieldCount = null, deps = { moveScope, tryAppend } }) {
  if (review?.project_id == null || review?.issue_type_id == null) return false;
  const fromProjectId = Number(review.project_id);
  const fromIssueTypeId = String(review.issue_type_id);
  if (fromProjectId === Number(projectId) && fromIssueTypeId === String(issueTypeId)) return false;

  const recorded = await deps.moveScope({ issueId: Number(issueId), fromProjectId, fromIssueTypeId,
    toProjectId: Number(projectId), toIssueTypeId: String(issueTypeId) }).catch(() => false);
  if (recorded) {
    await deps.tryAppend({
      actorAccountId: actorAccountId ?? 'system',
      eventType: EVENT.BASELINE_SCOPE_CHANGED,
      issueId: Number(issueId),
      payload: {
        fromProjectId, fromIssueTypeId,
        toProjectId: Number(projectId), toIssueTypeId: String(issueTypeId),
        baselineVersion: review.baseline_version == null ? null : Number(review.baseline_version),
        destinationTrackedFields: destinationFieldCount
      }
    });
  }
  return true;
}
