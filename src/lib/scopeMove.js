import { moveScope } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

/**
 * After a project or issue-type move, use the destination's tracked fields.
 * A destination tracking no fields holds nothing. Record the source,
 * destination and destination tracking state once in the audit trail.
 * This rule was decided on 2026-09-24.
 *
 * Return true for a changed scope, even if another caller recorded the move,
 * so callers can re-read content with the destination's fields.
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
