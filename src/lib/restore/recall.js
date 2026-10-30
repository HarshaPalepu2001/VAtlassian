import api from '@forge/api';
import { availableTransitions, applyTransition } from '../transitions.js';
import { recallPlan, RECALL } from '../recall.js';
import { tryAppend } from '../../db/store.js';
import { recordRecallFinding, clearRecallFindings } from '../../db/incidentStore.js';
import { EVENT } from '../ledger.js';

/**
 * Record a failed automatic recall in the work item's ledger and as a
 * deduplicated administrator finding. Keep offered transition ids, screen
 * metadata and Jira's response in the administrator detail.
 * collect.js also uses this for incomplete baseline provenance, which cannot
 * reach recallToReview without a reviewStatusId.
 */
export async function recordRecallFailure({
  issueId, issueKey, projectId, issueTypeId, baselineId, baselineVersion,
  failureType, currentStatusId, targetStatusId, driftCount,
  offeredTransitionIds = null, hasScreen = false, jiraResponse = null, now = Date.now()
}) {
  console.error('collect: drift recall blocked', JSON.stringify({
    issueKey, issueId, failureType, currentStatusId, targetStatusId,
    offered: offeredTransitionIds, hasScreen
  }));
  await tryAppend({
    actorAccountId: 'system:recall',
    eventType: EVENT.DRIFT_RECALL_FAILED,
    issueId,
    payload: {
      reason: failureType, currentStatusId, target: targetStatusId, driftCount,
      baselineId, baselineVersion, offered: offeredTransitionIds, hasScreen, jiraResponse
    }
  });
  try {
    await recordRecallFinding({
      baselineId, baselineVersion, issueId, projectId, issueTypeId, failureType,
      currentStatusId, targetStatusId, offeredTransitionIds, hasScreen, jiraResponse, now
    });
  } catch (e) {
    console.error('collect: could not record recall finding', e);
  }
}

/**
 * Execute lib/recall.js's plan and record its outcome. reviewStatusId,
 * baselineId and baselineVersion come from baselinePolicy(activeBaseline).
 * Do not read current configuration or fall back to a different review status.
 * lib/recall.js handles already-in-review items, ambiguous routes and missing
 * routes.
 */
export async function recallToReview({
  issueId, issueKey, projectId, issueTypeId,
  currentStatusId, driftCount, baselineId, baselineVersion, reviewStatusId, now
}) {
  try {
    // Cheap checks before the round trips. An item that drifted while sitting in
    // review is the common case on a busy project, and it must not cost a REST
    // call to conclude there is nothing to do.
    const preflight = recallPlan({
      currentStatusId, targetStatusId: reviewStatusId, transitions: [], driftCount
    });
    if (preflight.action === RECALL.NO_DRIFT || preflight.action === RECALL.ALREADY_IN_REVIEW) {
      return preflight;
    }

    // asApp: this runs from a trigger or the sweep, where there is no user to
    // act as, and the move is genuinely the app's own. See transitions.js.
    const transitions = await availableTransitions(api, issueKey, { asApp: true });
    const plan = recallPlan({
      currentStatusId, targetStatusId: reviewStatusId, transitions, driftCount
    });

    if (plan.action !== RECALL.RECALL) {
      // LOUD. The item is now knowingly outside review with undecided drift,
      // and no amount of retrying will fix a workflow that cannot resolve to
      // exactly one screen-free route. Somebody has to look.
      await recordRecallFailure({
        issueId, issueKey, projectId, issueTypeId, baselineId, baselineVersion,
        failureType: plan.action, currentStatusId, targetStatusId: plan.target ?? reviewStatusId,
        driftCount, offeredTransitionIds: plan.offered ?? (plan.transitionId ? [plan.transitionId] : []),
        hasScreen: plan.action === RECALL.SCREEN_BLOCKED, now
      });
      return plan;
    }

    const res = await applyTransition(api, {
      issueKey, transitionId: plan.transitionId, fields: {}, asApp: true
    });

    if (!res.ok) {
      // Most often a workflow validator or precondition this app cannot see
      // from the transitions list. Recorded with Jira's own reason so the
      // workflow can be fixed rather than the failure being blamed on drift
      // detection.
      await recordRecallFailure({
        issueId, issueKey, projectId, issueTypeId, baselineId, baselineVersion,
        failureType: RECALL.JIRA_REFUSED, currentStatusId, targetStatusId: plan.target,
        driftCount, offeredTransitionIds: [plan.transitionId],
        jiraResponse: { status: res.status, messages: res.messages ?? null }, now
      });
      return { ...plan, action: RECALL.JIRA_REFUSED, applied: false };
    }

    await tryAppend({
      actorAccountId: 'system:recall',
      eventType: EVENT.DRIFT_RECALLED,
      issueId,
      payload: {
        fromStatusId: currentStatusId,
        toStatusId: plan.target,
        transitionId: plan.transitionId,
        driftCount,
        baselineId,
        baselineVersion
      }
    });

    try {
      await clearRecallFindings({ baselineId, baselineVersion, now });
    } catch (e) {
      console.error('collect: could not clear recall findings', e);
    }

    return { ...plan, applied: true };
  } catch (e) {
    // The drift row is already written and is the evidence that matters. A
    // recall that throws must not propagate into the caller and turn a recorded
    // drift into a retried, duplicated one.
    console.error('collect: drift recall threw', issueKey, e);
    return { action: 'ERROR', error: String(e?.message ?? e) };
  }
}
