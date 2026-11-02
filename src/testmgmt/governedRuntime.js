import { createGovernanceStore } from './governanceStore.js';
import { createIntakeStore } from './intakeStore.js';
import { assertIntakeReady } from './intake.js';
import { createObservationStore } from './governanceObservation.js';
import { createCandidateStore, createExecutionCandidates } from './executionCandidate.js';

/** Compose human and machine boundaries; background intake uses only app-scoped Jira reads. */
export async function governedTestRuntime(base) {
  const [{ getAppContext }, { Queue }] = await Promise.all([import('@forge/api'), import('@forge/events')]);
  const installationId = getAppContext().installationAri.toString();
  if (!installationId || installationId === '[object Object]') throw new Error('Installation identity unavailable');
  const queue = new Queue({ key: 'va-ci-intake-queue' });
  const deps = { ...base, ...createGovernanceStore(), ...createIntakeStore(), ...createObservationStore(), ...createCandidateStore(),
    installationId, assertIntakeReady,
    readIntakeExecution: id => base.readIssueAsApp(id),
    enqueueIntake: ({ receiptId }) => queue.push({ body: { receiptId }, concurrency: { key: `ci:${receiptId}`, limit: 1 } }) };
  return { ...deps, ...createExecutionCandidates(deps) };
}
