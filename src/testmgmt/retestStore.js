import { executeQuery } from '../lib/db.js';
import { FailClosed } from '../lib/errors.js';

const id = value => { if (!/^[0-9a-f]{32}$/.test(String(value ?? ''))) throw new FailClosed('NOT_FOUND'); return String(value); };
const duplicate = error => (error?.code ?? error?.context?.debug?.code) === 'ER_DUP_ENTRY' || /duplicate entry/i.test(error?.message ?? '');
async function q(sql, params) {
  const result = await executeQuery(sql, params);
  if (!result.result) throw Object.assign(new FailClosed('SERVICE_UNAVAILABLE'), { cause: result.error });
  return result.data ?? [];
}
function decode(value) {
  try { return JSON.parse(value); } catch { throw new FailClosed('RETEST_RECORD_INVALID'); }
}

function intentFrom(row) {
  if (!row) return null;
  const snapshot = decode(row.snapshot);
  if (!Array.isArray(snapshot?.runs)) throw new FailClosed('RETEST_RECORD_INVALID');
  return { requestId: String(row.request_id), projectId: String(row.project_id), sourceExecutionIssueId: String(row.source_execution_issue_id),
    sourceExecutionKey: row.source_execution_key, parentIssueId: String(row.parent_issue_id), actorAccountId: row.actor_account_id,
    fingerprint: row.fingerprint, marker: row.marker, snapshot, state: row.state,
    executionIssueId: row.execution_issue_id == null ? null : String(row.execution_issue_id), executionKey: row.execution_key ?? null,
    lastError: row.last_error ?? null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

export async function insertRetestIntent(intent) {
  try {
    await q(`INSERT INTO tm_retest_intent (request_id, project_id, source_execution_issue_id, source_execution_key,
      parent_issue_id, actor_account_id, fingerprint, marker, snapshot, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?)`,
    [id(intent.requestId), Number(intent.projectId), Number(intent.sourceExecutionIssueId), intent.sourceExecutionKey,
      Number(intent.parentIssueId), intent.actorAccountId, intent.fingerprint, intent.marker, JSON.stringify(intent.snapshot), intent.createdAt, intent.updatedAt]);
    return true;
  } catch (error) { if (duplicate(error.cause)) return false; throw error; }
}

export async function readRetestIntent(requestId) {
  return intentFrom((await q('SELECT * FROM tm_retest_intent WHERE request_id = ?', [id(requestId)]))[0]);
}

const states = new Set(['PREPARING', 'PREPARED', 'CREATING', 'ADDING_RUNS', 'COMPLETE', 'NEEDS_REPAIR']);
export async function transitionRetestIntent(requestId, { from, to, executionIssueId = null, executionKey = null, lastError = null, now }) {
  if (!states.has(from) || !states.has(to)) throw new FailClosed('RETEST_RECORD_INVALID');
  const result = await q(`UPDATE tm_retest_intent SET state = ?, execution_issue_id = COALESCE(?, execution_issue_id),
    execution_key = COALESCE(?, execution_key), last_error = ?, updated_at = ? WHERE request_id = ? AND state = ?`,
  [to, executionIssueId == null ? null : Number(executionIssueId), executionKey, lastError, now, id(requestId), from]);
  return Number(result.affectedRows ?? 0) === 1;
}

export async function listRetestRunLinks(requestId) {
  return (await q('SELECT source_run_id, target_run_id FROM tm_retest_run WHERE request_id = ? ORDER BY source_run_id', [id(requestId)]))
    .map(row => ({ sourceRunId: String(row.source_run_id), targetRunId: String(row.target_run_id) }));
}

export async function insertRetestRunLink({ requestId, sourceRunId, targetRunId, now }) {
  try {
    await q('INSERT INTO tm_retest_run (request_id, source_run_id, target_run_id, created_at) VALUES (?, ?, ?, ?)',
      [id(requestId), id(sourceRunId), id(targetRunId), now]);
    return true;
  } catch (error) {
    if (!duplicate(error.cause)) throw error;
    const rows = await q('SELECT target_run_id FROM tm_retest_run WHERE request_id = ? AND source_run_id = ?', [id(requestId), id(sourceRunId)]);
    if (rows.length === 1 && String(rows[0].target_run_id) === targetRunId) return true;
    throw new FailClosed('RETEST_RECORD_INVALID');
  }
}

/** Resolve interrupted audit writes by their stable event id, preserving attribution. */
export async function readRetestAuditEvent(eventId) {
  const row = (await q(`SELECT seq, entry_hash, event_type, actor_account_id, issue_id, payload
    FROM va_audit WHERE event_id = FROM_BASE64(?)`, [Buffer.from(id(eventId), 'hex').toString('base64')]))[0];
  return row ? { seq: Number(row.seq), entryHash: row.entry_hash, eventType: row.event_type,
    actorAccountId: row.actor_account_id, issueId: row.issue_id == null ? null : Number(row.issue_id), payload: decode(row.payload) } : null;
}
