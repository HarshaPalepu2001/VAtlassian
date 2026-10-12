import test from 'node:test';
import assert from 'node:assert/strict';
import { queueRestore } from '../src/usecases/restoreActions.js';
import { runRestoreWorker } from '../src/jobs/restoreWorker.js';

const id = n => Buffer.alloc(16, n);
const body = { restoreId: id(1).toString('base64'), issueId: 10, baselineId: id(2).toString('base64'), baselineVersion: 3 };
const mixedDetail = (over = {}) => ({ actionPlan: [{ stepKey: 's1' }], mixed: {
  overlay: { root: { summary: 'D-live' } }, mapHash: 'm'.repeat(64),
  approved: ['root:summary'], rejected: ['root:description'], ...over } });

function prepared() {
  const root = { logicalNodeId: 'root', currentIssueId: 10, issueKey: 'T-10', parentLogicalNodeId: null,
    parentLogicalId: null, digests: { summary: 'approved', description: 'approved-d' } };
  return {
    issue: { id: '10', key: 'T-10' }, issueId: 10, projectId: 1,
    baseline: { baseline_id: id(2), version: 3, tree_hash: 't'.repeat(64), from_status_id: '1' },
    baselineTree: { nodes: [root], values: { root: { summary: 'approved', description: 'approved-d' } } },
    currentTree: { nodes: [{ ...root, digests: { summary: 'D-live', description: 'changed' } }],
      values: { root: { summary: 'live', description: 'changed' } } },
    fields: [{ field_id: 'summary' }, { field_id: 'description' }], config: { restore: { maxActions: 1 } }
  };
}

function fixture({ decision = 'MIXED', detail = mixedDetail() } = {}) {
  const restore = { ...body, restore_id: id(1), approval_id: id(3), baseline_id: id(2), baseline_version: 3,
    actor_account_id: 'reviewer', state: 'QUEUING', total_steps: 1, completed_steps: 0, detail };
  const calls = [], released = [], appended = [], finished = [], verifyArgs = [];
  return {
    restore, calls, released, appended, finished, verifyArgs,
    restoreById: async () => restore,
    activeBaseline: async () => ({ baseline_id: id(2), version: 3 }),
    approvalById: async () => ({ decision, approval_id: id(3), actor_name: 'Rev' }),
    claimRestore: async () => true, heartbeatRestore: async () => {}, refreshItemLock: async () => {},
    beginRestoreVerification: async () => true,
    finishRestore: async args => { calls.push('finish'); finished.push(args); restore.state = args.state; },
    failRestore: async () => { calls.push('fail'); restore.state = 'FAILED'; },
    markRestoreQueued: async () => {}, markRestoreQueueFailure: async () => {},
    markDecided: async () => { calls.push('decided'); },
    release: async args => { calls.push('release'); released.push(args); },
    executeBatch: async () => ({ state: 'READY_TO_VERIFY', completed: 1, remaining: 0, attempted: 1 }),
    verify: async args => { calls.push('verify'); verifyArgs.push(args); return { matches: true, statusMatches: true, changes: [] }; },
    captureMixed: async () => { calls.push('capture'); return { captured: true, version: 4 }; },
    prepare: async () => prepared(),
    enqueue: async () => ({ jobId: 'next' }),
    append: async args => { appended.push(args); }
  };
}

test('a mixed restore captures the next baseline only AFTER its rejected fields verify, then records it', async () => {
  const f = fixture();
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'COMPLETE');
  assert.deepEqual(f.calls.filter(c => ['verify', 'capture', 'finish', 'decided', 'release'].includes(c)),
    ['verify', 'capture', 'finish', 'decided', 'release']);
  assert.equal(f.released.at(-1).state, 'BASELINED');
  assert.equal(f.released.at(-1).counters.driftCount, 0);
  const event = f.appended.find(a => a.eventType === 'RESTORE_COMPLETED' || String(a.eventType).includes('RESTORE_COMPLETED'));
  assert.deepEqual(event.payload.mixed, { approved: ['root:summary'], rejected: ['root:description'], baselineCreated: true });
});

test('verification is run against the target: approved fields at their live value, rejected at their approved value', async () => {
  const f = fixture();
  await runRestoreWorker(body, f);
  const { prepared: seen } = f.verifyArgs[0];
  assert.equal(seen.targetTree.nodes[0].digests.summary, 'D-live', 'approved field takes the value the reviewer saw');
  assert.equal(seen.targetTree.nodes[0].digests.description, 'approved-d', 'rejected field must be back at its approved value');
  assert.equal(seen.baselineTree.nodes[0].digests.summary, 'approved', 'the retained values still come from the baseline');
  assert.equal(seen.targetTree.nodes[0].parentLogicalId, null);
});

test('rejecting every field restores against the standing baseline and creates no new version', async () => {
  const f = fixture({ detail: mixedDetail({ overlay: {}, approved: [], rejected: ['root:summary', 'root:description'] }) });
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'COMPLETE');
  assert.ok(!f.calls.includes('capture'));
  assert.ok(f.calls.includes('decided'));
  assert.equal(f.released.at(-1).state, 'BASELINED');
  const event = f.appended.find(a => String(a.eventType).includes('RESTORE_COMPLETED'));
  assert.equal(event.payload.mixed.baselineCreated, false);
});

test('an unverified restore never captures', async () => {
  const f = fixture();
  f.verify = async () => ({ matches: false, progress: true, unmatched: [{ fieldId: 'description', fieldName: 'description', logicalNodeId: 'root' }] });
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'PARTIAL');
  assert.ok(!f.calls.includes('capture'));
  assert.ok(!f.calls.includes('decided'));
  assert.notEqual(f.released.at(-1).state, 'BASELINED');
});

for (const [name, captureMixed] of [
  ['throws', async () => { throw new Error('baseline store unavailable'); }],
  ['is refused', async () => ({ captured: false, reason: 'CONTENT_CHANGED' })]
]) {
  test(`when publishing the next baseline ${name}, the restore is not left looking clean`, async () => {
    const f = fixture();
    f.captureMixed = captureMixed;
    const result = await runRestoreWorker(body, f);
    assert.equal(result.state, 'PARTIAL');
    assert.equal(f.finished[0].state, 'PARTIAL');
    assert.equal(f.finished[0].detail[0].publication, 'INCOMPLETE');
    assert.match(JSON.stringify(f.finished[0].detail[0].unmatched), /baseline/i);
    assert.ok(f.finished[0].detail[0].mixed, 'the frozen overlay survives for Retry');
    assert.ok(!f.calls.includes('decided'), 'drift is not marked decided without a published baseline');
    assert.equal(f.released.at(-1).state, 'ERROR');
    const event = f.appended.find(a => String(a.eventType).includes('RESTORE_PARTIAL'));
    assert.equal(event.payload.publication, 'INCOMPLETE');
  });
}

test('a whole-set rejection is unchanged: it never captures', async () => {
  const f = fixture({ decision: 'REJECT', detail: { actionPlan: [{ stepKey: 's1' }] } });
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'COMPLETE');
  assert.ok(!f.calls.includes('capture'));
  assert.equal(f.verifyArgs[0].prepared.targetTree, undefined);
});

test('a mixed approval whose frozen overlay is missing fails closed and captures nothing', async () => {
  const f = fixture({ detail: { actionPlan: [{ stepKey: 's1' }] } });
  const result = await runRestoreWorker(body, f);
  assert.equal(result.state, 'FAILED');
  assert.ok(!f.calls.includes('capture'));
  assert.ok(!f.calls.includes('verify'));
  assert.equal(f.released.at(-1).state, 'ERROR');
});

test('queueing a mixed restore persists only the rejected-field plan and the frozen overlay', async () => {
  const startArgs = [];
  const mixed = { restore: { steps: [{ kind: 'RESTORE_FIELDS', stepKey: 'k1', fieldIds: ['description'] }] },
    overlay: { root: { summary: 'D-live' } }, mapHash: 'm'.repeat(64),
    approvedIds: ['root:summary'], rejectedIds: ['root:description'] };
  const result = await queueRestore({
    prepared: { ...prepared(), issueId: 10, projectId: 1 }, actor: { accountId: 'reviewer' },
    approval: { approval_id: id(3), actor_account_id: 'reviewer' }, mixed,
    stores: { startRestore: async args => { startArgs.push(args); return id(1); }, markRestoreQueued: async () => {},
      markRestoreQueueFailure: async () => {}, release: async () => {} },
    enqueue: async () => ({ jobId: 'job-1' }), now: 100 });
  assert.equal(result.state, 'RESTORING');
  assert.equal(startArgs[0].totalSteps, 1);
  assert.deepEqual(startArgs[0].actionPlan.map(s => s.stepKey), ['k1']);
  assert.deepEqual(startArgs[0].detail.mixed, { overlay: mixed.overlay, mapHash: mixed.mapHash,
    approved: ['root:summary'], rejected: ['root:description'] });
  assert.deepEqual(Object.keys(startArgs[0].detail).sort(), ['actionPlan', 'mixed'], 'nothing else, in particular no field values');
});
