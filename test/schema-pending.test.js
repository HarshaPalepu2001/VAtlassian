import test from 'node:test';
import assert from 'node:assert/strict';
import { retryEvent } from '../src/triggers/retry.js';
import { captureFailure } from '../src/lib/capture.js';
import { FailClosed, DENY } from '../src/lib/errors.js';

test('SCHEMA_PENDING waits past the five-minute migration window within the four retries Forge allows', () => {
  let waited = 0;
  for (let count = 0; count < 4; count += 1) {
    const retry = retryEvent({ retryContext: { retryCount: count } }, 'SCHEMA_PENDING');
    assert.ok(!retry.retryExhausted, `retry ${count}`);
    waited += retry.retryOptions?.retryAfter ?? retry.retryAfter;
  }
  assert.ok(waited > 300, `waited ${waited}s`);
  assert.equal(retryEvent({ retryContext: { retryCount: 4 } }, 'SCHEMA_PENDING').retryExhausted, true,
    'Forge allows four retries of a product event');
  assert.equal(retryEvent({ retryContext: { retryCount: 4 } }, 'CAPTURE_FAILED').retryExhausted, true,
    'every other reason keeps its budget');
  const other = retryEvent({ retryContext: { retryCount: 0 } }, 'CAPTURE_FAILED');
  assert.equal(other.retryOptions?.retryAfter ?? other.retryAfter, 15, 'every other reason keeps its delay');
});

test('a governed refusal inside a capture reports its own reason, so it is retried as that', () => {
  assert.equal(captureFailure(new FailClosed('SCHEMA_PENDING')).reason, 'SCHEMA_PENDING');
  assert.equal(captureFailure(new Error('socket hang up')).reason, 'ERROR');
  assert.match(DENY.SCHEMA_PENDING, /finishing an update/);
});
