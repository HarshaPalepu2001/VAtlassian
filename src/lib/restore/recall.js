import api from '@forge/api';
import { availableTransitions, applyTransition } from '../transitions.js';
import { recallPlan, RECALL } from '../recall.js';
import { tryAppend } from '../../db/store.js';
import { recordRecallFinding, clearRecallFindings } from '../../db/incidentStore.js';
import { EVENT } from '../ledger.js';

/**
 * Record why an automatic recall did not happen: loud in the ledger (this
 * work item's own history) and, separately, as a deduplicated administrator
 * finding (db/incidentStore.js's recordRecallFinding) that carries the
 * diagnostic detail — offered transition ids, the screen fact, Jira's own
 * response — an ordinary reviewer does not need and an administrator does.
 *
 * Exported so collect.js can report the one failure that happens before a
 * route is even attempted: an active baseline whose provenance is incomplete,
 * which never reaches recallToReview because there is no reviewStatusId to
 * plan against.
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
 * Put a drifted work item back in front of a reviewer.
 *
 * The route decision is lib/recall.js's; this performs it and records what
 * happened. THE TARGET IS BASELINE-OWNED: `reviewStatusId`, `baselineId`, and
 * `baselineVersion` all come from the caller's `baselinePolicy(activeBaseline)`
 * (see lib/baselinePolicy.js) — this function never reads configuration to
 * find a review status, and never falls back to one if the baseline's own
 * value is missing. See lib/recall.js for why an item that drifted while
 * already in review is left alone, why more than one Jira route to that
 * status is refused rather than guessed at, and why a workflow with no route
 * back fails loudly rather than improvising one.
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
