import test from 'node:test';
import assert from 'node:assert/strict';
import { queueRestore, restoresSubtree } from '../src/usecases/restoreActions.js';
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

test('a temporary stopped action retries the same restore instead of failing for no progress', async () => {
  const f = storeFixture();
  let unavailable = true;
  f.executeBatch = async () => unavailable
    ? { state: 'PARTIAL', completed: 0, remaining: 1, attempted: 1, stopped: true,
      retryableError: { status: 503, detail: 'Jira unavailable' } }
    : { state: 'READY_TO_VERIFY', completed: 1, remaining: 0, attempted: 1 };
  const first = await runRestoreWorker({ body }, f);
  assert.equal(first._retry, true);
  assert.equal(f.restore.state, 'QUEUING');
  assert.equal(f.calls.some(call => call?.[0] === 'fail'), false);
  unavailable = false;
  const second = await runRestoreWorker({ body, retryContext: { retryCount: 1 } }, f);
  assert.equal(second.state, 'COMPLETE');
});

test('repeated temporary restore failures eventually remain visible and retryable by the reviewer', async () => {
  const f = storeFixture();
  f.executeBatch = async () => ({ state: 'PARTIAL', completed: 0, remaining: 1, attempted: 1,
    stopped: true, retryableError: { status: 503, detail: 'Jira unavailable' } });
  const result = await runRestoreWorker({ body, retryContext: { retryCount: 5 } }, f);
  assert.equal(result.state, 'FAILED');
  assert.match(result.error, /after automatic retries/);
  assert.equal(f.calls.includes('decided'), false);
  assert.equal(f.calls.includes('verify'), false);
});

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
      markRestoreQueueFailure: async args => calls.push(args),
      release: async () => {}
    },
    enqueue: async () => { throw new Error('queue unavailable'); }, now: 100
  });
  assert.equal(result.state, 'QUEUING_FAILED');
  assert.deepEqual(calls.map(value => value === 'queued' ? value : value.error), ['queue unavailable']);
});

test('a restore that could not be queued releases the item lock into ERROR', async () => {
  // Nothing is running, so the item must not stay RESTORING: the gate refuses
  // every transition of a RESTORING item as "restore in progress".
  const released = [];
  await queueRestore({
    prepared: prepared(), actor: { accountId: 'reviewer' },
    approval: { approval_id: id(3), actor_account_id: 'reviewer' },
    stores: {
      startRestore: async () => id(1),
      markRestoreQueued: async () => {},
      markRestoreQueueFailure: async () => true,
      release: async args => { released.push(args); }
    },
    enqueue: async () => { throw new Error('queue unavailable'); }, now: 100
  });
  assert.equal(released.length, 1);
  assert.equal(released[0].issueId, 10);
  assert.equal(released[0].state, 'ERROR');
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

test('the worker keeps the work item lock alive while it restores', async () => {
  // va_item_state.last_checked_at is what every stale-lock check reads. Only
  // va_restore was heartbeated, so the item lock aged from the moment the
  // reject took it, however long the worker then ran.
  const f = storeFixture();
  f.executeBatch = async () => { f.calls.push('execute'); return { state: 'PARTIAL', completed: 1, remaining: 2, attempted: 1 }; };
  await runRestoreWorker(body, { ...f, now: 500 });
  const refreshed = f.calls.filter(call => call?.[0] === 'lock');
  assert.ok(refreshed.length >= 2, 'refreshed on claim and after the batch');
  assert.ok(refreshed.every(([, args]) => args.issueId === 10));
});

test('a batch whose requeue fails releases the item lock into ERROR', async () => {
  const f = storeFixture();
  const released = [];
  f.release = async args => { released.push(args); };
  f.executeBatch = async () => { f.calls.push('execute'); return { state: 'PARTIAL', completed: 1, remaining: 2, attempted: 1 }; };
  f.enqueue = async () => { throw new Error('queue unavailable'); };
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'QUEUING_FAILED');
  assert.deepEqual(released.map(r => [r.issueId, r.state]), [[10, 'ERROR']]);
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

test('a worker does not requeue a restore batch that made no progress', async () => {
  const f = storeFixture();
  f.executeBatch = async () => { f.calls.push('execute'); return { state: 'PARTIAL', completed: 0, remaining: 1, attempted: 1, stopped: true }; };
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'FAILED');
  assert.equal(f.calls.filter(call => call?.[0] === 'enqueue').length, 0);
  assert.equal(f.calls.some(call => call?.[0] === 'fail'), true);
});

// A parent's restore rewrites its children, and each child carries its own
// stored review state and its own evidence. Before this, only the decided item
// was released: a child the restore had put back stayed DRIFTED in
// va_item_state, so the parent kept saying "1 child work item has changes
// awaiting a decision" and the child's own record said nothing happened to it.
function withRewrittenChild(f) {
  const base = prepared();
  f.prepare = async () => ({
    ...base,
    baselineTree: { nodes: [...base.baselineTree.nodes,
      { logicalNodeId: 'child', currentIssueId: 11, issueKey: 'T-11', parentLogicalNodeId: 'root' }],
    values: { ...base.baselineTree.values, child: { summary: 'child approved' } } }
  });
  f.restore.detail = { actionPlan: [
    { stepKey: 's-root', kind: 'RESTORE_FIELDS', logicalNodeId: 'root' },
    { stepKey: 's-child', kind: 'RESTORE_FIELDS', logicalNodeId: 'child' }] };
  f.restore.total_steps = 2;
  const released = [];
  const appended = [];
  f.release = async args => { released.push(args); };
  f.append = async args => { appended.push(args); };
  return { released, appended };
}

test('a complete restore releases every child it rewrote, not only the decided item', async () => {
  const f = storeFixture();
  const { released, appended } = withRewrittenChild(f);
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'COMPLETE');
  const child = released.find(args => args.issueId === 11);
  assert.ok(child, 'the child the restore rewrote is released');
  assert.equal(child.state, 'BASELINED');
  assert.deepEqual(child.counters, { driftCount: 0, driftedFieldCount: 0, maxMateriality: null });
  assert.equal(released.filter(args => args.issueId === 10).length, 1, 'the decided item is released once');
  const childEntry = appended.find(entry => entry.issueId === 11);
  assert.ok(childEntry, 'the child has its own ledger entry');
  assert.equal(childEntry.eventType, 'RESTORE_COMPLETED');
  assert.equal(childEntry.payload.viaParentIssueId, 10);
});

test('a restore that did not verify leaves its children as they were', async () => {
  const f = storeFixture();
  const { released, appended } = withRewrittenChild(f);
  f.verify = async () => ({ matches: false, progress: true, unmatched: [{ fieldId: 'summary' }] });
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'PARTIAL');
  assert.equal(released.some(args => args.issueId === 11), false);
  assert.equal(appended.some(entry => entry.issueId === 11), false);
});

// One refused child must not strand a sibling that DID land. The restore is
// PARTIAL, the decided item stays drifted for the child that is still wrong,
// but a child the verification read back as matching its own record has been
// put right and has to be released, or it reads as drifted until some later
// sweep happens to look at it.
function withTwoChildren(f) {
  const base = prepared();
  f.prepare = async () => ({
    ...base,
    baselineTree: { nodes: [...base.baselineTree.nodes,
      { logicalNodeId: 'landed', currentIssueId: 11, issueKey: 'T-11', parentLogicalNodeId: 'root' },
      { logicalNodeId: 'refused', currentIssueId: 12, issueKey: 'T-12', parentLogicalNodeId: 'root' }],
    values: { ...base.baselineTree.values } }
  });
  f.restore.detail = { actionPlan: [
    { stepKey: 's-root', kind: 'RESTORE_FIELDS', logicalNodeId: 'root' },
    { stepKey: 's-landed', kind: 'RESTORE_FIELDS', logicalNodeId: 'landed' },
    { stepKey: 's-refused', kind: 'RESTORE_FIELDS', logicalNodeId: 'refused' }] };
  f.restore.total_steps = 3;
  f.executeBatch = async () => ({ state: 'READY_TO_VERIFY', completed: 2, remaining: 0, attempted: 3,
    refused: [{ stepKey: 's-refused', logicalNodeId: 'refused', kind: 'RESTORE_FIELDS', error: { detail: 'Description is required' } }] });
  f.verify = async () => ({ matches: false, progress: true, unmatched: [
    { logicalNodeId: 'refused', issueKey: 'T-12', kind: 'FIELD_CHANGED', fieldId: 'summary', fieldName: 'Summary' }] });
  const released = [];
  const appended = [];
  f.release = async args => { released.push(args); };
  f.append = async args => { appended.push(args); };
  return { released, appended };
}

test('when one child is refused, a sibling that landed is still released and the refused one is not', async () => {
  const f = storeFixture();
  const { released, appended } = withTwoChildren(f);
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'PARTIAL');
  const landed = released.find(args => args.issueId === 11);
  assert.ok(landed, 'the child that landed is released');
  assert.equal(landed.state, 'BASELINED');
  assert.deepEqual(landed.counters, { driftCount: 0, driftedFieldCount: 0, maxMateriality: null });
  assert.equal(released.some(args => args.issueId === 12), false, 'the refused child keeps its drift');
  const entry = appended.find(item => item.issueId === 11);
  assert.ok(entry, 'the landed child has its own ledger entry');
  assert.equal(entry.payload.state, 'COMPLETE');
  assert.equal(entry.payload.parentState, 'PARTIAL');
  assert.equal(appended.some(item => item.issueId === 12), false);
  const root = released.find(args => args.issueId === 10);
  assert.equal(root.state, 'DRIFTED', 'the decided item still reports what is outstanding');
});

test('a verification that cannot say which item is wrong releases no child', async () => {
  const f = storeFixture();
  const { released } = withTwoChildren(f);
  f.verify = async () => ({ matches: false, progress: false,
    unmatched: [{ logicalNodeId: null, issueKey: 'T-10', kind: 'READ_FAILED', fieldId: null }] });
  await runRestoreWorker(body, f);
  assert.equal(released.some(args => args.issueId === 11 || args.issueId === 12), false);
});

// Found live 2026-10-12: a reject at VAT-73 (a Story baselined by its Epic's
// capture) restored the Story's own description but not its sub-task's label.
// A child baseline written by its parent covers its subtree like a tree does.
test('a reject on a child its parent captured restores its subtree, not only itself', async () => {
  assert.equal(restoresSubtree({ tree_hash: 't'.repeat(64) }), true);
  assert.equal(restoresSubtree({ tree_hash: null, captured_by_baseline_id: id(9) }), true);
  assert.equal(restoresSubtree({ tree_hash: null, captured_by_baseline_id: null }), false);
  assert.equal(restoresSubtree(null), false);

  const child = { logicalNodeId: 'c1', currentIssueId: 10, issueKey: 'T-10', parentLogicalNodeId: null,
    parentLogicalId: null, digests: { labels: 'c1' } };
  const sub = { logicalNodeId: 's1', currentIssueId: 11, issueKey: 'T-11', parentLogicalNodeId: 'c1',
    parentLogicalId: 'c1', digests: { labels: 's1-approved' } };
  const p = {
    issue: { id: '10', key: 'T-10' }, issueId: 10, projectId: 1,
    baseline: { baseline_id: id(2), version: 1, tree_hash: null, captured_by_baseline_id: id(9), from_status_id: '1' },
    baselineTree: { nodes: [child, sub], values: { c1: { labels: ['c1'] }, s1: { labels: ['s1'] } } },
    currentTree: { nodes: [child, { ...sub, digests: { labels: 's1-changed' } }],
      values: { c1: { labels: ['c1'] }, s1: { labels: ['s1', 'extra'] } } },
    fields: [{ field_id: 'labels' }], config: {}
  };
  let plan = null;
  await queueRestore({ prepared: p, actor: { accountId: 'reviewer' }, approval: { approval_id: id(3) },
    stores: { startRestore: async args => { plan = args.actionPlan; return id(1); }, markRestoreQueued: async () => {} },
    enqueue: async () => ({ jobId: 'j' }), now: 1 });
  assert.deepEqual(plan.map(step => [step.kind, step.logicalNodeId, step.fieldIds]), [['RESTORE_FIELDS', 's1', ['labels']]],
    'the sub-task\'s changed field is restored');
});
