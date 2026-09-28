import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueVault, enqueueVaultJobs } from '../src/lib/vaultQueue.js';

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

test('enqueueVault carries the files the baseline recorded, and refuses one without an id', async () => {
  const pushed = [];
  const queue = { push: async (job) => { pushed.push(job); return { jobId: 'j' }; } };
  await enqueueVault({ baselineId: 'b', issueId: 42, issueKey: 'ENG-1', projectId: 7,
    attachments: [{ id: '1', jiraId: '900', filename: 'spec.pdf' }, { id: 2, filename: 'b.csv' }] }, { queue });
  assert.deepEqual(pushed[0].body.attachments, [
    { id: '1', jiraId: '900', filename: 'spec.pdf' }, { id: '2', jiraId: '2', filename: 'b.csv' }]);
  await enqueueVault({ baselineId: 'b', issueId: 42, issueKey: 'ENG-1', projectId: 7 }, { queue });
  assert.equal('attachments' in pushed[1].body, false, 'no list: the worker copies the current files');
  assert.throws(() => enqueueVault({ baselineId: 'b', issueId: 42, issueKey: 'ENG-1', projectId: 7,
    attachments: [{ filename: 'x' }] }, { queue }), TypeError);
});

test('many jobs go in batches of fifty, and only the ones Forge refused are reported', async () => {
  const pushes = [];
  const queue = { push: async (events) => {
    pushes.push(events.length);
    if (pushes.length === 2) {
      throw Object.assign(new Error('partial'), { failedEvents: [{ payload: { body: events[3].body } }] });
    }
    return { jobId: 'j' };
  } };
  const bodies = Array.from({ length: 120 }, (_, i) => ({ baselineId: `b${i}`, issueId: i + 1, issueKey: `ENG-${i + 1}`, projectId: 7 }));
  const result = await enqueueVaultJobs([...bodies, { issueId: 'bad' }], { queue });
  assert.deepEqual(pushes, [50, 50, 20]);
  assert.deepEqual(result.failed.map(f => f.body.baselineId ?? 'invalid'), ['invalid', 'b53']);
});

test('a batch that fails outright reports every job in it', async () => {
  const queue = { push: async () => { throw new Error('queue down'); } };
  const result = await enqueueVaultJobs([{ baselineId: 'b', issueId: 1, issueKey: 'E-1', projectId: 7 },
    { baselineId: 'c', issueId: 2, issueKey: 'E-2', projectId: 7 }], { queue });
  assert.deepEqual(result.failed.map(f => f.body.baselineId), ['b', 'c']);
});
