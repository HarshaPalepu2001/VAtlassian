import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFailedApproval } from '../src/usecases/drift.js';

test('a restore deadline leaves its lock in RESTORING while the restore still runs', async () => {
  const releases = [];
  const timeout = Object.assign(new Error('Restore still running'), {
    reason: 'RESTORE_IN_PROGRESS',
    retainRestoreLock: true
  });

  await releaseFailedApproval({
    locked: true,
    issueId: 10,
    diff: { changedFieldCount: 1, materialFieldCount: 1 },
    driftCount: 1,
    error: timeout,
    now: 123,
    release: async details => releases.push(details)
  });

  assert.deepEqual(releases, []);
});

test('a completed restore failure releases the lock as an error', async () => {
  const releases = [];

  await releaseFailedApproval({
    locked: true,
    issueId: 10,
    diff: { changedFieldCount: 1, materialFieldCount: 1 },
    driftCount: 1,
    error: new Error('Jira rejected the write'),
    now: 123,
    release: async details => releases.push(details)
  });

  assert.deepEqual(releases, [{
    issueId: 10,
    state: 'ERROR',
    now: 123,
    counters: { driftCount: 1, driftedFieldCount: 1, maxMateriality: null }
  }]);
});
