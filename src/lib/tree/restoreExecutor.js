import { planTreeRestore } from './restorePlan.js';

export async function executeTreeRestore({
  restoreId, rootIssueKey, baselineTree, currentTree, controlledFields,
  adapters
}) {
  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });

  // Preflight
  const preflightOk = await adapters.checkPermissions(plan);
  if (!preflightOk) {
    return { state: 'FAILED' };
  }

  if (adapters.appendLedger) {
    await adapters.appendLedger('TREE_RESTORE_PLAN_CREATED', { restoreId, plan: plan.steps.map(s => ({ kind: s.kind, id: s.logicalNodeId })) });
  }

  if (plan.steps.length === 0) {
    return { state: 'COMPLETE' };
  }

  // Check previously claimed/completed steps
  const stepsRecord = await adapters.readRestoreSteps(restoreId);
  const completedSteps = new Set(stepsRecord.filter(s => s.success).map(s => s.logicalNodeId));
  const claimedSteps = new Set(stepsRecord.map(s => s.logicalNodeId));

  let state = 'COMPLETE';
  let hasReplacements = false;

  const logicalToReal = new Map();
  if (baselineTree && baselineTree.nodes) {
    for (const n of baselineTree.nodes) logicalToReal.set(n.logicalNodeId, n.key || n.id);
  }
  if (currentTree && currentTree.nodes) {
    for (const n of currentTree.nodes) logicalToReal.set(n.logicalNodeId, n.key || n.id);
  }

  const reps = await adapters.readReplacements(restoreId);
  for (const r of reps) {
    logicalToReal.set(r.logicalNodeId, r.newIssueId);
  }

  for (const step of plan.steps) {
    if (completedSteps.has(step.logicalNodeId)) {
      if (step.kind === 'CREATE_REPLACEMENT') hasReplacements = true;
      continue;
    }

    let issueIdOrKey = logicalToReal.get(step.logicalNodeId) || rootIssueKey;

    // Claim step only if not already claimed (e.g. from a prior crash)
    if (!claimedSteps.has(step.logicalNodeId)) {
      try {
        await adapters.claimRestoreStep(restoreId, step.logicalNodeId, issueIdOrKey);
        if (adapters.appendLedger) await adapters.appendLedger('TREE_RESTORE_STEP_CLAIMED', { restoreId, step: step.kind, node: step.logicalNodeId });
      } catch (e) {
        // Idempotency: if duplicate key, another process claimed it. For simplicity we proceed.
      }
    }

    let ok = false;
    let detail = null;
    try {
      if (step.kind === 'CREATE_REPLACEMENT') {
        const baselineNode = baselineTree.nodes.find(n => n.logicalNodeId === step.logicalNodeId);
        const parentKey = logicalToReal.get(baselineNode.parentLogicalId || baselineNode.parent);
        const { newIssueId, newIssueKey } = await adapters.createIssue(parentKey, baselineNode);
        await adapters.recordReplacement(restoreId, step.logicalNodeId, baselineNode.id || baselineNode.key, newIssueId || newIssueKey);
        logicalToReal.set(step.logicalNodeId, newIssueKey || newIssueId);
        if (adapters.appendLedger) await adapters.appendLedger('TREE_RESTORE_REPLACEMENT_RECORDED', { restoreId, node: step.logicalNodeId });
        ok = true;
        hasReplacements = true;
      } else if (step.kind === 'MOVE_NODE') {
        const parentKey = logicalToReal.get(step.parent);
        ok = await adapters.moveIssue(issueIdOrKey, parentKey);
      } else if (step.kind === 'RESTORE_FIELDS') {
        ok = await adapters.editIssue(issueIdOrKey, step.fields);
      } else if (step.kind === 'DELETE_ADDED_NODE') {
        const delRes = await adapters.deleteIssue(issueIdOrKey);
        if (delRes === true) {
          ok = true;
        } else if (delRes === '404' && claimedSteps.has(step.logicalNodeId)) {
          // Treat 404 as success ONLY if target was proven added for this baseline AND step had already been claimed.
          ok = true;
        }
      }
    } catch (e) {
      ok = false;
      detail = String(e);
    }

    await adapters.finishRestoreStep(restoreId, step.logicalNodeId, ok, detail);

    if (!ok) {
      state = 'PARTIAL';
      break;
    }
  }

  if (state === 'COMPLETE') {
    if (hasReplacements || reps.length > 0) {
      state = 'COMPLETE_WITH_REPLACEMENTS';
    }
  }

  return { state, replacements: reps };
}
