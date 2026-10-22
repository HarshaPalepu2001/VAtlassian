import { tmFail } from './messages.js';

export const SOURCE_LINK_JOB_BUDGET_MS = 45_000;
export const SOURCE_LINK_JOB_MAX_INTENTS = 2;
export const SOURCE_LINK_JOB_MAX_WRITES = 10;
const runtime = () => import('./runtime.js').then(module => module.testManagementRuntime());
const bound = (value, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1) tmFail('INVALID_INPUT');
  return Math.min(value, maximum);
};

/**
 * Recover signed source-link intents through the same protected synchronizer
 * used by authoring. One invocation considers at most two versions; both share
 * the scheduler's original deadline. A deferred/blocked row is never reported
 * as a committed native projection.
 */
export async function run({ deadline: requestedDeadline = null, maxIntents = SOURCE_LINK_JOB_MAX_INTENTS,
  maxWrites = SOURCE_LINK_JOB_MAX_WRITES } = {}, { runtime: loadRuntime = runtime, clock = Date.now } = {}) {
  const started = clock();
  if (!Number.isFinite(started) || requestedDeadline != null && !Number.isFinite(requestedDeadline)) tmFail('INVALID_INPUT');
  const deadline = Math.min(requestedDeadline ?? started + SOURCE_LINK_JOB_BUDGET_MS, started + SOURCE_LINK_JOB_BUDGET_MS);
  const batch = bound(maxIntents, SOURCE_LINK_JOB_MAX_INTENTS);
  const writes = bound(maxWrites, SOURCE_LINK_JOB_MAX_WRITES);
  const result = { ok: true, examined: 0, committed: 0, superseded: 0, blocked: 0, pending: 0, errors: 0,
    deferred: 0, stopped: null, failures: [], elapsedMs: 0 };
  const finish = () => ({ ...result, ok: result.errors === 0, elapsedMs: Math.max(0, clock() - started) });
  if (clock() >= deadline) { result.stopped = 'DEADLINE'; return finish(); }
  const deps = await loadRuntime();
  if (clock() >= deadline) { result.stopped = 'DEADLINE'; return finish(); }
  const queued = await deps.pendingSourceLinkIntents(batch);
  if (!Array.isArray(queued) || queued.some(id => !/^[a-f0-9]{32}$/.test(String(id)))) tmFail('SERVICE_UNAVAILABLE');
  const unique = [...new Set(queued)];
  const selected = unique.slice(0, batch);
  result.deferred = unique.length - selected.length;
  if (result.deferred) result.stopped = 'BATCH_LIMIT';
  for (let i = 0; i < selected.length; i++) {
    if (clock() >= deadline) {
      result.deferred += selected.length - i; result.stopped = 'DEADLINE'; break;
    }
    const versionId = selected[i]; result.examined++;
    try {
      const row = await deps.syncSourceLinks(versionId, { deadline, maxWrites: writes });
      if (!row || !['COMMITTED', 'SUPERSEDED', 'BLOCKED', 'PENDING'].includes(row.state)) tmFail('SOURCE_LINK_PROOF_UNAVAILABLE');
      if (row.state === 'COMMITTED' && (!Number.isSafeInteger(row.proof?.seq) || row.proof.seq < 1 || !/^[a-f0-9]{64}$/.test(row.proof?.entryHash ?? ''))) tmFail('SOURCE_LINK_PROOF_UNAVAILABLE');
      const category = { COMMITTED: 'committed', SUPERSEDED: 'superseded', BLOCKED: 'blocked', PENDING: 'pending' }[row.state];
      result[category]++;
    } catch (error) {
      result.errors++;
      result.failures.push({ versionId, reason: error?.reason ?? 'SERVICE_UNAVAILABLE' });
    }
  }
  return finish();
}

export const handler = run;
