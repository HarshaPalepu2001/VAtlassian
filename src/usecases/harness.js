import api, { route } from '@forge/api';
import { harnessLog } from '../lib/harnessLogger.js';
import { getReview } from '../db/itemStateStore.js';
import { activeBaseline } from '../db/baselineStore.js';
import { readTreeDrift } from '../db/treeDriftStore.js';
import { approvalHistory } from '../db/approvalStore.js';
import { restoresForIssue } from '../db/restoreStore.js';
import { query } from './adminRuntime.js';

export async function logAction({ payload, context }) {
  const accountId = context?.accountId || 'anonymous';
  const category = payload?.category || 'UI';
  const action = payload?.action || 'unknown';
  const issueKey = payload?.issueKey || 'NONE';
  const details = payload?.details || {};
  const error = payload?.error;

  harnessLog('CLIENT', action, {
    category,
    issueKey,
    actorAccountId: accountId,
    clientTimestamp: payload?.timestamp,
    ...details,
    ...(error ? { error } : {})
  }, error ? 'ERROR' : 'INFO');

  return { ok: true };
}

export async function inspectIssue({ payload, context }) {
  const issueKeyOrId = payload?.issueKey || payload?.issueId;
  if (!issueKeyOrId) {
    return { ok: false, error: 'Missing issueKey or issueId' };
  }

  const forgeApi = api?.default?.asApp ? api.default : api;
  let issueData = null;

  try {
    const res = await forgeApi.asApp().requestJira(
      route`/rest/api/3/issue/${issueKeyOrId}?fields=summary,status,issuetype,project`
    );
    if (res?.ok) {
      issueData = await res.json();
    }
  } catch (err) {
    harnessLog('DIAGNOSTICS', 'inspectIssue:jiraReadFailed', { issueKeyOrId, error: err?.message }, 'WARN');
  }

  const numericIssueId = Number(issueData?.id || payload?.issueId);
  if (!numericIssueId || Number.isNaN(numericIssueId)) {
    return { ok: false, error: `Could not resolve numeric issue id for ${issueKeyOrId}` };
  }

  const [review, baseline, approvals, restores] = await Promise.all([
    getReview(numericIssueId).catch(() => null),
    activeBaseline(numericIssueId).catch(() => null),
    approvalHistory(numericIssueId).catch(() => []),
    restoresForIssue(numericIssueId).catch(() => [])
  ]);

  let treeDrift = [];
  if (baseline?.baseline_id) {
    try {
      treeDrift = await readTreeDrift(baseline.baseline_id);
    } catch {
      treeDrift = [];
    }
  }

  let auditEntries = [];
  try {
    const auditRes = await query({}, `SELECT event_id, event_type, actor_account_id, payload, occurred_at
      FROM va_audit WHERE issue_id = ? ORDER BY event_id DESC LIMIT 15`, [numericIssueId]);
    auditEntries = auditRes?.data || [];
  } catch {
    auditEntries = [];
  }

  const result = {
    ok: true,
    issue: {
      id: numericIssueId,
      key: issueData?.key || payload?.issueKey,
      summary: issueData?.fields?.summary,
      status: issueData?.fields?.status?.name,
      issueType: issueData?.fields?.issuetype?.name,
      project: issueData?.fields?.project?.key
    },
    review: review ? {
      state: review.state,
      version: review.version,
      lockToken: review.lock_token ? 'LOCKED' : null,
      lastCheckedAt: review.last_checked_at,
      driftCount: review.drift_count,
      activeRoots: review.active_roots
    } : null,
    baseline: baseline ? {
      baselineId: Buffer.isBuffer(baseline.baseline_id) ? baseline.baseline_id.toString('hex') : baseline.baseline_id,
      version: baseline.version,
      approverName: baseline.approver_name,
      treeHash: baseline.tree_hash,
      edgeCount: baseline.edge_count,
      nodeCount: baseline.node_count,
      capturedAt: baseline.captured_at
    } : null,
    drift: {
      treeDriftCount: treeDrift.length,
      items: treeDrift.slice(0, 10)
    },
    approvals: (approvals || []).slice(0, 5).map(a => ({
      approvalId: Buffer.isBuffer(a.approval_id) ? a.approval_id.toString('hex') : a.approval_id,
      decision: a.decision,
      state: a.state,
      assuranceLevel: a.assurance_level,
      meaning: a.meaning,
      signerRole: a.signer_role,
      decidedAt: a.decided_at,
      expiresAt: a.expires_at
    })),
    // WHY THE VERIFICATION DETAIL IS HERE. The harness could report that a
    // restore came back PARTIAL and nothing else, so "why was it partial?" had
    // no answer short of reading va_restore.detail out of the database by hand.
    // The verifier already knows which field on which work item refused to
    // match; this is the surface that says so.
    restores: (restores || []).slice(0, 5).map(r => {
      const summary = Array.isArray(r.detail) ? r.detail.find(entry => entry && typeof entry === 'object') : null;
      return {
        restoreId: Buffer.isBuffer(r.restore_id) ? r.restore_id.toString('hex') : r.restore_id,
        state: r.state,
        totalSteps: r.total_steps,
        completedSteps: r.completed_steps,
        lastError: r.last_error,
        unmatched: summary?.unmatched ?? summary?.verification?.unmatched ?? [],
        refused: (summary?.refused ?? []).map(entry => ({
          kind: entry?.kind ?? null, issueKey: entry?.issueKey ?? null,
          reason: entry?.error?.detail ?? null
        })),
        // Kept raw as a last resort for restores written before the verifier
        // reported per-field detail — including the one this was built for.
        verificationChanges: summary?.verification?.changes ?? []
      };
    }),
    recentAudit: auditEntries
  };

  harnessLog('DIAGNOSTICS', 'inspectIssue:success', { issueKey: result.issue.key, baselineVersion: result.baseline?.version, state: result.review?.state });
  return result;
}
