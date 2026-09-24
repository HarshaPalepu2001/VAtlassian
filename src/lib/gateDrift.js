/**
 * GATE DRIFT — comparing what we believe is controlled against what Jira is
 * actually enforcing.
 *
 * THE HOLE THIS EXISTS TO CLOSE. src/gate.js is an operational system check
 * under 21 CFR 11.10(f): it refuses a transition without a valid signature, and
 * it fails closed on every error path. But it only runs if an administrator has
 * attached the va-gate validator to the transition in Jira. Detach it and
 * nothing of ours executes — Jira never calls us, so we cannot refuse, cannot
 * log, and cannot know. Meanwhile va_controlled_transition still says the edge
 * is controlled and the admin console still renders it as configured. The
 * transition then succeeds unsigned, indefinitely, and every surface we own
 * reports that it did not.
 *
 * That is the one failure mode in this app that produces a SILENT PERMIT, and
 * it is unreachable by any amount of fail-closed design at the gate, because
 * the gate is what was removed. Detection is the only available control. This
 * module is the comparison; jobs/gatecheck.js runs it on a schedule.
 *
 * WHY THAT IS STILL WORTH SHIPPING. Part 11 has never required controls to be
 * un-removable — 11.10(f) requires them to be in place, 11.10(a) requires the
 * system to be validated, and 11.10(k)(2) requires change control over the
 * configuration. A customer can satisfy that procedurally by putting the Jira
 * workflow inside their validated state. What they cannot easily do is EVIDENCE
 * it: at audit they are asserting from memory that nobody detached anything in
 * the last eighteen months, and Jira itself cannot help, because its workflow
 * history expires after 60 days. A dated, continuous record from us converts a
 * procedural burden they must defend into a detective control we supply.
 *
 * PURE ON PURPOSE. Everything here is a function of (rows, workflow), plus the
 * pair being judged when a pair has baselines but no rows left. No Jira
 * client, no database, no clock. The job does the I/O; this does the judgement,
 * so the judgement can be tested exhaustively without either.
 */

export const FINDING = {
  /** An ACTIVE controlled transition whose edge carries no va-gate at all.
   *  Transitions across this edge are succeeding unsigned, right now. */
  GATE_ABSENT: 'GATE_ABSENT',

  /** va-gate is attached but switched off. Identical effect to absent, but a
   *  different admin conversation — someone disabled it deliberately. */
  GATE_DISABLED: 'GATE_DISABLED',

  /** A transition into a controlled status that no ACTIVE row covers — a
   *  second door into a status we are policing, crossed without a signature
   *  whether or not it carries va-gate. Often legitimate (the admin chose to
   *  control one edge only), so it is reported as a warning to be reviewed,
   *  not as a failure. */
  GATE_BYPASS_PATH: 'GATE_BYPASS_PATH',

  /** An ACTIVE row naming an edge the workflow no longer has. Nothing crosses
   *  it, but the admin console shows a control over an edge that cannot be
   *  taken. */
  GATE_ORPHANED: 'GATE_ORPHANED',

  /** A transition no controlled row covers that does not carry an enabled
   *  va-gate. va-gate belongs on EVERY transition, because it is also what
   *  holds a drifted work item still, so a work item with unreviewed changes
   *  can change status across this one right now. */
  HOLD_ABSENT: 'HOLD_ABSENT'
};

export const SEVERITY = {
  /** Signatures are not being collected where we claim they are. */
  CRITICAL: 'CRITICAL',
  /** Nothing is being let through unsigned; someone is stuck or exposed. */
  WARNING: 'WARNING'
};

const SEVERITY_OF = {
  [FINDING.GATE_ABSENT]: SEVERITY.CRITICAL,
  [FINDING.GATE_DISABLED]: SEVERITY.CRITICAL,
  [FINDING.GATE_BYPASS_PATH]: SEVERITY.WARNING,
  [FINDING.GATE_ORPHANED]: SEVERITY.WARNING,
  [FINDING.HOLD_ABSENT]: SEVERITY.CRITICAL
};

export const ANY_STATUS = '*';

/**
 * Is this validator OUR gate?
 *
 * Both expression-based and function-based Forge validators report under the
 * ruleKey `forge:expression-validator` — confirmed against a live instance on
 * 2026-08-31, where va-gate is declared with `function: gate` and still
 * appears under that key. Do not narrow this to a "function validator" rule
 * key on the assumption that one exists; it does not, and narrowing it would
 * make this module blind to precisely the rule it is looking for.
 *
 * Identity comes from the ARI in `parameters.key`, which has the shape
 * `ari:cloud:ecosystem::extension/{appId}/{environmentId}/static/{moduleKey}`.
 * We match on appId AND moduleKey and deliberately ignore environmentId, so a
 * finding is not raised against a staging deployment of ourselves.
 */
export function isOurGate(validator, { appId, moduleKey = 'va-gate' } = {}) {
  if (!validator || typeof validator.ruleKey !== 'string') return false;
  if (!validator.ruleKey.startsWith('forge:')) return false;
  const key = validator.parameters?.key;
  if (typeof key !== 'string') return false;
  return key.includes(`/${appId}/`) && key.endsWith(`/${moduleKey}`);
}

/** Jira omits `disabled` entirely when a rule is enabled, and sends it as the
 *  STRING "true" when it is not. Neither a missing key nor a boolean. */
export function isDisabled(validator) {
  const flag = validator?.parameters?.disabled;
  return flag === true || flag === 'true';
}

/**
 * Could this transition realise this controlled edge?
 *
 * Three things make a transition relevant to a controlled row:
 *   - it lands on the controlled target status;
 *   - it is not INITIAL — issue creation has no from-status, so a controlled
 *     edge never describes it;
 *   - and it can start where the row says, which is true when the row uses the
 *     ANY_STATUS wildcard, when a link starts at the named status, or when the
 *     transition is GLOBAL.
 *
 * GLOBAL IS THE ONE THAT MATTERS. A global transition can be taken from any
 * status in the workflow, so it can always reach the controlled target from the
 * controlled origin. It therefore requires a gate whatever the row's
 * from-status says. A comparison that only walked `links` would declare a
 * workflow clean while an ungated global transition sat there offering a route
 * into the signed status from anywhere — the exact bypass this is meant to find.
 */
export function transitionCovers(transition, row) {
  if (!transition || transition.type === 'INITIAL') return false;
  if (transition.toStatusReference !== row.to_status_id) return false;
  if (transition.type === 'GLOBAL') return true;
  if (row.from_status_id === ANY_STATUS) return true;
  return (transition.links ?? []).some(
    (link) => link.fromStatusReference === row.from_status_id
  );
}

function ctKey(row) {
  return `${row.project_id}:${row.issue_type_id}:${row.from_status_id}:${row.to_status_id}`;
}

/**
 * Compare one project + issue type's controlled rows against the workflow Jira
 * actually serves for that pair.
 *
 * `rows` must already be filtered to ACTIVE and to this pair. `workflow` is a
 * workflow from the bulk-get response, with transitions expanded. Returns a
 * flat list of findings, each carrying a stable `key` so repeat runs update an
 * existing finding rather than piling up duplicates.
 *
 * Every non-initial transition is judged, not only the ones a row covers:
 * va-gate is attached to all of them, because besides asking for a signature
 * where a row says so, it is what holds a drifted work item still.
 *
 * A PAIR WITH NO ROWS IS STILL JUDGED WHEN IT HAS BASELINES. Deleting every
 * controlled transition for a project and issue type does not release the
 * baselined work items there: they are still held on drift, and the only thing
 * holding them is va-gate. That is exactly the moment a check driven by rows
 * alone would stop looking. So `scope` ({ project_id, issue_type_id }, an entry
 * from gatecheck's pairsToCheck is fine) names the pair when `rows` is empty,
 * and then every non-initial transition without an enabled va-gate is a
 * HOLD_ABSENT against that pair. Nothing is controlled, so there is no
 * GATE_ABSENT and no GATE_BYPASS_PATH to raise. The key a HOLD_ABSENT carries
 * does not depend on the rows, so a finding open before the rows were deleted
 * stays the same finding afterwards, first_seen_at and all. With no rows and no
 * scope there is no pair to attribute a finding to, and nothing is returned.
 */
export function diffWorkflow({ rows = [], workflow, appId, moduleKey = 'va-gate', scope = null }) {
  const findings = [];
  if (!workflow) return findings;

  const transitions = workflow.transitions ?? [];
  const workflowId = workflow.id;

  if (rows.length === 0) {
    const pair = pairOf(scope);
    if (!pair) return findings;
    for (const transition of transitions) {
      if (transition.type === 'INITIAL') continue;
      const hold = holdAbsent(transition, workflow, pair, { appId, moduleKey });
      if (hold) findings.push(hold);
    }
    return findings;
  }

  // --- Rows that should be enforced, and are not -------------------------
  for (const row of rows) {
    const relevant = transitions.filter((t) => transitionCovers(t, row));

    if (relevant.length === 0) {
      // The row names an edge this workflow does not have. Not a silent
      // permit — there is no transition to permit anything — but the row is
      // describing a workflow that has moved on, and the admin console is
      // showing a control over an edge that cannot be taken.
      findings.push(make(FINDING.GATE_ORPHANED, row, {
        workflowId,
        transitionId: null,
        detail: `No transition in "${workflow.name}" runs ${row.from_status_id} -> ${row.to_status_id}. The controlled transition describes an edge this workflow no longer has.`
      }));
      continue;
    }

    for (const transition of relevant) {
      const ours = (transition.validators ?? []).filter((v) => isOurGate(v, { appId, moduleKey }));

      if (ours.length === 0) {
        findings.push(make(FINDING.GATE_ABSENT, row, {
          workflowId,
          transitionId: transition.id,
          detail: `Transition "${transition.name}" in "${workflow.name}" carries no signature gate. Work items are crossing this edge unsigned.`
        }));
        continue;
      }

      // A rule can be attached and switched off. Same effect, different cause.
      if (ours.every(isDisabled)) {
        findings.push(make(FINDING.GATE_DISABLED, row, {
          workflowId,
          transitionId: transition.id,
          detail: `The signature gate on "${transition.name}" in "${workflow.name}" is attached but disabled. Work items are crossing this edge unsigned.`
        }));
      }
    }
  }

  // --- Transitions no controlled row covers -----------------------------
  //
  // They ask for no signature, but va-gate still belongs on them: it is what
  // holds a drifted work item still, on every transition of the workflow.
  const covered = new Set();
  for (const row of rows) {
    for (const t of transitions) if (transitionCovers(t, row)) covered.add(t.id);
  }
  const controlledTargets = new Set(rows.map((r) => r.to_status_id));
  const pair = { project_id: rows[0]?.project_id, issue_type_id: rows[0]?.issue_type_id };

  for (const transition of transitions) {
    if (transition.type === 'INITIAL' || covered.has(transition.id)) continue;
    const hold = holdAbsent(transition, workflow, pair, { appId, moduleKey });
    if (hold) findings.push(hold);

    // A second route into a status we are policing, crossed unsigned.
    if (controlledTargets.has(transition.toStatusReference)) {
      findings.push(make(FINDING.GATE_BYPASS_PATH, pair, {
        workflowId,
        transitionId: transition.id,
        detail: `Transition "${transition.name}" also reaches ${transition.toStatusReference}, which is a controlled status, but no controlled transition covers it, so it asks for no signature. Confirm this route is meant to be open.`
      }));
    }
  }

  return findings;
}

/** The HOLD_ABSENT finding for a transition that does not carry an enabled
 *  va-gate, or null when it does. Shared by the with-rows and the
 *  baselines-only paths so both word and key the finding identically. */
function holdAbsent(transition, workflow, pair, { appId, moduleKey }) {
  const ours = (transition.validators ?? []).filter((v) => isOurGate(v, { appId, moduleKey }));
  if (ours.length > 0 && !ours.every(isDisabled)) return null;
  return make(FINDING.HOLD_ABSENT, pair, {
    workflowId: workflow.id,
    transitionId: transition.id,
    detail: ours.length === 0
      ? `Transition "${transition.name}" in "${workflow.name}" does not carry the VAtlassian validator. A work item with unreviewed changes can still change status across it.`
      : `The VAtlassian validator on "${transition.name}" in "${workflow.name}" is attached but disabled. A work item with unreviewed changes can still change status across it.`
  });
}

/** Normalise a scope to { project_id, issue_type_id }, accepting the camelCase
 *  names groupByPair uses too. Null when either half is missing, so a finding
 *  key can never be minted with "undefined" in it. */
function pairOf(scope) {
  const project_id = scope?.project_id ?? scope?.projectId;
  const issue_type_id = scope?.issue_type_id ?? scope?.issueTypeId;
  if (project_id == null || issue_type_id == null) return null;
  return { project_id, issue_type_id };
}

function make(type, row, { workflowId, transitionId, detail }) {
  const scope = row
    ? `${row.project_id}:${row.issue_type_id}`
    : 'unknown';
  return {
    // Stable across runs so an unresolved finding keeps its first_seen_at and
    // an operator sees "open for 9 days" rather than a fresh row every hour.
    key: `${type}:${scope}:${workflowId ?? '-'}:${transitionId ?? '-'}:${row?.from_status_id != null ? `${row.from_status_id}>${row.to_status_id}` : '-'}`,
    type,
    severity: SEVERITY_OF[type],
    projectId: row?.project_id ?? null,
    issueTypeId: row?.issue_type_id ?? null,
    workflowId: workflowId ?? null,
    transitionId: transitionId ?? null,
    ctId: row?.ct_id ?? null,
    fromStatusId: row?.from_status_id ?? null,
    toStatusId: row?.to_status_id ?? null,
    detail
  };
}

/** Group ACTIVE controlled transitions into the (project, issue type) pairs the
 *  bulk-get endpoint is queried by. One pair per call: a call carrying several
 *  pairs returns a set of workflows with nothing mapping them back to the pair
 *  that produced each one — verified against a live instance, where four issue
 *  types collapsed into a single unattributed workflow. */
export function groupByPair(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.project_id}:${row.issue_type_id}`;
    if (!groups.has(key)) {
      groups.set(key, { projectId: row.project_id, issueTypeId: row.issue_type_id, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

export { ctKey };
