import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Replace the remote SQL transport only; executeQuery itself stays real.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/sql') return { url: 'db-timing:sql', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'db-timing:sql') return {
      format: 'module', shortCircuit: true,
      source: `export const sql = { prepare(statement) { return { bindParams(...params) { return {
        async execute() { return globalThis.vaDbTimingQuery(statement, params); }
      }; } }; } };`
    };
    return next(url, context);
  }
});
const { executeQuery, SLOW_QUERY_MS } = await import('../src/lib/db.js');
hooks.deregister();

test('executeQuery measures and returns durationMs for a successful query', async () => {
  globalThis.vaDbTimingQuery = async () => {
    await new Promise(r => setTimeout(r, 10));
    return { rows: [{ n: 1 }], metadata: {} };
  };
  const res = await executeQuery('SELECT 1');
  assert.equal(res.result, true);
  assert.equal(typeof res.durationMs, 'number');
  assert.ok(res.durationMs >= 10, `expected durationMs >= 10, got ${res.durationMs}`);
});

test('executeQuery returns durationMs on a failed query too', async () => {
  globalThis.vaDbTimingQuery = async () => { throw new Error('boom'); };
  const originalError = console.error;
  console.error = () => {};
  let res;
  try {
    res = await executeQuery('SELECT 1');
  } finally {
    console.error = originalError;
  }
  assert.equal(res.result, false);
  assert.equal(typeof res.durationMs, 'number');
});

test('SLOW_QUERY_MS is a positive, platform-timeout-relative constant', () => {
  assert.equal(typeof SLOW_QUERY_MS, 'number');
  assert.ok(SLOW_QUERY_MS > 0 && SLOW_QUERY_MS < 5000, 'must sit meaningfully under the 5s SELECT timeout');
});

test('a query under the slow-query threshold logs a plain duration line, not an alert', async () => {
  const warnings = [];
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnings.push(args);
  console.log = (...args) => logs.push(args);
  try {
    globalThis.vaDbTimingQuery = async () => ({ rows: [], metadata: {} });
    await executeQuery('SELECT 1', [], { slowQueryMs: 10_000 });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  assert.equal(warnings.length, 0, 'no SLOW_QUERY_ALERT for a fast query');
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'Forge SQL query');
  const payload = JSON.parse(logs[0][1]);
  assert.equal(payload.operation, 'SELECT');
  assert.equal(payload.succeeded, true);
  assert.equal(typeof payload.durationMs, 'number');
});

test('a query over the slow-query threshold logs a distinguishable SLOW_QUERY_ALERT line, redacted', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    globalThis.vaDbTimingQuery = async () => {
      await new Promise(r => setTimeout(r, 5));
      return { rows: [], metadata: {} };
    };
    await executeQuery("SELECT * FROM va_config WHERE cfg_key = 'secret-literal'", [], { slowQueryMs: 1 });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[SLOW_QUERY_ALERT]');
  const payload = JSON.parse(warnings[0][1]);
  assert.equal(payload.operation, 'SELECT');
  assert.deepEqual(payload.tables, ['va_config']);
  assert.equal(payload.thresholdMs, 1);
  assert.ok(payload.durationMs >= 5);
  assert.equal(payload.succeeded, true);
  assert.doesNotMatch(JSON.stringify(payload), /secret-literal/);
});

test('a failing query over the slow-query threshold is also flagged, tagged unsucceeded', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => warnings.push(args);
  console.error = () => {};
  try {
    globalThis.vaDbTimingQuery = async () => {
      await new Promise(r => setTimeout(r, 5));
      throw new Error('ER_LOCK_WAIT_TIMEOUT');
    };
    await executeQuery('UPDATE va_config SET cfg_value = ?', ['x'], { slowQueryMs: 1 });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.equal(warnings.length, 1);
  const payload = JSON.parse(warnings[0][1]);
  assert.equal(payload.succeeded, false);
  assert.equal(payload.operation, 'UPDATE');
});
