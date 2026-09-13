/**
 * GATE CHECK — does Jira still enforce what we say is enforced?
 *
 * The compliance argument for this file is in lib/gateDrift.js's header; this
 * one is the I/O around it. In short: if an administrator detaches the sig-gate
 * validator, Jira stops calling us and the edge silently stops being controlled
 * while every surface we own keeps reporting that it is. That is the only
 * silent-permit path in the app, and it is unreachable from gate.js, because
 * gate.js is what was removed. This job is the detection that replaces the
 * enforcement we cannot perform.
 *
 * ONE PAIR PER CALL. The bulk-get endpoint accepts several project/issue-type
 * pairs at once, but the response carries no mapping from each returned
 * workflow back to the pair that produced it — verified against a live instance
 * on 2026-08-31, where four issue types collapsed into a single unattributed
 * workflow. Sending one pair per call is what makes the attribution sound. The
 * call count is bounded by how many distinct pairs an admin has configured,
 * which is small, and identical pairs are grouped before any request is made.
 *
 * A FAILED READ IS NOT A CLEAN BILL OF HEALTH. This is the rule the whole job
 * turns on. Findings are cleared by absence — a finding not observed this run
 * is treated as resolved — so a Jira outage that returns nothing would clear
 * every open finding at once and report the instance as healthy. Clearing is
 * therefore scoped to pairs that were READ SUCCESSFULLY this run; a pair whose
 * request failed keeps its findings untouched and is retried next run. An
 * unreachable Jira must leave the record exactly as it was, never improve it.
 *
 * IT DOES NOT REPAIR ANYTHING. Reattaching a validator means writing to the
 * customer's workflow, which needs a stale-read-safe round trip through their
 * entire workflow definition and, more to the point, an authorization from a
 * named administrator rather than from a vendor's scheduled job. Detection is
 * this job's whole remit; remediation belongs to the admin console, where a
 * person clicks it and the ledger records who.
 */
import { executeQuery } from '../lib/db.js';
import { append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import { diffWorkflow, groupByPair, FINDING, SEVERITY } from '../lib/gateDrift.js';
import { gateUnenforcedAlert } from '../lib/alerts.js';
import { enqueue } from '../db/alertStore.js';
import { readWorkflowForPair, defaultRequest, runtimeAppId, MODULE_KEY } from '../lib/workflowSource.js';

const ACTOR = 'system:gatecheck';
const ACTIVE = 'ACTIVE';

export { MODULE_KEY, runtimeAppId };

async function loadActiveControlledTransitions() {
  const res = await executeQuery(
    `SELECT project_id, issue_type_id, from_status_id, to_status_id, required_role, meaning
       FROM va_controlled_transition
      WHERE state = ?`,
    [ACTIVE]
  );
  if (!res.result) {
    throw new Error(`gatecheck: could not read controlled transitions: ${res.error}`);
  }
  return res.data ?? [];
}

async function readOpenFindingKeys() {
  const res = await executeQuery(
    'SELECT finding_key, project_id, issue_type_id FROM va_gate_finding WHERE cleared_at IS NULL'
  );
  if (!res.result) {
    // Without the open set we cannot safely clear anything. Returning null
    // tells run() to record findings but skip the clearing pass entirely.
    console.error('gatecheck: could not read open findings; skipping the clear pass', res.error);
    return null;
  }
  return res.data ?? [];
}

async function upsertFinding(finding, now) {
  const res = await executeQuery(
    `INSERT INTO va_gate_finding
       (finding_key, finding_type, severity, project_id, issue_type_id,
        workflow_id, transition_id, from_status_id, to_status_id,
        detail, first_seen_at, last_seen_at, cleared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       last_seen_at = VALUES(last_seen_at),
       detail       = VALUES(detail),
       severity     = VALUES(severity),
       cleared_at   = NULL`,
    [
      finding.key, finding.type, finding.severity,
      finding.projectId, finding.issueTypeId,
      finding.workflowId, finding.transitionId,
      finding.fromStatusId, finding.toStatusId,
      finding.detail, now, now
    ]
  );
  if (!res.result) console.error(`gatecheck: could not persist finding ${finding.key}`, res.error);
  return res.result === true;
}

async function clearFinding(key, now) {
  const res = await executeQuery(
    'UPDATE va_gate_finding SET cleared_at = ? WHERE finding_key = ? AND cleared_at IS NULL',
    [now, key]
  );
  if (!res.result) console.error(`gatecheck: could not clear finding ${key}`, res.error);
  return res.result === true;
}

async function audit(eventType, payload) {
  try {
    await append(auditStore, { eventId: newId(), actorAccountId: ACTOR, eventType, payload });
    return true;
  } catch (e) {
    console.error(`gatecheck: could not append ${eventType}`, e);
    return false;
  }
}

export async function run({ request = defaultRequest, appId = runtimeAppId() } = {}) {
  const started = Date.now();
  const now = started;

  const rows = await loadActiveControlledTransitions();
  if (rows.length === 0) {
    const summary = { ok: true, pairs: 0, findings: 0, note: 'no ACTIVE controlled transitions', ms: 0 };
    console.log('gatecheck:', JSON.stringify(summary));
    return summary;
  }

  const previouslyOpen = await readOpenFindingKeys();
  const groups = groupByPair(rows);

  const seen = new Map();          // finding key -> finding
  const evaluatedPairs = new Set(); // "projectId:issueTypeId" actually read
  let unreadable = 0;

  for (const group of groups) {
    const workflow = await readWorkflowForPair(group, { request });
    if (!workflow) {
      unreadable += 1;
      continue; // NOT evaluated — its findings must survive untouched.
    }
    evaluatedPairs.add(`${group.projectId}:${group.issueTypeId}`);

    const findings = diffWorkflow({
      rows: group.rows,
      workflow,
      appId,
      moduleKey: MODULE_KEY
    });
    for (const f of findings) seen.set(f.key, f);
  }

  // --- Record what is wrong now ------------------------------------------
  const knownOpen = new Set((previouslyOpen ?? []).map((r) => r.finding_key));
  let raised = 0;
  for (const finding of seen.values()) {
    if (!(await upsertFinding(finding, now))) continue;
    if (!knownOpen.has(finding.key)) {
      raised += 1;
      // Only CRITICAL findings page anyone. GATE_ORPHANED and
      // GATE_BYPASS_PATH are real and belong in the console, but neither lets
      // anything through unsigned, and an alert channel that fires on things
      // nobody must act on tonight stops being read — which would cost us the
      // two findings that genuinely mean items are crossing unsigned.
      if (finding.severity === SEVERITY.CRITICAL) {
        await enqueue(gateUnenforcedAlert({
          findingKey: finding.key,
          findingType: finding.type,
          detail: finding.detail,
          projectKey: null, // resolved for display in the console, not here
          occurredAt: now
        }));
      }
      await audit(EVENT.GATE_DRIFT_DETECTED, {
        findingKey: finding.key,
        type: finding.type,
        severity: finding.severity,
        projectId: finding.projectId,
        issueTypeId: finding.issueTypeId,
        workflowId: finding.workflowId,
        transitionId: finding.transitionId,
        detail: finding.detail
      });
    }
  }

  // --- Clear what is no longer wrong, but ONLY where we actually looked ---
  let cleared = 0;
  if (previouslyOpen === null) {
    console.warn('gatecheck: open findings unreadable this run; nothing cleared');
  } else {
    for (const row of previouslyOpen) {
      if (seen.has(row.finding_key)) continue;
      const pair = `${row.project_id}:${row.issue_type_id}`;
      // The rule this job turns on: absence only means resolved if we looked.
      if (!evaluatedPairs.has(pair)) continue;
      if (!(await clearFinding(row.finding_key, now))) continue;
      cleared += 1;
      await audit(EVENT.GATE_DRIFT_CLEARED, { findingKey: row.finding_key, projectId: row.project_id, issueTypeId: row.issue_type_id });
    }
  }

  const critical = [...seen.values()].filter((f) => f.severity === SEVERITY.CRITICAL).length;
  const summary = {
    ok: unreadable === 0,
    pairs: groups.length,
    evaluated: evaluatedPairs.size,
    unreadable,
    open: seen.size,
    critical,
    raised,
    cleared,
    ms: Date.now() - started
  };

  if (critical > 0) {
    // Loud on purpose. A CRITICAL finding means work items are crossing a
    // controlled edge unsigned right now.
    console.error('gatecheck: UNENFORCED CONTROLLED TRANSITIONS', JSON.stringify({
      ...summary,
      findings: [...seen.values()].filter((f) => f.severity === SEVERITY.CRITICAL).map((f) => f.key)
    }));
  } else {
    console.log('gatecheck:', JSON.stringify(summary));
  }

  return summary;
}

export { FINDING };
export const handler = run;
