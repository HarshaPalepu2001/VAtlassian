import test from 'node:test';
import assert from 'node:assert/strict';
import { queueRestore } from '../src/usecases/restoreActions.js';
import { runRestoreWorker } from '../src/jobs/restoreWorker.js';

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

test('signed rejection stores its deterministic action plan before enqueueing', async () => {
  const order = [];
  const store = {
    startRestore: async args => { order.push({ kind: 'start', args }); return id(1); },
    markRestoreQueued: async args => { order.push({ kind: 'queued', args }); },
    markRestoreQueueFailure: async args => { order.push({ kind: 'failed', args }); }
  };
  const result = await queueRestore({
    prepared: prepared(), actor: { accountId: 'reviewer' },
    approval: { approval_id: id(3), actor_account_id: 'reviewer' },
    stores: store,
    enqueue: async event => { order.push({ kind: 'enqueue', event }); return { jobId: 'job-1' }; },
    now: 100
  });
  assert.equal(result.state, 'RESTORING');
  assert.deepEqual(order.map(x => x.kind), ['start', 'enqueue', 'queued']);
  assert.equal(order[0].args.state, 'QUEUING');
  assert.equal(order[0].args.totalSteps, 1);
  assert.equal(order[0].args.actionPlan.length, 1);
  assert.deepEqual(order[1].event, { restoreId: id(1).toString('base64'), issueId: 10,
    baselineId: id(2).toString('base64'), baselineVersion: 3 });
});

test('queue failure leaves a resumable QUEUING_FAILED restore', async () => {
  const calls = [];
  const result = await queueRestore({
    prepared: prepared(), actor: { accountId: 'reviewer' },
    approval: { approval_id: id(3), actor_account_id: 'reviewer' },
    stores: {
      startRestore: async () => id(1),
      markRestoreQueued: async () => calls.push('queued'),
      markRestoreQueueFailure: async args => calls.push(args)
    },
    enqueue: async () => { throw new Error('queue unavailable'); }, now: 100
  });
  assert.equal(result.state, 'QUEUING_FAILED');
  assert.deepEqual(calls.map(value => value === 'queued' ? value : value.error), ['queue unavailable']);
});

test('duplicate delivery does not replay a completed restore or terminal verification', async () => {
  const f = storeFixture();
  const first = await runRestoreWorker(body, f);
  const second = await runRestoreWorker(body, f);
  assert.equal(first.state, 'COMPLETE');
  assert.equal(second.state, 'COMPLETE');
  assert.equal(f.calls.filter(x => x === 'execute').length, 1);
  assert.equal(f.calls.filter(x => x === 'verify').length, 1);
});

test('a stale baseline exits before any Jira restore mutation', async () => {
  const f = storeFixture();
  f.activeBaseline = async () => ({ baseline_id: id(9), version: 4 });
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'FAILED');
  assert.equal(f.calls.includes('execute'), false);
  assert.equal(f.calls.some(call => call?.[0] === 'fail'), true);
});

test('a bounded worker batch republishes only while actions remain', async () => {
  const f = storeFixture();
  f.executeBatch = async () => { f.calls.push('execute'); return { state: 'PARTIAL', completed: 1, remaining: 2, attempted: 1 }; };
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'RESTORING');
  assert.equal(f.calls.filter(call => call?.[0] === 'enqueue').length, 1);
  assert.equal(f.calls.includes('verify'), false);
});
