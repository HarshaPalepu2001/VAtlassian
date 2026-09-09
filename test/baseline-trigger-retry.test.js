import test from 'node:test';
import assert from 'node:assert/strict';
import { run as updated } from '../src/triggers/issue-updated.js';
import { run as transitioned } from '../src/triggers/issue-transitioned.js';
import { retryEvent } from '../src/triggers/retry.js';
const event = { issue: { id: '1', key: 'VA-1' }, eventId: 'update-1', timestamp: 100 };
test('failed observations request supported Forge retry without recording success receipt', async () => {
  const result = await updated(event, { collect: async () => ({ outcome: 'ERROR' }),
    recordReceipt: async () => assert.fail('failure must not be receipted') });
  assert.equal(result._retry, true);
  assert.equal(result.retryOptions.retryReason, 'FUNCTION_RETRY_REQUEST');
});
test('update passes observation identity and timestamp even without a field changelog', async () => {
  let received;
  await updated(event, { collect: async args => { received = args; return { outcome: 'NO_CHANGE' }; }, recordReceipt: async () => {} });
  assert.equal(received.eventId, 'update-1'); assert.equal(received.eventAt, 100);
});
test('capture failures are visible incidents and request retry', async () => {
  const incidents = [];
  const result = await transitioned(event, { captureBaseline: async () => ({ captured: false, reason: 'ERROR' }),
    recordIncident: async (...args) => incidents.push(args) });
  assert.equal(result._retry, true); assert.equal(incidents[0][2], 'BASELINE_CAPTURE_FAILED');
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
