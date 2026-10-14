import { runAdmin } from './adminRuntime.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';
import { describeEvent } from './evidenceFormat.js';
const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

export async function listLedger(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, limitClause, EVENT, lookupStatuses, lookupUsers, asApp, route } = deps;
    const { accountId } = req.context;
  const { issueKey, beforeSeq, limit } = req.payload ?? {};
  const pageSize = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_LEDGER_LIMIT, 1), MAX_LEDGER_LIMIT);
  let issue = null;
  if (issueKey && issueKey.trim()) {
    try {
      const response = await asApp().requestJira(
        route`/rest/api/3/issue/${issueKey.trim()}?fields=summary,status,issuetype,project`
      );
      if (!response.ok) {
        return { success: false, error: response.status === 404 ? `No work item "${issueKey.trim()}" was found.` : `Jira returned ${response.status}` };
      }
      const body = await response.json();
      issue = {
        issueId: body.id,
        issueKey: body.key,
        summary: body.fields?.summary ?? null,
        statusName: body.fields?.status?.name ?? null,
        issueTypeName: body.fields?.issuetype?.name ?? null,
        projectKey: body.fields?.project?.key ?? null
      };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  }
  const conditions = [];
  const params = [];
  if (issue) { conditions.push('issue_id = ?'); params.push(issue.issueId); }
  if (beforeSeq) { conditions.push('seq < ?'); params.push(beforeSeq); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await executeQuery(
    `SELECT seq, TO_BASE64(event_id) AS event_id, occurred_at, actor_account_id, event_type,
            issue_id, TO_BASE64(approval_id) AS approval_id, payload, entry_hash
     FROM va_audit ${where} ORDER BY seq DESC LIMIT ${limitClause(pageSize + 1)}`,
    params
  );
  if (!result.result) return { success: false, error: 'Failed to read the audit ledger.' };
  const rows = result.data ?? [];
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  let counts = null;
  let signaturesSummary = [];
  if (issue) {
    const countResult = await executeQuery(
      'SELECT event_type, COUNT(*) AS c FROM va_audit WHERE issue_id = ? GROUP BY event_type',
      [issue.issueId]
    );
    if (countResult.result) {
      counts = Object.fromEntries((countResult.data ?? []).map((r) => [r.event_type, Number(r.c)]));
    }
    const summaryResult = await executeQuery(
      `SELECT occurred_at, actor_account_id, event_type, payload
       FROM va_audit 
       WHERE issue_id = ? AND event_type IN (?, ?, ?, ?)
       ORDER BY occurred_at DESC`,
      [issue.issueId, EVENT.SIGNATURE_CONSUMED, EVENT.SIGNATURE_DECLINED, EVENT.CHANGE_APPROVED, EVENT.CHANGE_REJECTED]
    );
    if (summaryResult.result) {
      signaturesSummary = summaryResult.data ?? [];
    }
  }
  const [statuses, users] = await Promise.all([
    lookupStatuses(),
    lookupUsers([
      ...page.map((r) => r.actor_account_id),
      ...signaturesSummary.map((r) => r.actor_account_id)
    ].filter((id) => id !== 'system'))
  ]);
  const statusName = (id) => statuses.get(String(id))?.name ?? null;
  return {
    success: true,
    issue,
    counts,
    hasMore,
    nextBeforeSeq: hasMore ? page[page.length - 1].seq : null,
    signaturesSummary: signaturesSummary.map((row) => {
      let payload = {};
      try { payload = JSON.parse(row.payload); } catch {  }
      const actor = row.actor_account_id === 'system' ? null : users.get(row.actor_account_id);
      return {
        occurredAt: row.occurred_at,
        actorName: row.actor_account_id === 'system' ? 'System' : (payload.actorName ?? actor?.displayName ?? null),
        eventType: row.event_type,
        payload
      };
    }),
    entries: page.map((row) => {
      let payload = {};
      try { payload = JSON.parse(row.payload); } catch {  }
      const described = describeEvent({ ...row, payload }, { statusName, EVENT });
      const actor = row.actor_account_id === 'system' ? null : users.get(row.actor_account_id);
      return {
        seq: row.seq,
        occurredAt: row.occurred_at,
        actorName: row.actor_account_id === 'system' ? 'System' : (actor?.displayName ?? null),
        eventType: row.event_type,
        entryHash: row.entry_hash,
        payload,
        ...described
      };
    })
  };
  }, overrides, 'evidence');
}

/**
 * The highest sequence number in the ledger, site-wide or for one issue.
 *
 * Exists so an open Audit ledger page can tell that activity has been recorded
 * since it loaded without re-reading the page, re-fetching the issue from Jira
 * or recomputing the counts. Ledger sequence numbers only ever increase and
 * rows are never deleted, so a head greater than the newest displayed entry
 * means new activity and nothing else.
 *
 * The page shows this as a prompt rather than redrawing itself: rows must not
 * shift under somebody reading an audit record.
 */
export async function ledgerHead(req, overrides) {
  return runAdmin(req, async (deps) => {
    const issueId = req.payload?.issueId;
    const result = await deps.executeQuery(
      `SELECT MAX(seq) AS max_seq FROM va_audit${issueId ? ' WHERE issue_id = ?' : ''}`,
      issueId ? [issueId] : []
    );
    if (!result.result) return { success: false, error: 'Failed to read the audit ledger.' };
    return { maxSeq: Number(result.data?.[0]?.max_seq ?? 0) };
  }, overrides, 'evidence');
}

export async function verifyLedger(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { verifyChain, auditStore } = deps;
    const { accountId } = req.context;
  const { windowSize } = req.payload ?? {};
  const size = Math.min(Math.max(Math.floor(Number(windowSize)) || 2000, 1), 20000);
  const tail = await auditStore.readTail();
  if (!tail) return { success: true, empty: true };
  const fromSeq = Math.max(1, tail.seq - size + 1);
  try {
    const result = await verifyChain(auditStore, { from: fromSeq });
    return { success: true, result, windowFrom: fromSeq, windowTo: tail.seq };
  } catch (e) {
    console.error(e);
    return { success: false, error: e.message };
  }
  }, overrides, 'evidence');
}
