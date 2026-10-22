import test from 'node:test';
import assert from 'node:assert/strict';
import { runFiveMinute } from '../src/jobs/runner.js';

test('the five-minute runner schedules native source recovery after migration and alerts within its original 45-second deadline', async () => {
  let time = 1000; const calls = [];
  const jobs = {
    migrate: async () => { calls.push('migrate'); time += 3000; return { ok: true }; },
    alerts: async () => { calls.push('alerts'); time += 2000; return { ok: true }; },
    sourceLinks: async options => { calls.push('sourceLinks'); assert.equal(options.deadline, 46000); assert.equal(options.maxIntents, 2); assert.equal(options.maxWrites, 10); return { ok: true, examined: 2 }; }
  };
  const results = await runFiveMinute({}, { jobs, now: () => time });
  assert.deepEqual(calls, ['migrate', 'alerts', 'sourceLinks']); assert.equal(results[2].job, 'sourceLinks');
});

test('source-link scheduled recovery stays isolated from returned migration failure', async () => {
  const calls = [];
  const original = console.error; console.error = () => {};
  try {
    const result = await runFiveMinute({}, { now: () => 1000, jobs: { migrate: async () => ({ ok: false }), alerts: async () => { calls.push('alerts'); return { ok: true }; },
      sourceLinks: async () => { calls.push('sourceLinks'); return { ok: false, errors: 1 }; } } });
    assert.deepEqual(calls, ['alerts', 'sourceLinks']); assert.equal(result[2].ok, false);
  } finally { console.error = original; }
});
