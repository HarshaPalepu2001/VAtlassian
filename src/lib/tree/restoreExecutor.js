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

export async function executeTreeRestore({
  restoreId, rootIssueKey, baselineTree, currentTree, controlledFields, adapters,
  maxActions = 25, plan: persistedPlan = null
}) {
  if (!Number.isSafeInteger(maxActions) || maxActions <= 0) throw new TypeError('maxActions must be a positive safe integer');
  const plan = persistedPlan ?? planTreeRestore({ baselineTree, currentTree, controlledFields });

  let preflightOk = false;
  try {
    preflightOk = await adapters.checkPermissions({ ...plan, rootIssueKey, baselineTree, currentTree });
  } catch {
    preflightOk = false;
  }
  if (preflightOk !== true) {
    return { state: 'FAILED', attempted: 0, completed: 0, remaining: plan.steps.length, replacements: [] };
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
  for (const step of plan.steps) {
    if (completedKeys.has(step.stepKey)) continue;
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
          await adapters.editIssue(target, regularFields);
        }
        if (legacyLinks !== undefined) {
          if (typeof adapters.restoreLinks !== 'function') throw new Error('Link restore adapter is unavailable');
          await adapters.restoreLinks(target, legacyLinks);
        }
      } else if (step.kind === 'RESTORE_LINKS') {
        if (target == null) throw new Error('Link restore target is unavailable');
        await adapters.restoreLinks(target, step.links ?? []);
      } else if (step.kind === 'DELETE_ADDED_NODE') {
        if (target == null) throw new Error('Delete target is unavailable');
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
      await adapters.finishRestoreAction(restoreId, step.stepKey, false, errorDetail(error), { now: Date.now() });
      stopped = true;
      break;
    }
  }

  replacements = await adapters.readReplacements(restoreId);
  const completed = plan.steps.filter(step => completedKeys.has(step.stepKey)).length;
  const remaining = plan.steps.length - completed;
  return {
    state: remaining === 0 ? 'READY_TO_VERIFY' : 'PARTIAL',
    attempted,
    completed,
    remaining,
    replacements,
    stopped
  };
}
