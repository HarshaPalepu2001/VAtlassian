import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/jobs/probe.js';

/**
 * The probe answers with app-privileged data about any issue, so its secret
 * travels in a header (never the URL, which proxies, logs and browser history
 * keep) and is compared in constant time. Each request below stops at the
 * guard, before any Jira read.
 */
const SECRET = 'probe-secret-value';

test('the probe refuses its secret in the query string', async () => {
  process.env.PROBE_SECRET = SECRET;
  const result = await handler({ queryParameters: { secret: [SECRET] }, headers: {} });
  assert.equal(result.statusCode, 403);
});

test('the probe refuses a wrong or missing secret header', async () => {
  process.env.PROBE_SECRET = SECRET;
  assert.equal((await handler({ queryParameters: {}, headers: { 'x-probe-secret': ['wrong'] } })).statusCode, 403);
  assert.equal((await handler({ queryParameters: {}, headers: {} })).statusCode, 403);
});

test('the probe accepts its secret header and then asks for an issue', async () => {
  process.env.PROBE_SECRET = SECRET;
  const result = await handler({ queryParameters: {}, headers: { 'x-probe-secret': [SECRET] } });
  assert.equal(result.statusCode, 400);
});

test('an unset probe secret refuses everything', async () => {
  delete process.env.PROBE_SECRET;
  assert.equal((await handler({ queryParameters: {}, headers: { 'x-probe-secret': [''] } })).statusCode, 403);
});
