import { planTreeRestore } from './restorePlan.js';

function nodeIdentity(node) {
  return {
    issueId: node?.currentIssueId ?? node?.id ?? node?.originalIssueId ?? null,
    issueKey: node?.issueKey ?? node?.key ?? null
  };
}

function errorDetail(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    status: error?.status ?? null,
    operation: error?.operation ?? null,
    detail: error?.detail ?? error?.message ?? String(error)
  };
}

/**
 * Is this failure about the WHOLE restore, or only about this one step?
 *
 * ─── WHY THE DIFFERENCE DECIDES EVERYTHING ───────────────────────────────────
 *
 * This loop used to `break` on any error. One field Jira would not accept
 * therefore threw away every step after it — including writes to completely
 * unrelated work items — and the restore came back with `remaining > 0`. The
 * worker requeued it, the same step failed again, the no-progress guard fired,
 * and the item was left in ERROR, where the workflow gate denies every
 * transition. A single refused field could freeze a whole hierarchy.
 *
 * So the two cases are separated. A SYSTEMIC failure — no response at all, an
 * authentication or authorisation failure, a rate limit, a Jira 5xx — says
 * nothing about this step in particular and everything about whether the next
 * one can succeed. Stopping is right: the batch is requeued and tried again.
 *
 * Anything else is Jira REFUSING this specific action: a field that is not on
 * any screen, a value its validator rejects, an issue type that will not take
 * the change. Retrying cannot help, and it is not a reason to abandon the rest
 * of the tree. The step is settled, named with Jira's own words, and the
 * restore carries on — which is what the single-issue planner has always done
 * by naming `cannotRestore` up front instead of failing mid-write.
 *
 * Unknown shapes count as systemic. "We could not tell" must not silently
 * settle a step as un-restorable; a retry that turns out to be pointless is
 * cheap, and the worker's no-progress guard stops the loop.
 *
 * 404 counts as systemic, which looks surprising until you read the
 * DELETE_ADDED_NODE branch below: "not found" is not Jira refusing the action,
 * it is Jira reporting a state we did not expect, and the SECOND attempt at the
 * same step is what tells us whether we caused it ourselves. Settling it on the
 * first attempt would remove the only evidence that distinction rests on.
 */
const SYSTEMIC_STATUSES = new Set([401, 403, 404, 408, 425, 429]);

export function isSystemicFailure(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if (!Number.isFinite(status) || status === 0) return true;
  return status >= 500 || SYSTEMIC_STATUSES.has(status);
}

export async function executeTreeRestore({
  restoreId, rootIssueKey, baselineTree, currentTree, controlledFields, fieldsFor, adapters,
  maxActions = 25, plan: persistedPlan = null
}) {
  if (!Number.isSafeInteger(maxActions) || maxActions <= 0) throw new TypeError('maxActions must be a positive safe integer');
  const plan = persistedPlan ?? planTreeRestore({ baselineTree, currentTree, controlledFields, fieldsFor });

  let preflightOk = false;
  try {
    preflightOk = await adapters.checkPermissions({ ...plan, rootIssueKey, baselineTree, currentTree });
  } catch {
    preflightOk = false;
  }
  if (preflightOk !== true) {
    // Nothing was attempted and nothing can be, so this is terminal rather than
    // "partly done". Reported as stopped so the worker settles it instead of
    // handing an empty batch back to the queue for ever.
    return { state: 'FAILED', attempted: 0, completed: 0, remaining: plan.steps.length,
      refused: [], replacements: [], stopped: true, preflightFailed: true };
  }

  if (adapters.appendLedger) {
    await adapters.appendLedger('TREE_RESTORE_PLAN_CREATED', {
      restoreId,
      plan: plan.steps.map(step => ({ stepKey: step.stepKey, kind: step.kind, logicalNodeId: step.logicalNodeId }))
    });
  }

  const existingActions = await adapters.readRestoreActions(restoreId);
  const existingByKey = new Map(existingActions.map(action => [action.stepKey, action]));
  const completedKeys = new Set(existingActions.filter(action => action.state === 'COMPLETE').map(action => action.stepKey));
  // Refusals are durable and settled: a requeue must not attempt them again,
  // or `remaining` never reaches zero and the restore never gets to verify the
  // work it DID do. A reviewer's explicit retry clears them (see
  // clearRefusedRestoreActions) so a corrected field configuration is retried.
  const refused = existingActions
    .filter(action => action.state === 'FAILED' && action.detail?.refused === true)
    .map(action => ({ stepKey: action.stepKey, logicalNodeId: action.logicalNodeId,
      kind: action.kind, issueKey: action.issueKey ?? null, error: action.detail }));
  const refusedKeys = new Set(refused.map(entry => entry.stepKey));
  let replacements = await adapters.readReplacements(restoreId);
  const replacementsByLogical = new Map(replacements.map(replacement => [String(replacement.logicalNodeId), replacement]));

  const logicalToReal = new Map();
  for (const node of baselineTree?.nodes ?? []) {
    const identity = nodeIdentity(node);
    const real = identity.issueKey ?? identity.issueId;
    if (real != null) logicalToReal.set(String(node.logicalNodeId), real);
  }
  for (const node of currentTree?.nodes ?? []) {
    const identity = nodeIdentity(node);
    const real = identity.issueKey ?? identity.issueId;
    if (real != null) logicalToReal.set(String(node.logicalNodeId), real);
  }
  for (const replacement of replacements) {
    logicalToReal.set(String(replacement.logicalNodeId), replacement.newIssueKey ?? replacement.newIssueId);
  }

  let attempted = 0;
  let stopped = false;
  // A node whose replacement Jira refused has no identity to act on, so every
  // step that targets it — or that would hang a child under it — is settled as
  // refused too rather than attempted and failed one by one.
  const unavailable = new Set(refused.filter(entry => entry.kind === 'CREATE_REPLACEMENT')
    .map(entry => String(entry.logicalNodeId)));

  const settleRefusal = async (step, error) => {
    await adapters.finishRestoreAction(restoreId, step.stepKey, false,
      { ...errorDetail(error), refused: true }, { now: Date.now() });
    const entry = { stepKey: step.stepKey, logicalNodeId: step.logicalNodeId, kind: step.kind,
      issueKey: logicalToReal.get(step.logicalNodeId) ?? null, error: errorDetail(error) };
    refused.push(entry);
    refusedKeys.add(step.stepKey);
    if (step.kind === 'CREATE_REPLACEMENT') unavailable.add(String(step.logicalNodeId));
  };

  for (const step of plan.steps) {
    if (completedKeys.has(step.stepKey) || refusedKeys.has(step.stepKey)) continue;
    if (unavailable.has(String(step.logicalNodeId))
        || (step.parentLogicalNodeId != null && unavailable.has(String(step.parentLogicalNodeId)))) {
      await settleRefusal(step, { name: 'DependencyRefused', status: 409,
        detail: 'The work item this step depends on could not be recreated, so this step cannot be applied.' });
      continue;
    }
    if (attempted >= maxActions) break;

    const target = logicalToReal.get(step.logicalNodeId) ?? (step.parentLogicalNodeId == null ? rootIssueKey : null);
    const baselineNode = (baselineTree?.nodes ?? []).find(node => String(node.logicalNodeId) === step.logicalNodeId);
    const currentNode = (currentTree?.nodes ?? []).find(node => String(node.logicalNodeId) === step.logicalNodeId);
    const identity = nodeIdentity(currentNode ?? baselineNode);
    const claimed = await adapters.claimRestoreAction(restoreId, step, {
      issueId: identity.issueId,
      issueKey: identity.issueKey,
      now: Date.now()
    });
    if (!claimed) {
      stopped = true;
      break;
    }
    attempted += 1;
    if (adapters.appendLedger) {
      await adapters.appendLedger('TREE_RESTORE_STEP_CLAIMED', {
        restoreId, stepKey: step.stepKey, step: step.kind, node: step.logicalNodeId
      });
    }

    try {
      if (step.kind === 'CREATE_REPLACEMENT') {
        const alreadyRecorded = replacementsByLogical.get(step.logicalNodeId);
        if (alreadyRecorded) {
          logicalToReal.set(step.logicalNodeId, alreadyRecorded.newIssueKey ?? alreadyRecorded.newIssueId);
        } else {
          const parentKey = step.parentLogicalNodeId == null ? null : logicalToReal.get(step.parentLogicalNodeId);
          if (step.parentLogicalNodeId != null && parentKey == null) throw new Error('Replacement parent is unavailable');
          const created = await adapters.createIssue(parentKey, baselineNode, baselineTree.values?.[step.logicalNodeId] ?? {});
          if (!created?.newIssueId || !created?.newIssueKey) throw new Error('Jira did not return the replacement identity');
          await adapters.recordReplacement(
            restoreId, step.logicalNodeId,
            baselineNode?.originalIssueId ?? baselineNode?.id,
            created.newIssueId,
            created.newIssueKey
          );
          const replacement = { logicalNodeId: step.logicalNodeId,
            oldIssueId: baselineNode?.originalIssueId ?? baselineNode?.id,
            newIssueId: created.newIssueId, newIssueKey: created.newIssueKey };
          replacementsByLogical.set(step.logicalNodeId, replacement);
          logicalToReal.set(step.logicalNodeId, created.newIssueKey);
          if (adapters.appendLedger) {
            await adapters.appendLedger('TREE_RESTORE_REPLACEMENT_RECORDED', {
              restoreId, node: step.logicalNodeId, newIssueId: created.newIssueId
            });
          }
        }
      } else if (step.kind === 'MOVE_NODE') {
        const parentKey = step.parentLogicalNodeId == null ? null : logicalToReal.get(step.parentLogicalNodeId);
        if (target == null || (step.parentLogicalNodeId != null && parentKey == null)) throw new Error('Move target is unavailable');
        await adapters.moveIssue(target, parentKey);
      } else if (step.kind === 'RESTORE_FIELDS') {
        if (target == null) throw new Error('Field restore target is unavailable');
        // Compatibility for plans persisted before links became their own
        // action.  Jira does not restore issue links through the ordinary
        // issue-field PUT, so split the legacy step at execution time.
        const legacyLinks = step.fields?.issuelinks;
        const regularFields = { ...(step.fields ?? {}) };
        delete regularFields.issuelinks;
        if (Object.keys(regularFields).length > 0) {
          // Rich text points at the files the item has now: the originals where
          // they survive, the restored copies where they did not.
          const liveIssueId = replacementsByLogical.get(step.logicalNodeId)?.newIssueId ?? identity.issueId;
          await adapters.editIssue(target, typeof adapters.pointAtLiveFiles === 'function'
            ? await adapters.pointAtLiveFiles(liveIssueId, regularFields) : regularFields);
        }
        if (legacyLinks !== undefined) {
          if (typeof adapters.restoreLinks !== 'function') throw new Error('Link restore adapter is unavailable');
          await adapters.restoreLinks(target, legacyLinks);
        }
      } else if (step.kind === 'RESTORE_LINKS') {
        if (target == null) throw new Error('Link restore target is unavailable');
        await adapters.restoreLinks(target, step.links ?? []);
      } else if (step.kind === 'RESTORE_ATTACHMENTS') {
        if (target == null) throw new Error('Attachment restore target is unavailable');
        if (typeof adapters.restoreAttachments !== 'function') throw new Error('Attachment restore adapter is unavailable');
        // A recreated work item has a new id, and its restored files are
        // recorded against it; the vaulted copies are still filed under the
        // original item.
        const replacement = replacementsByLogical.get(step.logicalNodeId);
        await adapters.restoreAttachments({ issueKey: String(target),
          issueId: replacement?.newIssueId ?? identity.issueId,
          sourceIssueId: baselineNode?.originalIssueId ?? baselineNode?.currentIssueId ?? identity.issueId,
          target: step.attachments ?? [] });
      } else if (step.kind === 'DELETE_ADDED_NODE') {
        if (target == null) throw new Error('Delete target is unavailable');
        // ── EVIDENCE BEFORE DESTRUCTION ────────────────────────────────────
        //
        // This is the only irreversible thing a restore does. A subtask added
        // after approval has to go — it cannot exist apart from its parent, so
        // detaching it the way a link is detached is not available and leaving
        // it means the hierarchy was not returned to its approved shape. But
        // the DELETE takes a Jira record with it: its changelog, its comments,
        // and the trail of who created it.
        //
        // 21 CFR Part 11 §11.10(e) requires the audit trail to record actions
        // that create, modify OR DELETE electronic records, and that record
        // changes "shall not obscure previously recorded information". So the
        // item's controlled content is written into the hash-chained ledger
        // FIRST, and the delete only happens if that write succeeded. If the
        // ledger is unavailable the work item survives — losing the audit trail
        // is a reason to keep a record, never a reason to destroy it quietly.
        if (typeof adapters.appendLedger !== 'function') {
          throw new Error('No audit ledger is available, so this work item cannot be deleted.');
        }
        await adapters.appendLedger('TREE_RESTORE_NODE_DESTROYED', {
          restoreId,
          logicalNodeId: step.logicalNodeId,
          issueId: currentNode?.currentIssueId ?? currentNode?.originalIssueId ?? identity.issueId ?? null,
          issueKey: currentNode?.issueKey ?? identity.issueKey ?? String(target),
          parentLogicalNodeId: step.parentLogicalNodeId ?? null,
          contentHash: currentNode?.contentHash ?? null,
          // The content itself, not only its digest: a hash can prove nothing
          // was tampered with, but it cannot show an auditor what was removed.
          values: currentTree?.values?.[step.logicalNodeId] ?? {}
        });
        try {
          await adapters.deleteIssue(target);
        } catch (error) {
          const wasPreviouslyClaimed = existingByKey.has(step.stepKey);
          if (!(error?.status === 404 && wasPreviouslyClaimed)) throw error;
        }
      }
      const finished = await adapters.finishRestoreAction(restoreId, step.stepKey, true, null, { now: Date.now() });
      if (finished !== true) throw new Error('Restore action completion was not durable');
      completedKeys.add(step.stepKey);
    } catch (error) {
      if (isSystemicFailure(error)) {
        await adapters.finishRestoreAction(restoreId, step.stepKey, false, errorDetail(error), { now: Date.now() });
        stopped = true;
        break;
      }
      await settleRefusal(step, error);
    }
  }

  replacements = await adapters.readReplacements(restoreId);
  const completed = plan.steps.filter(step => completedKeys.has(step.stepKey)).length;
  const settled = plan.steps.filter(step => refusedKeys.has(step.stepKey)).length;
  const remaining = plan.steps.length - completed - settled;
  return {
    // A batch with nothing outstanding is ready to be checked against Jira,
    // even when some of it was refused: the verification read is what decides
    // whether the tracked projection matches, and it has to run before anyone
    // is told what this restore achieved.
    state: remaining === 0 ? 'READY_TO_VERIFY' : 'PARTIAL',
    attempted,
    completed,
    remaining,
    refused,
    replacements,
    stopped
  };
}
