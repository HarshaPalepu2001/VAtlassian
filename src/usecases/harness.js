import api, { route } from '@forge/api';
import { harnessLog } from '../lib/harnessLogger.js';
import { getReview } from '../db/itemStateStore.js';
import { activeBaseline } from '../db/baselineStore.js';
import { readTreeDrift } from '../db/treeDriftStore.js';
import { approvalHistory } from '../db/approvalStore.js';
import { restoresForIssue } from '../db/restoreStore.js';
import { projectConfig, listGatedTransitions } from '../db/configStore.js';
import { throwing } from '../db/store.js';
import { toBinaryParam } from '../lib/db.js';
import { baselineDrift, logLiveDrift } from '../lib/liveDrift.js';
import { scopeForItem } from '../lib/tree/nodeFields.js';
import { canonicaliseIssue } from '../lib/attachmentIdentity.js';
import { activeRootsForNode, rootNodeDigests } from '../db/baselineTreeStore.js';
import { controlledFields } from '../db/configStore.js';

/**
 * The issue is read AS THE CALLER. This is served from the panel resolver,
 * which every Jira and Confluence user can reach, so the caller's own browse
 * permission is what stands between them and the stored record of an issue
 * hidden from them by issue security.
 */
/**
 * THE SAME LIVE CHECK THE VALIDATOR RUNS — not the stored counter. The issue is
 * read in full as the caller and compared exactly as lib/approval/runtime.js
 * does, so what this says is what the gate will say.
 */
async function liveDriftForIssue({ issueKey, baseline }) {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
  if (!response?.ok) throw new Error(`Jira read failed (${response?.status ?? 'no response'})`);
  const issue = await canonicaliseIssue(await response.json());
  const item = { issueId: Number(issue.id), projectId: Number(issue.fields.project.id),
    issueTypeId: String(issue.fields.issuetype.id) };
  const scope = await scopeForItem(item, { activeRootsForNode });
  const declared = await controlledFields({ projectId: scope.projectId, issueTypeId: scope.issueTypeId });
  const comparison = await baselineDrift({ baseline, issueId: item.issueId, issueFields: issue.fields, declared,
    readRootDigests: rootNodeDigests });
  return { comparison, scope, issueTypeId: item.issueTypeId };
}

const defaultInspectDeps = {
  liveDrift: liveDriftForIssue,
  readIssue: key => api.asUser().requestJira(
    route`/rest/api/3/issue/${key}?fields=summary,status,issuetype,project`),
  getReview, activeBaseline, approvalHistory, restoresForIssue, readTreeDrift,
  projectConfig, listGatedTransitions,
  query: throwing
};

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

export async function inspectIssue({ payload, context }, deps = defaultInspectDeps) {
  const issueKeyOrId = payload?.issueKey || payload?.issueId;
  if (!issueKeyOrId) {
    return { ok: false, error: 'Missing issueKey or issueId' };
  }

  let issueData = null;
  try {
    const res = await deps.readIssue(String(issueKeyOrId));
    if (res?.ok) issueData = await res.json();
  } catch (err) {
    harnessLog('DIAGNOSTICS', 'inspectIssue:jiraReadFailed', { issueKeyOrId, error: err?.message }, 'WARN');
  }

  // Only an issue the caller could read is inspected: never fall back to the
  // payload's own id, which would describe an issue nobody proved they can see.
  const numericIssueId = Number(issueData?.id);
  if (!numericIssueId || Number.isNaN(numericIssueId)) {
    return { ok: false, error: `Could not resolve numeric issue id for ${issueKeyOrId}` };
  }
  const rows = (sql, params) => deps.query(sql, params).catch(() => []);

  const [review, baseline, approvals, restores] = await Promise.all([
    deps.getReview(numericIssueId).catch(() => null),
    deps.activeBaseline(numericIssueId).catch(() => null),
    deps.approvalHistory(numericIssueId).catch(() => []),
    deps.restoresForIssue(numericIssueId).catch(() => [])
  ]);

  const treeDrift = baseline?.baseline_id ? await deps.readTreeDrift(baseline.baseline_id).catch(() => []) : [];

  // THE LIVE VERDICT. The stored counter (review.drift_count) and the live
  // comparison have disagreed before (VJIRA-17), and the validator, the signing
  // form and the panel header all hold on the live one. Reporting only the
  // counter is how this screen said HEALTHY while a transition was refused.
  let liveDrift = { checked: false, reason: deps.liveDrift ? (baseline ? null : 'NO_BASELINE') : 'NOT_AVAILABLE' };
  if (baseline && deps.liveDrift) {
    try {
      const { comparison, scope, issueTypeId } = await deps.liveDrift({ issueKey: issueData?.key ?? String(issueKeyOrId), baseline });
      logLiveDrift('diagnostics', { issueKey: issueData?.key, issueTypeId, comparison, scope });
      liveDrift = {
        checked: true,
        changedCount: comparison.changed.length,
        changed: comparison.changed.slice(0, 40),
        diagnostics: comparison.diagnostics ?? null,
        scope: scope ? { source: scope.source, issueTypeId: String(scope.issueTypeId), rootIssueId: scope.rootIssueId ?? null } : null
      };
    } catch (err) {
      liveDrift = { checked: false, reason: 'LIVE_CHECK_FAILED', error: err?.message ?? String(err) };
      harnessLog('DIAGNOSTICS', 'inspectIssue:liveDriftFailed', { issueKey: issueData?.key, error: err?.message }, 'WARN');
    }
  }

  // RULES ARE KEYED BY WORK ITEM TYPE, and a baseline remembers the type it was
  // captured under. A type change in between silently swaps the rule (and its
  // assurance) that applies, which no other screen says.
  const currentTypeId = issueData?.fields?.issuetype?.id == null ? null : String(issueData.fields.issuetype.id);
  const baselineTypeId = baseline?.issue_type_id == null ? null : String(baseline.issue_type_id);
  const typeCheck = {
    issueTypeId: currentTypeId,
    issueTypeName: issueData?.fields?.issuetype?.name ?? null,
    baselineIssueTypeId: baselineTypeId,
    typeChangedSinceBaseline: Boolean(currentTypeId && baselineTypeId && currentTypeId !== baselineTypeId)
  };

  const auditEntries = await rows(`SELECT seq, event_type, actor_account_id, payload, occurred_at
    FROM va_audit WHERE issue_id = ? ORDER BY seq DESC LIMIT 15`, [numericIssueId]);

  // 1. Vault storage diagnostics
  const vaultPage = (await rows('SELECT confluence_page_id, created_at FROM va_vault_page WHERE issue_id = ?',
    [numericIssueId]))[0] ?? null;
  const vaultAttachments = await rows(`SELECT jira_attachment_id, filename, content_hash, confluence_attachment_id, vaulted_at,
      storage, object_key, media_id
    FROM va_vault_attachment WHERE issue_id = ? ORDER BY vaulted_at DESC LIMIT 20`, [numericIssueId]);
  // Where this site's new copies go (lib/vaultTier.js).
  const vaultTier = (await rows(`SELECT cfg_value FROM va_config WHERE cfg_key = 'vault:tier'`, []))[0]?.cfg_value ?? null;

  // 2. Child baselines diagnostics
  const childBaselines = baseline?.baseline_id
    ? (await rows(`SELECT issue_id, version, content_hash, captured_at
        FROM va_baseline WHERE captured_by_baseline_id = FROM_BASE64(?) ORDER BY issue_id ASC LIMIT 20`,
      [toBinaryParam(Buffer.from(baseline.baseline_id))])).map(c => ({
        issueId: c.issue_id,
        version: c.version,
        contentHash: c.content_hash,
        capturedAt: c.captured_at
      }))
    : [];

  // 3. Workflow gate policy simulation
  let projectDisabled = false;
  let controlledTransitions = [];
  const numericProjectId = Number(issueData?.fields?.project?.id);
  if (numericProjectId && !Number.isNaN(numericProjectId)) {
    projectDisabled = (await deps.projectConfig(numericProjectId).catch(() => null))?.enabled === false;
    controlledTransitions = (await deps.listGatedTransitions(numericProjectId).catch(() => []))
      .filter(ct => ct.state === 'ACTIVE');
  }

  const isBusy = ['RESTORING', 'DECIDING'].includes(review?.state);
  const isLocked = review?.state === 'LOCKED';
  const storedDriftCount = review?.drift_count ?? treeDrift.length;
  const driftCount = liveDrift.checked ? liveDrift.changedCount : storedDriftCount;
  const counterDisagrees = liveDrift.checked && (liveDrift.changedCount > 0) !== (Number(storedDriftCount) > 0);
  const hasUndecidedDrift = !projectDisabled && (driftCount > 0 || treeDrift.length > 0);
  const statusId = issueData?.fields?.status?.id == null ? null : String(issueData.fields.status.id);

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
    const cause = liveDrift.diagnostics?.cause;
    if (cause === 'BASELINE_UNREADABLE') {
      verdict = 'BASELINE_UNREADABLE';
      remediations.push(`The live check could not read the active baseline's digests (source: ${liveDrift.diagnostics.digestSource}), so it reports every tracked field as changed. This is a baseline storage problem, not an edit — approving again will not clear it.`);
    }
    if (counterDisagrees) {
      remediations.push('The stored drift counter says clean but the live check the validator uses does not: the transition will be refused even though the panel looks in sync.');
    }
  } else if (!baseline) {
    verdict = 'NO_BASELINE';
    remediations.push('Work item has no active baseline. Perform a controlled transition to capture one.');
  } else if ((restores || []).some(r => r.state === 'FAILED' || (r.unmatched && r.unmatched.length > 0))) {
    verdict = 'RESTORE_INCOMPLETE';
    remediations.push('Recent restore had unmatched fields or refused items. Check restore verification details.');
  } else {
    verdict = 'HEALTHY';
    remediations.push('Work item matches its active baseline; workflow gate is clear.');
    if (liveDrift.checked === false && liveDrift.reason === 'LIVE_CHECK_FAILED') {
      remediations.push('The live drift check could not run here, so this verdict rests on the stored counter only.');
    }
  }

  if (typeCheck.typeChangedSinceBaseline) {
    remediations.push(`This work item is now type ${typeCheck.issueTypeName ?? typeCheck.issueTypeId} but its baseline was captured as type ${typeCheck.baselineIssueTypeId}. Transition rules and tracked fields are keyed by type, so a different rule may now apply.`);
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
      storedDriftCount: Number(storedDriftCount) || 0,
      driftSource: liveDrift.checked ? 'LIVE' : 'STORED_COUNTER',
      counterDisagrees,
      workitemHeld: Boolean(holdReason),
      holdReason,
      activeControlledTransitions: controlledTransitions.length,
      applicableTransitions: controlledTransitions.map(ct => ({
        issueTypeId: ct.issue_type_id == null ? null : String(ct.issue_type_id),
        appliesToThisIssue: (String(ct.issue_type_id) === '*' || String(ct.issue_type_id) === currentTypeId)
          && (String(ct.from_status_id) === '*' || String(ct.from_status_id) === statusId),
        transitionId: ct.transition_id,
        fromStatusId: ct.from_status_id,
        toStatusId: ct.to_status_id,
        requiredRole: ct.required_role,
        requiredAssurance: ct.required_assurance,
        captureBaseline: Boolean(ct.capture_baseline)
      }))
    },
    liveDrift,
    typeCheck,
    review: review ? {
      state: review.state,
      version: review.version,
      lastCheckedAt: review.last_checked_at,
      driftCount: review.drift_count
    } : null,
    baseline: baseline ? {
      baselineId: Buffer.isBuffer(baseline.baseline_id) ? baseline.baseline_id.toString('hex') : baseline.baseline_id,
      version: baseline.version,
      issueTypeId: baselineTypeId,
      requiredAssurance: baseline.required_assurance ?? null,
      transitionId: baseline.transition_id ?? null,
      approverName: baseline.approved_name,
      treeHash: baseline.tree_hash,
      edgeCount: baseline.edge_count,
      nodeCount: baseline.node_count,
      capturedAt: baseline.captured_at
    } : null,
    childBaselines,
    vault: {
      tier: (() => { try { return vaultTier ? JSON.parse(vaultTier) : null; } catch { return null; } })(),
      confluencePageId: vaultPage?.confluence_page_id || null,
      pageCreatedAt: vaultPage?.created_at || null,
      attachmentCount: vaultAttachments.length,
      attachments: vaultAttachments.map(va => ({
        jiraAttachmentId: va.jira_attachment_id,
        filename: va.filename,
        contentHash: va.content_hash,
        confluenceAttachmentId: va.confluence_attachment_id,
        storage: va.storage || 'CONFLUENCE',
        objectKey: va.object_key || null,
        mediaId: va.media_id || null,
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
