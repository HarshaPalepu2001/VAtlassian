import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueVault } from '../src/lib/vaultQueue.js';

function fakeQueue() {
  const pushed = [];
  return { queue: { push: async (msg) => { pushed.push(msg); return { jobId: 'job-1' }; } }, pushed };
}

test('enqueueVault normalizes and pushes a well-formed body', async () => {
  const { queue, pushed } = fakeQueue();
  const result = await enqueueVault({ baselineId: 'YmFzZQ==', issueId: '42', issueKey: 'ENG-1', projectId: '7' }, { queue });
  assert.deepEqual(result, { jobId: 'job-1' });
  assert.deepEqual(pushed[0].body, { baselineId: 'YmFzZQ==', issueId: 42, issueKey: 'ENG-1', projectId: 7 });
  assert.equal(pushed[0].concurrency.key, 'vault:42');
});

test('enqueueVault rejects a missing baselineId', async () => {
  const { queue } = fakeQueue();
  assert.throws(() => enqueueVault({ issueId: 42, issueKey: 'ENG-1', projectId: 7 }, { queue }), TypeError);
});

test('enqueueVault rejects a non-numeric issueId', async () => {
  const { queue } = fakeQueue();
  assert.throws(() => enqueueVault({ baselineId: 'b', issueId: 'nope', issueKey: 'ENG-1', projectId: 7 }, { queue }), TypeError);
});
