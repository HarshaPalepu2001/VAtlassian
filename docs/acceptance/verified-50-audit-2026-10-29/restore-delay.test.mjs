import test from 'node:test';
import assert from 'node:assert/strict';
import { queueRestore, restoresSubtree } from '../../../src/usecases/restoreActions.js';
import { runRestoreWorker } from '../../../src/jobs/restoreWorker.js';

const id = n => Buffer.alloc(16, n);
const body = { restoreId: id(1).toString('base64'), issueId: 10,
  baselineId: id(2).toString('base64'), baselineVersion: 3 };

function prepared() {
  const root = { logicalNodeId: 'root', currentIssueId: 10, issueKey: 'T-10', parentLogicalNodeId: null,
    parentLogicalId: null, digests: { summary: 'approved' } };
  return {
    issue: { id: '10', key: 'T-10' }, issueId: 10, projectId: 1,
    baseline: { baseline_id: id(2), version: 3, tree_hash: 't'.repeat(64), from_status_id: '1' },
    baselineTree: { nodes: [root], values: { root: { summary: 'approved' } } },
    currentTree: { nodes: [{ ...root, digests: { summary: 'changed' } }], values: { root: { summary: 'changed' } } },
    fields: [{ field_id: 'summary' }], config: { restore: { maxActions: 1 } }
  };
}

function storeFixture() {
  const restore = { ...body, restore_id: id(1), approval_id: id(3), baseline_id: id(2), baseline_version: 3,
    actor_account_id: 'reviewer', state: 'QUEUING', total_steps: 1, completed_steps: 0,
    detail: { actionPlan: [{ stepKey: 's1' }] } };
  const calls = [];
  return {
    restore, calls,
    restoreById: async () => restore,
    activeBaseline: async () => ({ baseline_id: id(2), version: 3 }),
    approvalById: async () => ({ decision: 'REJECT', approval_id: id(3) }),
    claimRestore: async () => { calls.push('claim'); return true; },
    heartbeatRestore: async args => { calls.push(['heartbeat', args]); },
    refreshItemLock: async args => { calls.push(['lock', args]); },
    beginRestoreVerification: async () => { calls.push('verify-claim'); return true; },
    updateRestoreProgress: async args => { calls.push(['progress', args]); },
    finishRestore: async args => { calls.push(['finish', args]); restore.state = args.state; },
    failRestore: async args => { calls.push(['fail', args]); restore.state = 'FAILED'; },
    markRestoreQueued: async args => { calls.push(['queued', args]); restore.state = 'QUEUING'; },
    markRestoreQueueFailure: async args => { calls.push(['queue-failed', args]); restore.state = 'QUEUING_FAILED'; },
    markDecided: async () => { calls.push('decided'); },
    release: async () => { calls.push('release'); },
    executeBatch: async () => { calls.push('execute'); return { state: 'READY_TO_VERIFY', completed: 1, remaining: 0, attempted: 1 }; },
    verify: async () => { calls.push('verify'); return { matches: true, statusMatches: true, changes: [] }; },
    prepare: async () => prepared(),
    enqueue: async next => { calls.push(['enqueue', next]); return { jobId: 'job-next' }; },
    append: async () => { calls.push('append'); }
  };
}


test('audit: real restore worker returns 5,10,20,40,60 seconds for retry counts 0..4', async () => {
  const delays = [];
  for (let retryCount = 0; retryCount < 5; retryCount++) {
    const f = storeFixture();
    f.executeBatch = async () => ({ state: 'PARTIAL', completed: 0, remaining: 1, attempted: 1,
      stopped: true, retryableError: { status: 503, detail: 'audit temporary failure' } });
    const result = await runRestoreWorker({ body, retryContext: { retryCount } }, f);
    delays.push(result.retryOptions?.retryAfter ?? result.retryAfter);
  }
  assert.deepEqual(delays, [5, 10, 20, 40, 60]);
  console.log('Verified restore delay sequence', delays);
});
