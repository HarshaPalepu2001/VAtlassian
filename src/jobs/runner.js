/** Independent failures must never prevent the other scheduled controls running.
 * Imports are lazy so a broken dependency also stays isolated to its own job.
 */
const jobs = {
  migrate: () => import('./migrate.js').then(m => m.run()),
  alerts: () => import('./alerts.js').then(m => m.run()),
  adoptFields: () => import('./adoptFields.js').then(m => m.run()),
  reconcile: () => import('./reconcile.js').then(m => m.run()),
  rehash: () => import('./rehash.js').then(m => m.run()),
  gatecheck: () => import('./gatecheck.js').then(m => m.run()),
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
    return { ...result, job: name, ok: result?.ok !== false && result?.success !== false };
  } catch (error) {
    console.error(`runner: ${name} failed`, error);
    return {job: name, ok: false, error: String(error?.message ?? error), elapsedMs: Date.now() - started};
  }
}

async function runList(names, implementations) {
  const results = [];
  for (const name of names) results.push(await safely(name, implementations[name]));
  return results;
}

export function runFiveMinute(_request, { jobs: implementations = jobs } = {}) {
  return runList(['migrate', 'alerts'], implementations);
}

// Field adoption must finish before either collector measures the tracked set.
export function runHourly(_request, { jobs: implementations = jobs } = {}) {
  return runList(['adoptFields', 'reconcile', 'rehash', 'gatecheck'], implementations);
}

export function runDaily(_request, { jobs: implementations = jobs } = {}) {
  return runList(['verify', 'seal', 'directoryReconcile', 'devicecheck', 'prune'], implementations);
}
