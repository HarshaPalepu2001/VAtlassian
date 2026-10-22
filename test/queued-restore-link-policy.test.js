import test from 'node:test';
import assert from 'node:assert/strict';
import { queueRestore } from '../src/usecases/restoreActions.js';
import { runRestoreWorker } from '../src/jobs/restoreWorker.js';

const id = n => Buffer.alloc(16, n);
const policy = { version: 2, verifiesTypeId: '90', testTypes: [{ projectId: 1, issueTypeId: '20' }], internalTypeIds: [] };
const body = { restoreId: id(1).toString('base64'), issueId: 10,
  baselineId: id(2).toString('base64'), baselineVersion: 3 };
function prepared(linkPolicy = policy) {
  const root = { logicalNodeId: 'root', currentIssueId: 10, issueKey: 'P-10', parentLogicalId: null,
    parentLogicalNodeId: null, digests: { summary: 'approved' }, linkPolicy };
  return { issueId: 10, projectId: 1, issue: { id: '10', key: 'P-10' },
    baseline: { baseline_id: id(2), version: 3 },
    baselineTree: { nodes: [root], values: { root: { summary: 'approved' } } },
    currentTree: { nodes: [{ ...root, digests: { summary: 'changed' } }], values: { root: { summary: 'changed' } } },
    fields: [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }] };
}

test('queue freezes target node policies beside the signed deterministic action plan', async () => {
  let stored;
  await queueRestore({ prepared: prepared(), actor: { accountId: 'actor' }, approval: { approval_id: id(3) },
    stores: { startRestore: async args => { stored = args; return id(1); }, markRestoreQueued: async () => {} },
    enqueue: async () => ({ jobId: 'job' }) });
  assert.deepEqual(stored.detail.linkPolicies, { root: policy });
});

function worker(detail, target = prepared()) {
  let executions = 0, finished;
  const restore = { restore_id: id(1), approval_id: id(3), baseline_version: 3, state: 'QUEUING',
    total_steps: 1, detail: { actionPlan: [{ stepKey: 'field' }], ...detail } };
  const deps = {
    restoreById: async () => restore, activeBaseline: async () => ({ baseline_id: id(2), version: 3 }),
    approvalById: async () => ({ decision: 'REJECT', approval_id: id(3) }), claimRestore: async () => true,
    refreshItemLock: async () => {}, heartbeatRestore: async () => {}, beginRestoreVerification: async () => true,
    prepare: async () => target, executeBatch: async () => { executions++; return { state: 'READY_TO_VERIFY', completed: 1, remaining: 0 }; },
    verify: async () => ({ matches: true }), finishRestore: async args => { finished = args; },
    failRestore: async () => {}, release: async () => {}, markDecided: async () => {}, append: async () => {}
  };
  return { deps, executions: () => executions, finished: () => finished };
}

test('delivery refuses a target whose native policy changed after signing without any Jira mutation', async () => {
  const f = worker({ linkPolicies: { root: policy } }, prepared({ version: 1 }));
  const result = await runRestoreWorker(body, f.deps);
  assert.equal(result.state, 'FAILED');
  assert.match(result.error, /link policy/i);
  assert.equal(f.executions(), 0);
});

test('v2 target cannot be guessed for an old queued record lacking policy snapshots', async () => {
  const f = worker({});
  const result = await runRestoreWorker(body, f.deps);
  assert.equal(result.state, 'FAILED');
  assert.equal(f.executions(), 0);
});

test('unchanged policy survives terminal detail replacement so Retry uses the same snapshot', async () => {
  const f = worker({ linkPolicies: { root: policy } });
  const result = await runRestoreWorker(body, f.deps);
  assert.equal(result.state, 'COMPLETE');
  assert.deepEqual(f.finished().detail[0].linkPolicies, { root: policy });
});
