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
 * BASELINES KEEP A PAIR UNDER WATCH. va-gate does two jobs: it asks for a
 * signature on controlled transitions, and on every transition it holds a
 * baselined work item whose content has drifted. The second job outlives the
 * first. When an admin deletes every controlled transition for a project and
 * issue type, the ACTIVE baselines there are still held on drift, by nothing
 * but the validator. A check that only visits pairs with rows would go silent
 * at exactly that moment, and a validator detached afterwards would never be
 * reported. So the pairs checked are the union of those with ACTIVE controlled
 * transitions and those with ACTIVE baselines (pairsToCheck), and a pair with
 * baselines but no rows is judged for HOLD_ABSENT alone.
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
import { gateUnenforcedAlert, driftHoldAbsentAlert } from '../lib/alerts.js';

const ACTOR = 'system:gatecheck';
const ACTIVE = 'ACTIVE';

/** The Jira client (@forge/api, via workflowSource) and the alert queue are
 *  loaded when run() is called, not when this module is imported. pairsToCheck
 *  is pure and is imported by tests on its own; pulling the Forge runtime into
 *  that import would make the pure half of this file untestable without it. */
async function loadIo() {
  const [workflowSource, alertStore] = await Promise.all([
    import('../lib/workflowSource.js'),
    import('../db/alertStore.js')
  ]);
  return {
    readWorkflowForPair: workflowSource.readWorkflowForPair,
    defaultRequest: workflowSource.defaultRequest,
    runtimeAppId: workflowSource.runtimeAppId,
    MODULE_KEY: workflowSource.MODULE_KEY,
    enqueue: alertStore.enqueue
  };
}

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

/** Every (project, issue type) pair with at least one ACTIVE baseline. Those
 *  work items are held on drift by va-gate whether or not any controlled
 *  transition remains there, so their workflows need watching too. Throws like
 *  the loader above: a pair list we could not read is not an empty one. */
async function loadActiveBaselinePairs() {
  const res = await executeQuery(
    `SELECT DISTINCT project_id, issue_type_id
       FROM va_baseline
      WHERE state = ?`,
    [ACTIVE]
  );
  if (!res.result) {
    throw new Error(`gatecheck: could not read baselined pairs: ${res.error}`);
  }
  return res.data ?? [];
}

/**
 * The pairs this run must read: one per distinct (project, issue type) found in
 * the ACTIVE controlled transitions OR in the pairs holding ACTIVE baselines.
 *
 * Each entry has groupByPair's shape ({ projectId, issueTypeId, rows }) plus
 * the snake_case project_id / issue_type_id, so it can be handed straight to
 * diffWorkflow as its `scope`. A pair known only from its baselines carries
 * `rows: []` and is judged for the drift hold alone. Pairs are matched on their
 * string form, because project_id may come back as a number from one table and
 * a string from another and they are still the same project.
 */
export function pairsToCheck({ rows = [], baselinePairs = [] } = {}) {
  const pairs = new Map();
  for (const group of groupByPair(rows)) {
    pairs.set(`${group.projectId}:${group.issueTypeId}`, {
      ...group,
      project_id: group.projectId,
      issue_type_id: group.issueTypeId
    });
  }
  for (const bp of baselinePairs) {
    if (bp?.project_id == null || bp?.issue_type_id == null) continue;
    const key = `${bp.project_id}:${bp.issue_type_id}`;
    if (pairs.has(key)) continue;
    pairs.set(key, {
      projectId: bp.project_id,
      issueTypeId: bp.issue_type_id,
      project_id: bp.project_id,
      issue_type_id: bp.issue_type_id,
      rows: []
    });
  }
  return [...pairs.values()];
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

export async function run({ request, appId } = {}) {
  const started = Date.now();
  const now = started;
  const { readWorkflowForPair, defaultRequest, runtimeAppId, MODULE_KEY, enqueue } = await loadIo();
  request ??= defaultRequest;
  appId ??= runtimeAppId();

  const rows = await loadActiveControlledTransitions();
  const baselinePairs = await loadActiveBaselinePairs();
  // Nothing controlled AND nothing baselined: no workflow has anything for
  // va-gate to do, so there is nothing to check. Rows alone are not enough to
  // stop here — baselines still depend on the validator for their drift hold.
  if (rows.length === 0 && baselinePairs.length === 0) {
    const summary = { ok: true, pairs: 0, findings: 0, note: 'no ACTIVE controlled transitions or baselines', ms: 0 };
    console.log('gatecheck:', JSON.stringify(summary));
    return summary;
  }

  const previouslyOpen = await readOpenFindingKeys();
  const groups = pairsToCheck({ rows, baselinePairs });

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

    // `scope` only matters when the pair has no rows: it is how a
    // baselines-only pair's HOLD_ABSENT findings know which pair they are for.
    const findings = diffWorkflow({
      rows: group.rows,
      scope: group,
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
        const alertInput = {
          findingKey: finding.key,
          findingType: finding.type,
          detail: finding.detail,
          projectKey: null, // resolved for display in the console, not here
          occurredAt: now
        };
        await enqueue(finding.type === FINDING.HOLD_ABSENT
          ? driftHoldAbsentAlert(alertInput)
          : gateUnenforcedAlert(alertInput));
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
