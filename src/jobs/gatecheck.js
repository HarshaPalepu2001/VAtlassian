/**
 * Detect missing or misconfigured Jira workflow validators.
 *
 * If an administrator detaches va-gate, Jira no longer calls the validator.
 * This scheduled check compares live workflow data with configured controls.
 * See lib/gateDrift.js for the comparison rules and compliance rationale.
 *
 * Read one project/issue-type pair per request. The bulk-get response does not
 * attribute each workflow to its input pair. A live check on 2026-08-31 returned
 * one unattributed workflow for four issue types. Group identical pairs before
 * requesting them to avoid duplicate calls.
 *
 * Clear findings only for pairs read successfully in this run. An outage or
 * unreadable response must retain existing findings for the next attempt.
 * Otherwise an empty failed read would incorrectly resolve every finding.
 *
 * Check the union of pairs with ACTIVE controlled transitions and pairs with
 * ACTIVE baselines. A baseline still needs a drift hold after an administrator
 * deletes its last controlled-transition row. For pairs with baselines but no
 * rows, check HOLD_ABSENT only.
 *
 * This job detects problems; it never rewrites customer workflows. Repair
 * requires an administrator's authorization and an audited, stale-read-safe
 * update through the admin console.
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
  const [workflowSource, alertStore, directory] = await Promise.all([
    import('../lib/workflowSource.js'),
    import('../db/alertStore.js'), import('../lib/directory.js')
  ]);
  return {
    readWorkflowForPair: workflowSource.readWorkflowForPair,
    defaultRequest: workflowSource.defaultRequest,
    runtimeAppId: workflowSource.runtimeAppId,
    MODULE_KEY: workflowSource.MODULE_KEY,
    enqueue: alertStore.enqueue,
    lookupStatuses: directory.lookupStatuses
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
export function pairsToCheck({ rows = [], baselinePairs = [], tmExecutionPairs = [] } = {}) {
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
  for (const tm of tmExecutionPairs) {
    if (tm?.project_id == null || tm?.issue_type_id == null) continue;
    const key = `${tm.project_id}:${tm.issue_type_id}`;
    const existing = pairs.get(key);
    if (existing) existing.testManagementExecution = true;
    else pairs.set(key, { projectId: tm.project_id, issueTypeId: tm.issue_type_id,
      project_id: tm.project_id, issue_type_id: tm.issue_type_id, rows: [],
      testManagementExecution: true, testManagementOnly: true });
  }
  return [...pairs.values()];
}

async function loadEnabledTestManagementPairs() {
  const res = await executeQuery('SELECT project_id, execution_type_id AS issue_type_id FROM tm_project WHERE enabled = 1');
  if (!res.result) throw new Error('gatecheck: could not read enabled test-management execution pairs');
  return res.data ?? [];
}

/** Unknown status metadata cannot clear a previous execution-health finding. */
export function testManagementWorkflowFindings({ workflow, group, statuses, appId, moduleKey = 'va-gate' }) {
  if (!Array.isArray(workflow?.transitions)) throw new Error('Execution workflow transitions unreadable');
  const done = workflow.transitions.filter(transition => {
    if (transition.type === 'INITIAL') return false;
    const category = statuses?.get(String(transition.toStatusReference))?.category;
    if (!category) throw new Error('Execution workflow destination status unreadable');
    return String(category).toLowerCase() === 'done';
  });
  return diffWorkflow({ rows: [], scope: group, workflow: { ...workflow, transitions: done }, appId, moduleKey })
    .map(finding => finding.type !== FINDING.HOLD_ABSENT ? finding : ({ ...finding,
      key: finding.key.replace(/^HOLD_ABSENT:/, 'TM_EXECUTION_GATE_ABSENT:'), type: 'TM_EXECUTION_GATE_ABSENT',
      detail: `Test Execution workflow "${workflow.name}" has a Done route without an enabled VAtlassian Approval validator (transition ${finding.transitionId}). Runs can bypass their completion guard on this route. Reattach the validator before treating this project as enforced.` }));
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

export async function run({ request, appId, tmExecutionPairs: providedTestManagementPairs } = {}) {
  const started = Date.now();
  const now = started;
  const { readWorkflowForPair, defaultRequest, runtimeAppId, MODULE_KEY, enqueue, lookupStatuses } = await loadIo();
  request ??= defaultRequest;
  appId ??= runtimeAppId();

  const rows = await loadActiveControlledTransitions();
  const baselinePairs = await loadActiveBaselinePairs();
  const tmExecutionPairs = providedTestManagementPairs ?? await loadEnabledTestManagementPairs();
  // Skip only when the pair has neither controlled rows nor baselines.
  // Baselined items still need the validator's drift hold after rows are deleted.
  if (rows.length === 0 && baselinePairs.length === 0 && tmExecutionPairs.length === 0) {
    const summary = { ok: true, pairs: 0, findings: 0, note: 'no ACTIVE controlled transitions, baselines or enabled test management', ms: 0 };
    console.log('gatecheck:', JSON.stringify(summary));
    return summary;
  }

  const previouslyOpen = await readOpenFindingKeys();
  const groups = pairsToCheck({ rows, baselinePairs, tmExecutionPairs });
  const statuses = tmExecutionPairs.length ? await lookupStatuses() : null;

  const seen = new Map();          // finding key -> finding
  const evaluatedPairs = new Set(); // "projectId:issueTypeId" actually read
  let unreadable = 0;

  for (const group of groups) {
    const workflow = await readWorkflowForPair(group, { request });
    if (!workflow) {
      unreadable += 1;
      continue; // Not evaluated. Retain its existing findings.
    }
    let executionFindings = [];
    if (group.testManagementExecution) {
      try { executionFindings = testManagementWorkflowFindings({ workflow, group, statuses, appId, moduleKey: MODULE_KEY }); }
      catch { unreadable += 1; continue; }
    }
    evaluatedPairs.add(`${group.projectId}:${group.issueTypeId}`);

    // `scope` only matters when the pair has no rows: it is how a
    // baselines-only pair's HOLD_ABSENT findings know which pair they are for.
    const findings = group.testManagementOnly ? [] : diffWorkflow({
      rows: group.rows,
      scope: group,
      workflow,
      appId,
      moduleKey: MODULE_KEY
    });
    for (const f of [...findings, ...executionFindings]) seen.set(f.key, f);
  }

  // --- Record what is wrong now ------------------------------------------
  const knownOpen = new Set((previouslyOpen ?? []).map((r) => r.finding_key));
  let raised = 0;
  for (const finding of seen.values()) {
    if (!(await upsertFinding(finding, now))) continue;
    if (!knownOpen.has(finding.key)) {
      raised += 1;
      // Page only for CRITICAL findings. Show GATE_ORPHANED and GATE_BYPASS_PATH in
      // the console for review without paging; neither directly permits an unsigned
      // transition here.
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
