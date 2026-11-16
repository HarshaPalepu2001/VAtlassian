import { executeQuery } from '../lib/db.js';
import { FailClosed } from '../lib/errors.js';

const requestId = value => { if (!/^[0-9a-f]{32}$/.test(String(value ?? ''))) throw new FailClosed('PLAN_EXECUTION_RECORD_INVALID'); return String(value); };
async function q(sql, params) {
  const result = await executeQuery(sql, params);
  if (!result.result) throw Object.assign(new FailClosed('SERVICE_UNAVAILABLE'), { cause: result.error });
  return result.data ?? [];
}
const duplicate = error => (error?.code ?? error?.context?.debug?.code) === 'ER_DUP_ENTRY' || /duplicate entry/i.test(error?.message ?? '');
function from(row) {
  if (!row) return null;
  return { requestId: String(row.request_id), projectId: String(row.project_id), planIssueId: String(row.plan_issue_id),
    parentIssueId: String(row.parent_issue_id), actorAccountId: row.actor_account_id, revisionId: String(row.revision_id),
    fingerprint: row.fingerprint, marker: row.marker, state: row.state,
    executionIssueId: row.execution_issue_id == null ? null : String(row.execution_issue_id), executionKey: row.execution_key ?? null,
    lastError: row.last_error ?? null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

export async function insertPlanExecutionIntent(intent) {
  try {
    await q(`INSERT INTO tm_plan_execution_intent (request_id, project_id, plan_issue_id, parent_issue_id, actor_account_id,
      revision_id, fingerprint, marker, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', ?, ?)`,
    [requestId(intent.requestId), Number(intent.projectId), Number(intent.planIssueId), Number(intent.parentIssueId),
      intent.actorAccountId, requestId(intent.revisionId), intent.fingerprint, intent.marker, intent.createdAt, intent.updatedAt]);
    return true;
  } catch (error) { if (duplicate(error.cause)) return false; throw error; }
}

export async function readPlanExecutionIntent(id) {
  return from((await q('SELECT * FROM tm_plan_execution_intent WHERE request_id = ?', [requestId(id)]))[0]);
}

export async function readPendingPlanExecutionIntent({ projectId, planIssueId, actorAccountId, revisionId }) {
  return from((await q(`SELECT * FROM tm_plan_execution_intent WHERE project_id = ? AND plan_issue_id = ?
    AND actor_account_id = ? AND revision_id = ? AND (state = 'CREATING' OR (state = 'NEEDS_REPAIR' AND last_error = 'CREATE_IDENTITY_UNPROVEN'))
    ORDER BY created_at DESC LIMIT 1`, [Number(projectId), Number(planIssueId), actorAccountId, requestId(revisionId)]))[0]);
}

const states = new Set(['CREATING', 'READY', 'NEEDS_REPAIR']);
export async function transitionPlanExecutionIntent(id, { from: expected, to, executionIssueId = null, executionKey = null, lastError = null, now }) {
  if (!states.has(expected) || !states.has(to)) throw new FailClosed('PLAN_EXECUTION_RECORD_INVALID');
  const result = await q(`UPDATE tm_plan_execution_intent SET state = ?, execution_issue_id = COALESCE(?, execution_issue_id),
    execution_key = COALESCE(?, execution_key), last_error = ?, updated_at = ? WHERE request_id = ? AND state = ?`,
  [to, executionIssueId == null ? null : Number(executionIssueId), executionKey, lastError, now, requestId(id), expected]);
  return Number(result.affectedRows ?? 0) === 1;
}
