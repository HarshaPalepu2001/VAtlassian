import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('scheduler executes every control, isolates thrown and returned failures, and adopts before collection', async () => {
  assert.equal(existsSync(new URL('../src/jobs/runner.js', import.meta.url)), true, 'scheduler must be implemented');
  const runner = await import('../src/jobs/runner.js');
  const calls = [];
  const names = ['migrate','alerts','adoptFields','reconcile','rehash','gatecheck','vaultBackfill','verify','seal','directoryReconcile','devicecheck','prune'];
  const jobs = Object.fromEntries(names.map(name => [name, async () => {
    calls.push(name);
    if (name === 'adoptFields') throw new Error('field catalogue unavailable');
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
