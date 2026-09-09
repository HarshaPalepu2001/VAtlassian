import test from 'node:test';
import assert from 'node:assert/strict';
import { respond } from '../src/usecases/panelAccess.js';
import { DENY } from '../src/lib/errors.js';

test('panel responses translate known recovery reasons into user-facing guidance', async () => {
  const result = await respond(async () => {
    const error = new Error('ALREADY_DECIDING');
    error.reason = 'ALREADY_DECIDING';
    throw error;
  });
  assert.equal(result.reason, 'ALREADY_DECIDING');
  assert.equal(result.error, DENY.ALREADY_DECIDING);
});
