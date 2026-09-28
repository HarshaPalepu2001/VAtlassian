import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('scheduler executes every control and isolates thrown and returned failures', async () => {
  assert.equal(existsSync(new URL('../src/jobs/runner.js', import.meta.url)), true, 'scheduler must be implemented');
  const runner = await import('../src/jobs/runner.js');
  const calls = [];
  const names = ['migrate','alerts','reconcile','rehash','gatecheck','vaultBackfill','verify','seal','directoryReconcile','devicecheck','prune'];
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
