import { withRequestCache } from '../lib/cache.js';

/** Independent failures must never prevent the other scheduled controls running.
 * Imports are lazy so a broken dependency also stays isolated to its own job.
 */
const jobs = {
  migrate: () => import('./migrate.js').then(m => m.run()),
  alerts: () => import('./alerts.js').then(m => m.run()),
  sourceLinks: options => import('../testmgmt/sourceLinkJob.js').then(m => m.run(options)),
  reconcile: options => import('./reconcile.js').then(m => m.run(options)),
  rehash: options => import('./rehash.js').then(m => m.run(options)),
  gatecheck: () => import('./gatecheck.js').then(m => m.run()),
  vaultBackfill: () => import('./vaultBackfill.js').then(m => m.run()),
  verify: () => import('./verify.js').then(m => m.run()),
  seal: () => import('./seal.js').then(m => m.run()),
  directoryReconcile: () => import('./directoryReconcile.js').then(m => m.run()),
  devicecheck: () => import('./devicecheck.js').then(m => m.run()),
  prune: () => import('./prune.js').then(m => m.run())
};

export async function safely(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const ok = result?.ok !== false && result?.success !== false;
    // A job that returns rather than throws its failure (a migration stopped at
    // one step, a broken ledger chain) was otherwise invisible in the logs —
    // on a new site the first sign was every page failing.
    if (!ok) console.error(`runner: ${name} did not complete`, JSON.stringify(result));
    return { ...result, job: name, ok };
  } catch (error) {
    console.error(`runner: ${name} failed`, error);
    return {job: name, ok: false, error: String(error?.message ?? error), elapsedMs: Date.now() - started};
  }
}

async function runList(names, implementations, options = {}) {
  const results = [];
  for (const name of names) results.push(await safely(name, () => implementations[name](options[name])));
  return results;
}

/** Forge stops a scheduled function at 55 seconds. */
const SWEEP_BUDGET_MS = { reconcile: 20000, rehash: 40000 };

export function runFiveMinute(_request, { jobs: implementations = jobs, now = Date.now } = {}) {
  const deadline = now() + 45000;
  return withRequestCache(() => runList(['migrate', 'alerts', 'sourceLinks'], implementations, {
    sourceLinks: { deadline, maxIntents: 2, maxWrites: 10 }
  }));
}

/**
 * The two drift sweeps are the expensive part — each reads up to 40 governed
 * trees from Jira — so each gets a deadline, and the checks that controlled
 * transitions are still enforced (gatecheck) and that vaults exist run between
 * them, never after an unbounded read that might use up the time limit.
 */
export function runHourly(_request, { jobs: implementations = jobs, now = Date.now } = {}) {
  const started = now();
  return withRequestCache(() => runList(['reconcile', 'gatecheck', 'vaultBackfill', 'rehash'], implementations, {
    reconcile: { deadline: started + SWEEP_BUDGET_MS.reconcile },
    rehash: { deadline: started + SWEEP_BUDGET_MS.rehash }
  }));
}

export function runDaily(_request, { jobs: implementations = jobs } = {}) {
  return withRequestCache(() => runList(['verify', 'seal', 'directoryReconcile', 'devicecheck', 'prune'], implementations));
}
