import { executeQuery } from '../lib/db.js';
import { FailClosed } from '../lib/errors.js';

async function query(sql, params) {
  const result = await executeQuery(sql, params);
  if (!result.result) throw Object.assign(new FailClosed('SERVICE_UNAVAILABLE'), { cause: result.error });
  return result.data ?? [];
}

export async function readBugByIssue(issueId) {
  const rows = await query('SELECT run_id, issue_id, state FROM tm_bug WHERE issue_id = ? LIMIT 2', [Number(issueId)]);
  if (rows.length > 1) return { conflict: true, runId: null, issueId: String(issueId) };
  return rows[0] ? { runId: String(rows[0].run_id), issueId: String(rows[0].issue_id), state: rows[0].state } : null;
}

export async function listProjectBugRepairs(projectId) {
  const rows = await query("SELECT run_id, issue_key, last_error FROM tm_bug WHERE project_id = ? AND state = 'NEEDS_REPAIR' ORDER BY updated_at ASC LIMIT 101", [Number(projectId)]);
  return { items: rows.slice(0, 100).map(row => ({ runId: String(row.run_id), issueKey: row.issue_key ?? null,
    lastError: row.last_error ?? null })), complete: rows.length <= 100 };
}

/** A permanent exclusive assignment; retrying the same repair is idempotent. */
export async function claimBugIssue({ runId, issueId, now }) {
  if (!/^[0-9a-f]{32}$/.test(String(runId)) || !/^\d+$/.test(String(issueId))) throw new FailClosed('NOT_FOUND');
  try {
    await query('INSERT INTO tm_bug_issue_claim (issue_id, run_id, claimed_at) VALUES (?, ?, ?)', [Number(issueId), runId, now]);
    return true;
  } catch (error) {
    const code = error.cause?.code ?? error.cause?.context?.debug?.code;
    if (code !== 'ER_DUP_ENTRY' && !/duplicate entry/i.test(error.cause?.message ?? '')) throw error;
    const rows = await query('SELECT issue_id, run_id FROM tm_bug_issue_claim WHERE issue_id = ? OR run_id = ?', [Number(issueId), runId]);
    return rows.length === 1 && String(rows[0].issue_id) === String(issueId) && String(rows[0].run_id) === runId;
  }
}

export const BUG_MIGRATIONS = [{ id: 'v118_tm_bug_issue_claim', sql: `CREATE TABLE IF NOT EXISTS tm_bug_issue_claim (
  issue_id BIGINT NOT NULL PRIMARY KEY,
  run_id CHAR(32) NOT NULL,
  claimed_at BIGINT NOT NULL,
  UNIQUE KEY uq_tm_bug_claim_run (run_id)
)` }];
