/**
 * Compute run results from recorded steps on the server.
 *
 * A signer cannot mark a run Passed when its steps disagree. The rules follow
 * the spec's "Result rules" with one explicit choice: PASSED requires every
 * step to have been executed and passed. A run with N/A steps among passes is
 * PARTLY_PASSED.
 *
 * Semantic IDs stay stable. Project-specific display names and colours must
 * not change the meaning of a signed run.
 */

export const STEP = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  NOT_RUN: 'NOT_RUN'
});

export const RESULT = Object.freeze({
  PASSED: 'PASSED',
  PARTLY_PASSED: 'PARTLY_PASSED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  NOT_RUN: 'NOT_RUN',
  IN_PROGRESS: 'IN_PROGRESS'
});

export const STEP_STATUSES = Object.values(STEP);

export function isStepStatus(value) {
  return STEP_STATUSES.includes(String(value ?? ''));
}

/**
 * One iteration's result from its step statuses, in the spec's order of
 * precedence. An iteration with no steps has nothing executed: NOT_RUN.
 */
export function iterationResult(stepStatuses) {
  const statuses = (stepStatuses ?? []).map(s => (isStepStatus(s) ? s : STEP.NOT_RUN));
  if (statuses.length === 0) return RESULT.NOT_RUN;
  if (statuses.includes(STEP.FAILED)) return RESULT.FAILED;
  if (statuses.includes(STEP.BLOCKED)) return RESULT.BLOCKED;
  if (statuses.includes(STEP.NOT_RUN)) {
    // Some steps recorded and some not is a run under way, not one never run.
    return statuses.every(s => s === STEP.NOT_RUN) ? RESULT.NOT_RUN : RESULT.IN_PROGRESS;
  }
  if (statuses.every(s => s === STEP.NOT_APPLICABLE)) return RESULT.NOT_APPLICABLE;
  if (statuses.includes(STEP.NOT_APPLICABLE)) return RESULT.PARTLY_PASSED;
  return RESULT.PASSED;
}

/**
 * A run's result from its iterations. `skipped` marks iterations deliberately
 * skipped with a reason; they make the run PARTLY_PASSED, never PASSED.
 */
export function runResult(iterations) {
  const results = (iterations ?? []).map(it => (it.skipped ? 'SKIPPED' : iterationResult(it.steps)));
  if (results.length === 0) return RESULT.NOT_RUN;
  if (results.includes(RESULT.FAILED)) return RESULT.FAILED;
  if (results.includes(RESULT.BLOCKED)) return RESULT.BLOCKED;
  if (results.includes(RESULT.IN_PROGRESS)) return RESULT.IN_PROGRESS;
  if (results.includes(RESULT.NOT_RUN)) {
    return results.every(r => r === RESULT.NOT_RUN) ? RESULT.NOT_RUN : RESULT.IN_PROGRESS;
  }
  if (results.includes(RESULT.PARTLY_PASSED) || results.includes('SKIPPED')) {
    return results.every(r => r === 'SKIPPED') ? RESULT.NOT_RUN : RESULT.PARTLY_PASSED;
  }
  if (results.every(r => r === RESULT.NOT_APPLICABLE)) return RESULT.NOT_APPLICABLE;
  if (results.includes(RESULT.NOT_APPLICABLE)) return RESULT.PARTLY_PASSED;
  return RESULT.PASSED;
}

/**
 * Why a run cannot be signed yet, or null when it can.
 *
 * Blocked is not final: testing resumes from the blocked step, or the run is
 * closed as Not executed. A step not run makes the run unsignable. An N/A step
 * needs its reason, because the signature covers it.
 */
export function signabilityProblem(steps) {
  const list = steps ?? [];
  if (list.length === 0) return 'NO_STEPS';
  for (const step of list) {
    if (!isStepStatus(step.status) || step.status === STEP.NOT_RUN) return 'STEPS_NOT_RUN';
    if (step.status === STEP.NOT_APPLICABLE && !String(step.comment ?? '').trim()) return 'NA_REASON_REQUIRED';
  }
  const result = iterationResult(list.map(s => s.status));
  if (result === RESULT.BLOCKED) return 'RUN_BLOCKED';
  return null;
}

/** Results that count as terminal outcomes once fully signed. */
export const SIGNABLE_RESULTS = new Set([RESULT.PASSED, RESULT.PARTLY_PASSED, RESULT.FAILED, RESULT.NOT_APPLICABLE]);
