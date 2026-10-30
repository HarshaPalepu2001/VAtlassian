/**
 * Compare configured controls with Jira's workflow validators.
 *
 * src/gate.js enforces signatures and drift holds only while Jira calls it.
 * If an administrator detaches va-gate, transitions can succeed unsigned while
 * va_controlled_transition and the admin console still describe them as
 * controlled. The removed validator cannot detect or log its own absence.
 * This module compares workflow data; jobs/gatecheck.js schedules the checks.
 *
 * The checks provide dated evidence for workflow configuration review and
 * change control under 21 CFR 11.10(f), 11.10(a) and 11.10(k)(2). They supplement
 * the customer's validated workflow procedures. Jira's workflow history expires
 * after 60 days, so the app retains its own findings.
 *
 * All functions are pure. Inputs are controlled-transition rows, workflow data,
 * and the project/issue-type pair when baselines exist without remaining rows.
 * The scheduled job owns Jira requests and persistence.
 */

export const FINDING = {
  /** An ACTIVE controlled transition whose edge carries no va-gate at all.
   *  Transitions across this edge are succeeding unsigned, right now. */
  GATE_ABSENT: 'GATE_ABSENT',

  /**
 * va-gate is attached but disabled. Report separately from an absent gate
 * so the administrator can identify how enforcement was removed.
 */
  GATE_DISABLED: 'GATE_DISABLED',

  /**
 * A transition reaches a controlled status without an ACTIVE row requiring
 * a signature. Report a warning, not a failure: the administrator may have
 * intentionally controlled only one incoming transition, even with va-gate on both.
 */
  GATE_BYPASS_PATH: 'GATE_BYPASS_PATH',

  /** An ACTIVE row naming an edge the workflow no longer has. Nothing crosses
   *  it, but the admin console shows a control over an edge that cannot be
   *  taken. */
  GATE_ORPHANED: 'GATE_ORPHANED',

  /** A transition no controlled row covers that does not carry an enabled
   *  va-gate. va-gate belongs on EVERY transition, because it is also what
   *  holds a drifted work item still, so a work item with unreviewed changes
   *  can change status across this one right now. */
  HOLD_ABSENT: 'HOLD_ABSENT',

  /**
 * va-gate names a different transition from the one carrying it, commonly
 * after copying a transition in the workflow editor. The saved ID can make the
 * validator mistake this transition for its sibling.
 */
  GATE_CONFIG_MISMATCH: 'GATE_CONFIG_MISMATCH',

  /** va-gate on a transition that shares its start and destination with a
   *  sibling, and whose configuration has no saved transition id (attached
   *  before the setup screen recorded one). Jira's payload cannot tell the
   *  siblings apart, so a move without a signature on the screen fails closed on
   *  both. Opening and saving the validator once fixes it. */
  GATE_CONFIG_MISSING: 'GATE_CONFIG_MISSING'
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
  [FINDING.HOLD_ABSENT]: SEVERITY.CRITICAL,
  [FINDING.GATE_CONFIG_MISMATCH]: SEVERITY.CRITICAL,
  [FINDING.GATE_CONFIG_MISSING]: SEVERITY.WARNING
};

export const ANY_STATUS = '*';

/**
 * Identify this app's gate validator.
 *
 * Both expression- and function-based Forge validators use ruleKey
 * forge:expression-validator. A live check on 2026-08-31 confirmed that key for
 * va-gate declared with function: gate. Do not assume a separate function key.
 *
 * Match appId and moduleKey in parameters.key's ARI:
 * ari:cloud:ecosystem::extension/{appId}/{environmentId}/static/{moduleKey}.
 * Ignore environmentId so staging deployments of this app are recognized.
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
 * Check whether a transition can implement a controlled row.
 *
 * It must reach the target status, not be INITIAL and be able to start at the
 * row's origin. ANY_STATUS accepts any origin; linked transitions must name it;
 * GLOBAL transitions can start at every status in the workflow.
 *
 * Check GLOBAL transitions even without links. Otherwise an ungated global
 * transition could bypass the controlled route into the signed status.
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
 * Compare ACTIVE controlled rows for one project/issue-type pair with its
 * expanded bulk-get workflow. Return findings with stable keys for deduplication.
 *
 * Check every non-initial transition for va-gate, including transitions without
 * a controlled row: drift holds still require the validator on those routes.
 *
 * If all controlled rows were deleted but baselines remain, scope names the
 * pair to keep checking. Emit HOLD_ABSENT for missing or disabled validators,
 * not GATE_ABSENT or GATE_BYPASS_PATH. HOLD_ABSENT keys are independent of rows,
 * so an existing finding retains its first_seen_at after row deletion. With
 * neither rows nor scope, there is no pair to attribute and no findings return.
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
    findings.push(...savedIdFindings(workflow, pair, { appId, moduleKey }));
    return findings;
  }

  // --- Rows that should be enforced, and are not -------------------------
  for (const row of rows) {
    const relevant = transitions.filter((t) => transitionCovers(t, row));

    if (relevant.length === 0) {
      // The configured edge no longer exists in the workflow. It cannot permit a
      // transition, but the admin console still needs to report the obsolete control.
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

  findings.push(...savedIdFindings(workflow, pair, { appId, moduleKey }));
  return findings;
}

/** The transition id va-gate's setup screen saved into its configuration, or
 *  null. Jira returns the configuration as a JSON string under `parameters.config`. */
export function savedTransitionId(validator) {
  let config = validator?.parameters?.config;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { return null; } }
  const id = config && typeof config === 'object' ? config.transitionId : null;
  return id == null || String(id) === '' ? null : String(id);
}

/** Can these two transitions start from the same status? A GLOBAL transition
 *  starts from any status. */
function shareStart(a, b) {
  if (a.type === 'GLOBAL' || b.type === 'GLOBAL') return true;
  const from = new Set((a.links ?? []).map((l) => l.fromStatusReference));
  return (b.links ?? []).some((l) => from.has(l.fromStatusReference));
}

/**
 * Is each enabled va-gate's saved transition id right, and present where it matters?
 *
 * The validator uses the saved id to tell apart transitions Jira's payload
 * cannot (it carries statuses, never a transition id). A saved id naming
 * another transition is CRITICAL: the validator could treat this transition as
 * that one. A missing id is only worth reporting where a sibling shares this
 * transition's start and destination, because nowhere else does it change
 * anything.
 */
function savedIdFindings(workflow, pair, { appId, moduleKey }) {
  const findings = [];
  const transitions = (workflow.transitions ?? []).filter((t) => t.type !== 'INITIAL');
  for (const transition of transitions) {
    const ours = (transition.validators ?? []).filter((v) => isOurGate(v, { appId, moduleKey }) && !isDisabled(v));
    if (ours.length === 0) continue;
    const saved = ours.map(savedTransitionId);
    const wrong = saved.find((id) => id != null && id !== String(transition.id));
    if (wrong != null) {
      findings.push(make(FINDING.GATE_CONFIG_MISMATCH, pair, {
        workflowId: workflow.id,
        transitionId: transition.id,
        detail: `The VAtlassian validator on "${transition.name}" in "${workflow.name}" was set up for transition ${wrong}, not ${transition.id}, usually because the transition was copied. Open the validator on this transition and save it again.`
      }));
      continue;
    }
    const hasSibling = transitions.some((other) => other.id !== transition.id
      && other.toStatusReference === transition.toStatusReference && shareStart(transition, other));
    if (hasSibling && saved.every((id) => id == null)) {
      findings.push(make(FINDING.GATE_CONFIG_MISSING, pair, {
        workflowId: workflow.id,
        transitionId: transition.id,
        detail: `"${transition.name}" in "${workflow.name}" shares its start and destination with another transition, and its VAtlassian validator has not recorded which transition it is on. Until it does, a move without a signature on the screen is refused on both. Open the validator on this transition and save it once.`
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

/**
 * Group ACTIVE rows by project and issue type for bulk-get requests. Read one
 * pair per call because responses do not map workflows back to input pairs.
 * A live check returned one unattributed workflow for four issue types.
 */
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
