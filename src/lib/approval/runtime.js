import { FailClosed } from '../errors.js';
import { ELIGIBILITY_PREDICATE, eligibilityParams } from '../eligibility.js';
import { project } from '../content.js';
import { scopeFromIssue } from '../trackedFields.js';

async function shared() {
  const [forge, db, ledger, store, approvals, config] = await Promise.all([
    import('@forge/api'), import('../db.js'), import('../ledger.js'), import('../../db/store.js'),
    import('../../db/approvalStore.js'), import('../../db/configStore.js')
  ]);
  const api = forge.default?.asUser ? forge.default : forge;
  const query = async (sql, params) => {
    const result = await db.executeQuery(sql, params);
    if (!result.result) throw new FailClosed('SERVICE_UNAVAILABLE');
    return result.data;
  };
  const audit = (event, options) => ledger.append(store.auditStore, { eventId: store.newId(), ...event }, options);
  const eligible = async (scope) => (await query(`SELECT 1 AS ok FROM va_eligibility WHERE ${ELIGIBILITY_PREDICATE} LIMIT 1`, eligibilityParams({ ...scope, state: 'ACTIVE' }))).length > 0;
  return { api, route: forge.route, query, audit, eligible, approvals, config };
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
      const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issue.issueKey}/transitions`);
      if (!response.ok) throw new FailClosed('SERVICE_UNAVAILABLE');
      const matches = (await response.json()).transitions.filter(t => payload.transitionId != null ? String(t.id) === String(payload.transitionId) : String(t.to?.id) === String(payload.toStatusId));
      if (matches.length !== 1) throw new FailClosed('NOT_CONFIGURED');
      return { id: String(matches[0].id), toStatusId: String(matches[0].to.id) };
    },
    edge: (issue, transition, prepared) => transition ? config.gatedTransition({ projectId: issue.projectId,
      issueTypeId: issue.issueTypeId, fromStatusId: issue.statusId, toStatusId: transition.toStatusId,
      transitionId: transition.id }) : prepared.gate,
    prepare: drift.prepareApproval, apply: drift.applyApproval,
    record: approvals.recordApproval, activate: approvals.activateApproval, byId: approvals.approvalById,
    performTransition: async (issue, transition, row) => {
      const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issue.issueKey}/transitions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transition: { id: transition.id } })
      });
      if (!response.ok) return { transitioned: false, transitionError: 'Approval recorded. Jira refused the transition. Refresh the work item before retrying.' };
      await audit({ eventType: 'TRANSITION_COMPLETED', actorAccountId: row.account_id, issueId: issue.issueId,
        approvalId: row.approval_id, payload: { transitionId: transition.id, toStatusId: transition.toStatusId } });
      return { transitioned: true };
    }
  };
}

/** No diff/LLM or writes on the hot-path snapshot; fresh Jira content closes trigger lag. */
export async function gateRuntime() {
  const { api, route, query, audit, eligible, approvals, config } = await shared();
  return {
    now: Date.now, log: data => console.log('gate', JSON.stringify(data)), audit, eligible,
    pending: approvals.pendingApprovalFor, consume: approvals.casConsume, voidOthers: approvals.voidOthers,
    load: async ({ issueKey, fromStatusId, toStatusId, transitionId, modifiedFields }) => {
      const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
      if (!response.ok) throw new FailClosed('SERVICE_UNAVAILABLE');
      const issue = describeIssue(await response.json());
      if (issue.statusId !== fromStatusId) throw new FailClosed('CONTENT_CHANGED');
      const [ct, items, declared, drift] = await Promise.all([
        config.gatedTransition({ projectId: issue.projectId, issueTypeId: issue.issueTypeId, fromStatusId, toStatusId, transitionId }),
        query('SELECT state, baseline_version FROM va_item_state WHERE issue_id = ?', [issue.issueId]),
        config.controlledFields({ projectId: issue.projectId, issueTypeId: issue.issueTypeId }),
        query('SELECT COUNT(*) AS count FROM va_drift WHERE issue_id = ? AND approval_id IS NULL', [issue.issueId])
      ]);
      const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: {} });
      const projected = project({ ...issue.fields, ...modifiedFields }, fields);
      return { ...issue, ct, item: items[0] ?? null, contentHash: projected.contentHash, driftCount: Number(drift[0]?.count) };
    }
  };
}
