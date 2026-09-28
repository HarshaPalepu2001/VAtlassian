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
  const traceId = payload?.traceId;

  harnessLog('CLIENT', action, {
    category,
    issueKey,
    traceId,
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

  // 1. Vault storage diagnostics
  let vaultPage = null;
  let vaultAttachments = [];
  try {
    const pageRes = await query({}, 'SELECT confluence_page_id, created_at FROM va_vault_page WHERE issue_id = ?', [numericIssueId]);
    vaultPage = pageRes?.data?.[0] ?? null;
    const attRes = await query({}, `SELECT jira_attachment_id, filename, content_hash, confluence_attachment_id, vaulted_at
      FROM va_vault_attachment WHERE issue_id = ? ORDER BY vaulted_at DESC LIMIT 20`, [numericIssueId]);
    vaultAttachments = attRes?.data ?? [];
  } catch {
    vaultPage = null;
    vaultAttachments = [];
  }

  // 2. Child baselines diagnostics
  let childBaselines = [];
  if (baseline?.baseline_id) {
    try {
      const childRes = await query({}, `SELECT issue_id, issue_key, version, content_hash, captured_at
        FROM bl_baseline WHERE captured_by_baseline_id = ? ORDER BY issue_key ASC LIMIT 20`, [baseline.baseline_id]);
      childBaselines = (childRes?.data ?? []).map(c => ({
        issueId: c.issue_id,
        issueKey: c.issue_key,
        version: c.version,
        contentHash: c.content_hash,
        capturedAt: c.captured_at
      }));
    } catch {
      childBaselines = [];
    }
  }

  // 3. Workflow gate policy simulation
  let projectDisabled = false;
  let controlledTransitions = [];
  const numericProjectId = Number(issueData?.fields?.project?.id);
  if (numericProjectId && !Number.isNaN(numericProjectId)) {
    try {
      const cfgRes = await query({}, 'SELECT value FROM va_config WHERE scope = ?', [`project:${numericProjectId}`]);
      if (cfgRes?.data?.[0]?.value) {
        const val = cfgRes.data[0].value;
        const parsed = typeof val === 'string' ? JSON.parse(val) : val;
        if (parsed?.enabled === false) projectDisabled = true;
      }
      const ctRes = await query({}, `SELECT id, transition_id, from_status_id, to_status_id, required_role, required_assurance, meaning, capture_baseline
        FROM va_controlled_transition WHERE project_id = ? AND state = 'ACTIVE'`, [numericProjectId]);
      controlledTransitions = ctRes?.data ?? [];
    } catch {
      controlledTransitions = [];
    }
  }

  const isBusy = ['RESTORING', 'DECIDING'].includes(review?.state) || Boolean(review?.lock_token);
  const isLocked = review?.state === 'LOCKED';
  const driftCount = review?.drift_count ?? treeDrift.length;
  const hasUndecidedDrift = !projectDisabled && (driftCount > 0 || treeDrift.length > 0);

  let holdReason = null;
  if (isBusy) {
    holdReason = 'RESTORE_IN_PROGRESS: ITEM_BUSY';
  } else if (isLocked) {
    holdReason = 'RECORD_LOCKED: ITEM_LOCKED';
  } else if (hasUndecidedDrift) {
    holdReason = 'UNDECIDED_DRIFT: DRIFT_OUTSTANDING';
  }

  // 4. Synthesized Health Verdict & Remediations
  let verdict = 'HEALTHY';
  const remediations = [];

  if (isBusy) {
    verdict = 'BUSY_RESTORING';
    remediations.push('A restore or baseline decision is currently executing. Await completion or lease expiry.');
  } else if (isLocked) {
    verdict = 'RECORD_LOCKED';
    remediations.push('Work item is locked by an ongoing ALM operation. Check active incidents.');
  } else if (hasUndecidedDrift) {
    verdict = 'DRIFT_PENDING_REVIEW';
    remediations.push('Unreviewed drift detected on tracked fields or child items. Review and approve or reject in the VAtlassian panel.');
  } else if (!baseline) {
    verdict = 'NO_BASELINE';
    remediations.push('Work item has no active baseline. Perform a controlled transition to capture one.');
  } else if ((restores || []).some(r => r.state === 'FAILED' || (r.unmatched && r.unmatched.length > 0))) {
    verdict = 'RESTORE_INCOMPLETE';
    remediations.push('Recent restore had unmatched fields or refused items. Check restore verification details.');
  } else {
    verdict = 'HEALTHY';
    remediations.push('Work item matches its active baseline; workflow gate is clear.');
  }

  const result = {
    ok: true,
    verdict,
    remediations,
    issue: {
      id: numericIssueId,
      key: issueData?.key || payload?.issueKey,
      summary: issueData?.fields?.summary,
      status: issueData?.fields?.status?.name,
      issueType: issueData?.fields?.issuetype?.name,
      project: issueData?.fields?.project?.key
    },
    gateSimulation: {
      projectDisabled,
      itemState: review?.state || 'UNTRACKED',
      driftCount,
      workitemHeld: Boolean(holdReason),
      holdReason,
      activeControlledTransitions: controlledTransitions.length,
      applicableTransitions: controlledTransitions.map(ct => ({
        transitionId: ct.transition_id,
        fromStatusId: ct.from_status_id,
        toStatusId: ct.to_status_id,
        requiredRole: ct.required_role,
        requiredAssurance: ct.required_assurance,
        captureBaseline: Boolean(ct.capture_baseline)
      }))
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
    childBaselines,
    vault: {
      confluencePageId: vaultPage?.confluence_page_id || null,
      pageCreatedAt: vaultPage?.created_at || null,
      attachmentCount: vaultAttachments.length,
      attachments: vaultAttachments.map(va => ({
        jiraAttachmentId: va.jira_attachment_id,
        filename: va.filename,
        contentHash: va.content_hash,
        confluenceAttachmentId: va.confluence_attachment_id,
        vaultedAt: va.vaulted_at
      }))
    },
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

  harnessLog('DIAGNOSTICS', 'inspectIssue:success', {
    issueKey: result.issue.key,
    verdict: result.verdict,
    baselineVersion: result.baseline?.version,
    state: result.review?.state
  });

  return result;
}
