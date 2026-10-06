// modified for Task 5 compliance: recall routing fail-closed behavior

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDependencyBundle, run as updated } from '../src/triggers/issue-updated.js';
import { run as transitioned } from '../src/triggers/issue-transitioned.js';
import { collectAffectedTrees } from '../src/lib/collect.js';
import { retryEvent } from '../src/triggers/retry.js';
const event = { issue: { id: '1', key: 'VA-1' }, eventId: 'update-1', timestamp: 100 };
test('Forge trigger context is not mistaken for injected dependencies', () => {
  assert.equal(isDependencyBundle({ cloudId: 'cloud', moduleKey: 'on-issue-updated' }), false);
  assert.equal(isDependencyBundle({ collectAffectedTrees: async () => [] }), true);
});
test('failed observations request supported Forge retry without recording success receipt', async () => {
  const result = await updated(event, { collectAffectedTrees: async () => [{ outcome: 'ERROR' }],
    recordReceipt: async () => assert.fail('failure must not be receipted') });
  assert.equal(result._retry, true);
  assert.equal(result.retryOptions.retryReason, 'FUNCTION_RETRY_REQUEST');
});
test('update fans out through the aggregate collector and passes event identity and timestamp to it', async () => {
  let received;
  await updated(event, {
    collectAffectedTrees,
    affectedTreeRoots: async () => [{ rootIssueId: 1, rootIssueKey: 'VA-ROOT' }],
    collectTree: async args => { received = args; return { outcome: 'NO_CHANGE' }; },
    recordReceipt: async () => {}
  });
  assert.equal(received.eventId, 'update-1'); assert.equal(received.eventAt, 100);
});
test('capture failures are visible incidents and request retry', async () => {
  const incidents = [];
  const result = await transitioned(event, { captureBaseline: async () => ({ captured: false, reason: 'ERROR' }),
    recordIncident: async (...args) => incidents.push(args) });
  assert.equal(result._retry, true); assert.equal(incidents[0][2], 'BASELINE_CAPTURE_FAILED');
});
test('a capture refused while the migration is pending records an incident only once its retries run out', async () => {
  const incidents = [];
  const deps = { captureBaseline: async () => ({ captured: false, reason: 'SCHEMA_PENDING' }),
    recordIncident: async (...args) => incidents.push(args) };
  for (let retryCount = 0; retryCount < 4; retryCount += 1) {
    const retried = await transitioned({ ...event, retryContext: { retryCount } }, deps);
    assert.equal(retried._retry, true, `attempt ${retryCount} is retried`);
  }
  assert.deepEqual(incidents, [], 'the deploy-to-migration window is not an incident');
  const last = await transitioned({ ...event, retryContext: { retryCount: 4 } }, deps);
  assert.equal(last.retryExhausted, true);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0][2], 'BASELINE_CAPTURE_FAILED');
});
test('every other capture failure still records an incident on each attempt', async () => {
  const incidents = [];
  const deps = { captureBaseline: async () => ({ captured: false, reason: 'CAPTURE_INCOMPLETE' }),
    recordIncident: async (...args) => incidents.push(args) };
  await transitioned({ ...event, retryContext: { retryCount: 1 } }, deps);
  await transitioned({ ...event, retryContext: { retryCount: 4 } }, deps);
  assert.deepEqual(incidents.map(i => i[2]), ['BASELINE_CAPTURE_FAILED', 'BASELINE_CAPTURE_FAILED']);
});
test('successful and duplicate capture still checks current drift', async () => {
  let checks = 0;
  await transitioned(event, { captureBaseline: async () => ({ captured: true, alreadyCaptured: true }),
    getReview: async () => ({ baseline_id: '1' }), collect: async () => { checks++; return { outcome: 'NO_CHANGE' }; } });
  assert.equal(checks, 1);
});
test('retry requests stop at platform limit', () => {
  assert.equal(retryEvent({ retryContext: { retryCount: 4 } }, 'ERROR').retryExhausted, true);
});
