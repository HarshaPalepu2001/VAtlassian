import api from '@forge/api';
import { recallTargetStatus } from '../../db/configStore.js';
import { availableTransitions, applyTransition } from '../transitions.js';
import { recallPlan, RECALL } from '../recall.js';
import { tryAppend } from '../../db/store.js';
import { EVENT } from '../ledger.js';

export async function recallToReview({
  issueId, issueKey, projectId, issueTypeId,
  currentStatusId, reviewStatuses, driftCount, baselineVersion, now
}) {
  try {
    // Cheap checks before the round trips. An item that drifted while sitting in
    // review is the common case on a busy project, and it must not cost two REST
    // calls to conclude there is nothing to do.
    const preflight = recallPlan({
      currentStatusId, reviewStatusIds: reviewStatuses,
      gateFromStatusId: null, transitions: [], driftCount
    });
    if (preflight.action === RECALL.NO_DRIFT || preflight.action === RECALL.ALREADY_IN_REVIEW) {
      return preflight;
    }

    const target = await recallTargetStatus({ projectId, issueTypeId });
    if (!target) return { action: RECALL.NOT_GATED };

    // asApp: this runs from a trigger or the sweep, where there is no user to
    // act as, and the move is genuinely the app's own. See transitions.js.
    const transitions = await availableTransitions(api, issueKey, { asApp: true });
    const plan = recallPlan({
      currentStatusId, reviewStatusIds: reviewStatuses,
      gateFromStatusId: target, transitions, driftCount
    });

    if (plan.action !== RECALL.RECALL) {
      if (plan.action === RECALL.NO_ROUTE) {
        // LOUD. The item is now knowingly outside review with undecided drift,
        // and no amount of retrying will fix a workflow that has no edge back.
        // Somebody has to add one.
        console.error('collect: drift recall has no route back to review', JSON.stringify({
          issueKey, issueId, projectId, currentStatusId, target,
          offered: transitions.map((t) => `${t.name}→${t.toStatusId}`)
        }));
        await tryAppend({
          actorAccountId: 'system:recall',
          eventType: EVENT.DRIFT_RECALL_FAILED,
          issueId,
          payload: { reason: 'NO_ROUTE', currentStatusId, target, driftCount, baselineVersion }
        });
      }
      return plan;
    }

    const res = await applyTransition(api, {
      issueKey, transitionId: plan.transitionId, fields: {}, asApp: true
    });

    if (!res.ok) {
      // Most often a transition screen with a required field, which a job
      // cannot fill. Recorded with Jira's own reason so the workflow can be
      // fixed rather than the failure being blamed on drift detection.
      console.error('collect: drift recall refused by Jira', JSON.stringify({
        issueKey, issueId, target, transitionId: plan.transitionId,
        hasScreen: plan.hasScreen, status: res.status, messages: res.messages
      }));
      await tryAppend({
        actorAccountId: 'system:recall',
        eventType: EVENT.DRIFT_RECALL_FAILED,
        issueId,
        payload: {
          reason: 'JIRA_REFUSED', currentStatusId, target, driftCount,
          baselineVersion, hasScreen: plan.hasScreen, messages: res.messages ?? null
        }
      });
      return { ...plan, applied: false };
    }

    await tryAppend({
      actorAccountId: 'system:recall',
      eventType: EVENT.DRIFT_RECALLED,
      issueId,
      payload: {
        fromStatusId: currentStatusId,
        toStatusId: target,
        transitionId: plan.transitionId,
        driftCount,
        baselineVersion
      }
    });

    return { ...plan, applied: true };
  } catch (e) {
    // The drift row is already written and is the evidence that matters. A
    // recall that throws must not propagate into the caller and turn a recorded
    // drift into a retried, duplicated one.
    console.error('collect: drift recall threw', issueKey, e);
    return { action: 'ERROR', error: String(e?.message ?? e) };
  }
}

