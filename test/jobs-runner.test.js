import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('scheduler executes every control and isolates thrown and returned failures', async () => {
  assert.equal(existsSync(new URL('../src/jobs/runner.js', import.meta.url)), true, 'scheduler must be implemented');
  const runner = await import('../src/jobs/runner.js');
  const calls = [];
  const names = ['migrate','alerts','reconcile','gatecheck','vaultBackfill','rehash','verify','seal','directoryReconcile','devicecheck','prune'];
  const jobs = Object.fromEntries(names.map(name => [name, async () => {
    calls.push(name);
    if (name === 'reconcile') throw new Error('Jira unavailable');
    if (name === 'verify') return {ok:false,reason:'CHAIN_BROKEN'};
    return {ok:true};
  }]));
  await runner.runFiveMinute({}, {jobs});
  const hourly = await runner.runHourly({}, {jobs});
  const daily = await runner.runDaily({}, {jobs});
  assert.deepEqual(calls,names);
  assert.equal(hourly[0].ok,false);
  assert.equal(hourly[1].ok,true);
  assert.equal(daily[0].ok,false);
  assert.equal(daily[1].job,'seal');
});

// The tracked set is what an administrator chose on the Controlled fields page —
// never widened on a schedule behind their back.
test('no scheduled job adopts fields into the tracked set', async () => {
  const runner = await import('../src/jobs/runner.js');
  const calls = [];
  const jobs = new Proxy({}, { get: (_t, name) => async () => { calls.push(name); return { ok: true }; } });
  await runner.runFiveMinute({}, { jobs });
  await runner.runHourly({}, { jobs });
  await runner.runDaily({}, { jobs });
  assert.ok(!calls.includes('adoptFields'));
  assert.equal(existsSync(new URL('../src/jobs/adoptFields.js', import.meta.url)), false);
});

// Forge kills a scheduled function at 55 seconds. Two unbounded sweeps ran
// first, so on a site with many governed trees the hourly run died every hour
// and gatecheck — the check that controlled transitions are still enforced —
// never ran at all.
test('the hourly run bounds both sweeps and runs the enforcement checks between them', async () => {
  const runner = await import('../src/jobs/runner.js');
  const seen = [];
  const jobs = new Proxy({}, { get: (_t, name) => async (options = {}) => { seen.push([name, options.deadline]); return { ok: true }; } });
  await runner.runHourly({}, { jobs, now: () => 1000 });
  assert.deepEqual(seen.map(([name]) => name), ['reconcile', 'gatecheck', 'vaultBackfill', 'rehash']);
  const deadline = Object.fromEntries(seen);
  assert.ok(deadline.reconcile > 1000 && deadline.reconcile < deadline.rehash);
  assert.ok(deadline.rehash <= 1000 + 45000);
});

test('a job that does not complete is logged with what it returned', async () => {
  const runner = await import('../src/jobs/runner.js');
  const errors = []; const original = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    await runner.runFiveMinute({}, { jobs: { migrate: async () => ({ ok: false, failedAt: 'v050_x' }), alerts: async () => ({ ok: true }) } });
  } finally { console.error = original; }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /migrate/);
  assert.match(errors[0], /v050_x/);
});
