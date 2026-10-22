import { testManagementRole } from './treeExclusion.js';
import { listOpenRunsForExecution } from './store.js';

/**
 * THE EXECUTION GUARD — a Test Execution reaches Done only when every run in
 * it is terminal and every failed run has its bug.
 *
 * Spec, "Run sign-off": Done means "every run in this execution is terminal",
 * nothing more. The guard is one more check inside va-gate, judged on the
 * destination's status category, not its name. It holds only where va-gate
 * runs, so enabling test management refuses an Execution workflow with a
 * transition into Done that lacks it (usecases/testManagementAdmin.js).
 *
 * Returns { open: [...] } listing what holds the execution, { open: [] } when
 * nothing does, or null when this issue is not a test execution or the
 * transition does not go to Done.
 */
export const TERMINAL_RUN_STATES = new Set(['SIGNED', 'REJECTED', 'NOT_EXECUTED']);

export function openItems(runs, bugs) {
  const bugByRun = new Map(bugs.map(b => [b.runId, b]));
  const open = [];
  for (const run of runs) {
    if (run.proofProblem) { open.push({ runId: run.runId, reason: 'RUN_PROOF_INVALID', state: run.state }); continue; }
    if (!TERMINAL_RUN_STATES.has(run.state)) { open.push({ runId: run.runId, reason: 'RUN_NOT_TERMINAL', state: run.state }); continue; }
    if (run.state === 'SIGNED' && run.result === 'FAILED' && bugByRun.get(run.runId)?.state !== 'CREATED') {
      open.push({ runId: run.runId, reason: bugByRun.get(run.runId)?.state === 'NEEDS_REPAIR' ? 'BUG_NEEDS_REPAIR' : 'BUG_PENDING' });
    }
  }
  return open;
}

export async function executionGuard({ issue, readStatusCategory }, deps = {}) {
  const role = await (deps.testManagementRole ?? testManagementRole)(issue, { bugs: false });
  if (role?.role !== 'EXECUTION') return null;
  // Read only for an execution: every other transition pays nothing for this guard.
  if (String(await readStatusCategory() ?? '').toLowerCase() !== 'done') return null;
  // Only the runs that hold it, found in SQL however many runs the execution
  // has: the panel's run list is bounded, and the guard must not be.
  const open = await (deps.listOpenRunsForExecution ?? listOpenRunsForExecution)(issue.id);
  const bugs = open.filter(r => r.bugState).map(r => ({ runId: r.runId, state: r.bugState }));
  return { open: openItems(open, bugs) };
}

export function guardMessage(open) {
  const runs = open.filter(o => ['RUN_NOT_TERMINAL', 'RUN_PROOF_INVALID'].includes(o.reason)).length;
  const bugs = open.length - runs;
  const parts = [];
  if (runs) parts.push(`${runs} test run${runs === 1 ? ' is' : 's are'} not finished (signed, rejected or closed as not executed)`);
  if (bugs) parts.push(`${bugs} failed run${bugs === 1 ? ' is' : 's are'} still waiting for ${bugs === 1 ? 'its' : 'their'} bug`);
  return `This test execution cannot be completed: ${parts.join(', and ')}. Open the Test management panel on this execution.`;
}
