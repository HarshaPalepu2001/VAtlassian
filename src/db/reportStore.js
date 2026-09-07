import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause, affectedRows } from '../lib/db.js';
import { throwing } from './store.js';

/**
 * va_ai_report — the AI report cache.
 *
 * KEYED BY EVIDENCE, NOT BY TIME. `report_hash` is
 * sha256(baseline_id ‖ sorted drift ids ‖ model), so a report is generated
 * exactly once per distinct set of evidence and never regenerated while that
 * evidence is unchanged. There is no TTL, because time is not what makes a
 * report stale — one more edit produces a different hash and a new report, and
 * no edits produce a cache hit forever, which is exactly right for an item
 * sitting in a queue for a week.
 *
 * It is also the receipt. va_approval.report_hash points here, so it is always
 * possible to reconstruct precisely what a reviewer was shown at the moment
 * they approved something. If a report is ever found to be wrong, that link is
 * what makes it possible to find every decision it influenced.
 */

export async function getReport(reportHash) {
  const rows = await throwing(
    `SELECT report_hash, issue_id, TO_BASE64(baseline_id) AS baseline_id, model, body,
            input_tokens, output_tokens, generated_at, degraded
     FROM va_ai_report WHERE report_hash = ?`,
    [reportHash]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  let body;
  try {
    body = JSON.parse(r.body);
  } catch {
    // A cached body that will not parse is a cache miss, not a failure. Return
    // null and let the caller regenerate rather than showing a reviewer a
    // broken report.
    console.error('report: unparseable cached body', reportHash);
    return null;
  }
  return {
    reportHash: r.report_hash,
    issueId: r.issue_id,
    baselineId: fromBinaryColumn(r.baseline_id),
    model: r.model,
    body,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    generatedAt: r.generated_at,
    degraded: !!Number(r.degraded)
  };
}

export async function putReport({ reportHash, issueId, baselineId, model, body, inputTokens, outputTokens, now, degraded }) {
  await throwing(
    `REPLACE INTO va_ai_report
     (report_hash, issue_id, baseline_id, model, body, input_tokens, output_tokens, generated_at, degraded)
     VALUES (?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?)`,
    [
      reportHash, issueId, toBinaryParam(baselineId), model,
      JSON.stringify(body), inputTokens ?? null, outputTokens ?? null, now, degraded ? 1 : 0
    ]
  );
}

/**
 * Drop cached bodies past the retention window.
 *
 * Reports referenced by a decision are KEPT regardless of age. A decision's
 * receipt outliving its cache entry would turn va_approval.report_hash into a
 * dangling pointer, and "we can tell you a reviewer approved this but not what
 * they were reading" is precisely the gap the column exists to close.
 */
export async function pruneReports(olderThanMs) {
  const result = await executeQuery(
    `DELETE FROM va_ai_report
     WHERE generated_at < ?
       AND report_hash NOT IN (SELECT report_hash FROM va_approval WHERE report_hash IS NOT NULL)`,
    [olderThanMs]
  );
  return affectedRows(result) ?? 0;
}

export async function reportsForIssue(issueId, limit = 10) {
  const rows = await throwing(
    `SELECT report_hash, model, generated_at, degraded FROM va_ai_report
     WHERE issue_id = ? ORDER BY generated_at DESC LIMIT ${limitClause(limit)}`,
    [issueId]
  );
  return rows.map((r) => ({ ...r, degraded: !!Number(r.degraded) }));
}
