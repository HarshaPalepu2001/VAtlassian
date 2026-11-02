import test from 'node:test';
import assert from 'node:assert/strict';
import { createCiIntakeHandler, createCiIntakeWorker } from '../src/jobs/ciIntake.js';
test('static webtrigger acknowledges accepted submissions without reflecting secret or receipt', async () => {
  let passed;
  const handler = createCiIntakeHandler({ receive: async input => { passed = input; return { receiptId: 'secret-detail' }; } });
  const response = await handler({ method: 'POST', headers: { authorization: ['Bearer secret'], 'content-type': ['application/json'] }, body: '{"x":1}' });
  assert.deepEqual(response, { outputKey: 'accepted' }); assert.deepEqual(passed, { authorization: 'Bearer secret', body: '{"x":1}' });
});
test('static handler rejects method/content type, wrong credentials, payload limits and service outage with fixed outputs', async () => {
  for (const [request, reason, key] of [
    [{ method: 'GET' }, null, 'rejected'],
    [{ method: 'POST', headers: { 'content-type': ['text/plain'] } }, null, 'rejected'],
    [{ method: 'POST', headers: { 'content-type': ['application/json'] } }, 'INTAKE_UNAUTHORIZED', 'unauthorized'],
    [{ method: 'POST', headers: { 'content-type': ['application/json'] } }, 'INTAKE_TOO_LARGE', 'too-large'],
    [{ method: 'POST', headers: { 'content-type': ['application/json'] } }, 'SERVICE_UNAVAILABLE', 'unavailable']
  ]) {
    const handler = createCiIntakeHandler({ receive: async () => { throw Object.assign(new Error('private detail'), { reason }); } });
    assert.deepEqual(await handler(request), { outputKey: key });
  }
});
test('worker receives exact receipt ID and propagates recoverable errors for queue redelivery', async () => {
  const worker = createCiIntakeWorker({ process: async input => input });
  assert.deepEqual(await worker({ body: { receiptId: 'a'.repeat(32) } }), { receiptId: 'a'.repeat(32) });
  const fail = createCiIntakeWorker({ process: async () => { throw new Error('retry'); } });
  await assert.rejects(fail({ body: { receiptId: 'a'.repeat(32) } }), /retry/);
});
