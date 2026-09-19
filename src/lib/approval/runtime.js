import { FailClosed } from '../errors.js';
import { ELIGIBILITY_PREDICATE, eligibilityParams } from '../eligibility.js';
import { project } from '../content.js';
import { scopeFromIssue } from '../trackedFields.js';
import { baselinePolicy } from '../baselinePolicy.js';
import { baselineDecisionMeaning } from './challenge.js';
import { availableTransitions, exactAvailableTransition, applyTransition } from '../transitions.js';
import { readStableTree } from '../tree/stableRead.js';
import { planTreeCapture } from '../tree/capturePlan.js';
import { createTreeReader } from '../tree/jira.js';

export async function approvalContentHash({ issue, declared, modifiedFields = {}, activeBaseline, readTree }) {
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: {} });
  if (!activeBaseline?.tree_hash) {
    return { fields, contentHash: project({ ...issue.fields, ...modifiedFields }, fields).contentHash };
  }
  if (typeof readTree !== 'function') throw new FailClosed('SERVICE_UNAVAILABLE');
  const rootIssueId = issue.issueId ?? issue.id;
  const stable = await readStableTree({ readTree, rootIssueKey: issue.issueKey ?? issue.key,
    fieldIds: fields.map(field => field.field_id) });
  const nodes = stable.tree.nodes.map(node => String(node.id) === String(rootIssueId)
    ? { ...node, fields: { ...issue.fields, ...node.fields, ...modifiedFields } }
    : node);
  return { fields, contentHash: planTreeCapture({ rootIssueId, nodes, controlledFields: fields }).treeHash };
}

async function shared() {
  const [forge, db, ledger, store, approvals, config, baselines] = await Promise.all([
    import('@forge/api'), import('../db.js'), import('../ledger.js'), import('../../db/store.js'),
    import('../../db/approvalStore.js'), import('../../db/configStore.js'), import('../../db/baselineStore.js')
  ]);
  const api = forge.default?.asUser ? forge.default : forge;
  const query = async (sql, params) => {
    const result = await db.executeQuery(sql, params);
    if (!result.result) throw new FailClosed('SERVICE_UNAVAILABLE');
    return result.data;
  };
  const audit = (event, options) => ledger.append(store.auditStore, { eventId: store.newId(), ...event }, options);
  const eligible = async (scope) => (await query(`SELECT 1 AS ok FROM va_eligibility WHERE ${ELIGIBILITY_PREDICATE} LIMIT 1`, eligibilityParams({ ...scope, state: 'ACTIVE' }))).length > 0;
  return { api, route: forge.route, query, audit, eligible, approvals, config, baselines };
}
function describeIssue(issue) {
  return { ...issue, issueId: Number(issue.id), issueKey: issue.key, projectId: Number(issue.fields.project.id),
    issueTypeId: String(issue.fields.issuetype.id), statusId: String(issue.fields.status.id) };
}
export async function approvalRuntime() {
  const { api, route, audit, eligible, approvals, config } = await shared();
  const [{ readableIssue }, drift] = await Promise.all([import('../../usecases/panelAccess.js'), import('../../usecases/drift.js')]);
  return {
    now: Date.now, audit, eligible,
    issue: async args => describeIssue(await readableIssue(args)),
    actor: async accountId => {
      const response = await api.asUser().requestJira(route`/rest/api/3/myself`);
      if (!response.ok) throw new FailClosed('NOT_ELIGIBLE');
      const user = await response.json();
      if (user.accountId !== accountId || user.active === false || !user.displayName) throw new FailClosed('NOT_ELIGIBLE');
      return { accountId, displayName: user.displayName };
    },
    transition: async (issue, payload) => {
      const transitions = await availableTransitions(api, issue.issueKey).catch(() => {
        throw new FailClosed('SERVICE_UNAVAILABLE');
      });
      const exact = exactAvailableTransition(transitions, payload);
      if (!exact) throw new FailClosed('TRANSITION_UNAVAILABLE');
      return { id: exact.id, toStatusId: exact.toStatusId };
    },
    edge: (issue, transition, prepared) => transition ? config.gatedTransition({ projectId: issue.projectId,
      issueTypeId: issue.issueTypeId, fromStatusId: issue.statusId, toStatusId: transition.toStatusId,
      transitionId: transition.id }) : prepared.gate,
    prepare: drift.prepareApproval, apply: drift.applyApproval,
    record: approvals.recordApproval, activate: approvals.activateApproval,
    invalidate: approvals.invalidateApproval, byId: approvals.approvalById,
    performTransition: async (issue, transition, row) => {
      const response = await applyTransition(api, { issueKey: issue.issueKey, transitionId: transition.id });
      if (!response.ok) {
        const detail = [...(response.messages ?? []), ...Object.values(response.errors ?? {})]
          .filter(Boolean).join(' ');
        return { transitioned: false, transitionError: detail
          ? `Approval recorded. Jira refused the transition: ${detail}`
          : 'Approval recorded. Jira refused the transition. Refresh the work item before signing again.' };
      }
      await audit({ eventType: 'TRANSITION_COMPLETED', actorAccountId: row.account_id, issueId: issue.issueId,
        approvalId: row.approval_id, payload: { transitionId: transition.id, toStatusId: transition.toStatusId } });
      return { transitioned: true };
    }
  };
}

/** No diff/LLM or writes on the hot-path snapshot; fresh Jira content closes trigger lag. */
export async function gateRuntime() {
  const { api, route, query, audit, eligible, approvals, config, baselines } = await shared();
  return {
    now: Date.now, log: data => console.log('gate', JSON.stringify(data)), audit, eligible,
    pending: approvals.pendingApprovalFor, consume: approvals.casConsume, voidOthers: approvals.voidOthers,
    policyForApproval: async ({ approval, issueId }) => {
      const baseline = await baselines.baselineByVersion(issueId, Number(approval.baseline_version));
      if (!baseline || !Buffer.from(baseline.baseline_id).equals(Buffer.from(approval.baseline_id))) {
        throw new FailClosed('BASELINE_POLICY_INCOMPLETE');
      }
      const policy = baselinePolicy(baseline);
      return {
        transition_id: policy.transitionId,
        from_status_id: policy.reviewStatusId,
        to_status_id: policy.destinationStatusId,
        required_role: policy.requiredRole,
        required_assurance: policy.requiredAssurance,
        meaning: baselineDecisionMeaning(approval.decision, policy.version),
        capture_baseline: true,
        block_on_drift: true
      };
    },
    load: async ({ issueKey, fromStatusId, toStatusId, transitionId, approvalId, modifiedFields }) => {
      const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
      if (!response.ok) throw new FailClosed('SERVICE_UNAVAILABLE');
      const issue = describeIssue(await response.json());
      if (issue.statusId !== fromStatusId) throw new FailClosed('STATUS_CHANGED');
      let effectiveTransitionId = transitionId == null ? null : String(transitionId);
      if (!effectiveTransitionId && approvalId) {
        const signedApproval = await approvals.pendingApprovalByToken({
          issueId: issue.issueId, fromStatusId, toStatusId,
          approvalId: Buffer.from(approvalId, 'hex'), now: Date.now()
        });
        if (signedApproval?.transition_id != null) effectiveTransitionId = String(signedApproval.transition_id);
      }
      if (!effectiveTransitionId) {
        const transitions = await availableTransitions(api, issueKey).catch(() => {
          throw new FailClosed('SERVICE_UNAVAILABLE');
        });
        const matches = transitions.filter(candidate => candidate.isAvailable !== false
          && String(candidate.toStatusId) === String(toStatusId));
        // A status pair is only a safe substitute when Jira exposes one and
        // only one outbound transition for it. Sibling transitions fail closed.
        if (matches.length !== 1) throw new FailClosed(matches.length === 0 ? 'NOT_CONFIGURED' : 'SERVICE_UNAVAILABLE');
        effectiveTransitionId = String(matches[0].id);
      }
      const [ct, items, declared, drift, health, active] = await Promise.all([
        config.gatedTransition({ projectId: issue.projectId, issueTypeId: issue.issueTypeId, fromStatusId, toStatusId, transitionId: effectiveTransitionId }),
        query('SELECT state, baseline_version FROM va_item_state WHERE issue_id = ?', [issue.issueId]),
        config.controlledFields({ projectId: issue.projectId, issueTypeId: issue.issueTypeId }),
        query('SELECT COUNT(*) AS count FROM va_drift WHERE issue_id = ? AND approval_id IS NULL', [issue.issueId]),
        config.projectConfig(issue.projectId),
        baselines.activeBaseline(issue.issueId)
      ]);
      const item = items[0] ?? null;
      if (active && item && Number(item.baseline_version) !== Number(active.version)) {
        query('UPDATE va_item_state SET baseline_version = ? WHERE issue_id = ?', [active.version, issue.issueId]).catch(() => {});
        item.baseline_version = active.version;
      }
      const content = await approvalContentHash({ issue, declared, modifiedFields, activeBaseline: active,
        readTree: active?.tree_hash ? createTreeReader({ api, route }).read : null });
      return { ...issue, ct, health, item, transitionId: effectiveTransitionId,
        contentHash: content.contentHash, driftCount: Number(drift[0]?.count) };
    }
  };
}
