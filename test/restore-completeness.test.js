import test from 'node:test';
import assert from 'node:assert/strict';

import { project } from '../src/lib/content.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';
import { runRestoreWorker } from '../src/jobs/restoreWorker.js';
import { resumable, comparableDigests, approvedDigestsFor } from '../src/lib/restore/resume.js';

/**
 * The restore completeness contract.
 *
 * Every test here is a failure a reviewer actually met on VJIRA-16: a restore
 * that put every authored value back and still reported PARTIAL, a retry button
 * that could never be pressed, and an item left in a state that refused the
 * next transition. The common thread is that "restored" was being decided by
 * comparisons the restore does not own and cannot influence.
 */

const controlledFields = [
  { field_id: 'summary', field_kind: 'TEXT', field_name: 'Summary', store_values: true },
  { field_id: 'subtasks', field_kind: 'SUBTASKS', field_name: 'Subtasks', store_values: true },
  { field_id: 'parent', field_kind: 'SCALAR', field_name: 'Parent', store_values: true }
];

function node(logicalNodeId, fields, parentLogicalId = null) {
  const projection = project(fields, controlledFields);
  return { logicalNodeId, parentLogicalId, parentLogicalNodeId: parentLogicalId,
    digests: projection.digests, raw: projection.raw };
}

// ── Structural facts are verified structurally, never as field values ────────

test('a subtask recreated under a new Jira id is not reported as a changed field', () => {
  const baselineTree = {
    nodes: [
      node('root', { summary: 'Root', subtasks: [{ id: '2' }], parent: null }),
      node('child', { summary: 'Child', subtasks: [], parent: { id: '1' } }, 'root')
    ]
  };
  // The restore recreated 'child'; Jira handed it a new id, so the parent's
  // subtasks list and the child's parent pointer both carry a different value
  // while describing exactly the approved shape.
  const currentTree = {
    nodes: [
      node('root', { summary: 'Root', subtasks: [{ id: '99' }], parent: null }),
      node('child', { summary: 'Child', subtasks: [], parent: { id: '1' } }, 'root')
    ]
  };

  const { changes } = diffTree({ baselineTree, currentTree, controlledFields });
  assert.deepEqual(changes, [], `structural ids must not read as content drift: ${JSON.stringify(changes)}`);
});

test('a genuine move is still reported, as a move', () => {
  const baselineTree = {
    nodes: [node('root', { summary: 'Root', subtasks: [], parent: null }),
      node('child', { summary: 'Child', subtasks: [], parent: { id: '1' } }, 'root')]
  };
  const currentTree = {
    nodes: [node('root', { summary: 'Root', subtasks: [], parent: null }),
      node('child', { summary: 'Child', subtasks: [], parent: { id: '7' } }, 'elsewhere')]
  };
  const { changes } = diffTree({ baselineTree, currentTree, controlledFields });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'NODE_MOVED');
});

test('the plan never asks Jira to write a field Jira does not accept', () => {
  const baselineTree = {
    nodes: [node('root', { summary: 'Approved', subtasks: [{ id: '2' }], parent: null })],
    values: { root: project({ summary: 'Approved', subtasks: [{ id: '2' }], parent: null }, controlledFields).raw }
  };
  const currentTree = { nodes: [node('root', { summary: 'Edited', subtasks: [], parent: null })] };

  const plan = planTreeRestore({ baselineTree, currentTree, controlledFields });
  for (const step of plan.steps) {
    assert.ok(!step.fieldIds.includes('subtasks'),
      `subtasks is read-only in Jira and must never reach a field write: ${JSON.stringify(step)}`);
    assert.ok(!step.fieldIds.includes('parent'),
      `parent is restored by moving the node, never by a field write: ${JSON.stringify(step)}`);
  }
});

// ── One refusal must not throw away the rest of the restore ──────────────────

test('a step Jira refuses does not abandon the independent work after it', async () => {
  const steps = [
    { stepKey: 'a', kind: 'RESTORE_FIELDS', logicalNodeId: 'n1', parentLogicalNodeId: null, fieldIds: ['summary'], fields: { summary: 'a' } },
    { stepKey: 'b', kind: 'RESTORE_FIELDS', logicalNodeId: 'n2', parentLogicalNodeId: null, fieldIds: ['summary'], fields: { summary: 'b' } },
    { stepKey: 'c', kind: 'RESTORE_FIELDS', logicalNodeId: 'n3', parentLogicalNodeId: null, fieldIds: ['summary'], fields: { summary: 'c' } }
  ];
  const finished = [];
  const adapters = {
    checkPermissions: async () => true,
    readRestoreActions: async () => [],
    readReplacements: async () => [],
    claimRestoreAction: async () => true,
    finishRestoreAction: async (_id, stepKey, ok, error) => { finished.push({ stepKey, ok, error }); return true; },
    recordReplacement: async () => {},
    editIssue: async target => {
      if (target === 'n2') {
        const error = new Error('Field cannot be set');
        error.status = 400;
        throw error;
      }
      return {};
    }
  };
  const baselineTree = { nodes: [{ logicalNodeId: 'n1', issueKey: 'n1' }, { logicalNodeId: 'n2', issueKey: 'n2' },
    { logicalNodeId: 'n3', issueKey: 'n3' }] };

  const result = await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'n1', baselineTree,
    currentTree: { nodes: [] }, controlledFields, adapters, plan: { steps }, maxActions: 10 });

  assert.ok(finished.some(f => f.stepKey === 'c' && f.ok),
    `the third step is independent of the refused second and must still run: ${JSON.stringify(finished)}`);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].stepKey, 'b');
  assert.equal(result.remaining, 0, 'a refused step is settled, not left outstanding for ever');
});

test('a systemic Jira failure still stops the batch so it can be retried', async () => {
  const steps = [
    { stepKey: 'a', kind: 'RESTORE_FIELDS', logicalNodeId: 'n1', parentLogicalNodeId: null, fieldIds: ['summary'], fields: { summary: 'a' } },
    { stepKey: 'b', kind: 'RESTORE_FIELDS', logicalNodeId: 'n2', parentLogicalNodeId: null, fieldIds: ['summary'], fields: { summary: 'b' } }
  ];
  const attempted = [];
  const adapters = {
    checkPermissions: async () => true,
    readRestoreActions: async () => [],
    readReplacements: async () => [],
    claimRestoreAction: async () => true,
    finishRestoreAction: async () => true,
    recordReplacement: async () => {},
    editIssue: async target => {
      attempted.push(target);
      const error = new Error('Too many requests');
      error.status = 429;
      throw error;
    }
  };
  const result = await executeTreeRestore({ restoreId: 'r', rootIssueKey: 'n1',
    baselineTree: { nodes: [{ logicalNodeId: 'n1', issueKey: 'n1' }, { logicalNodeId: 'n2', issueKey: 'n2' }] },
    currentTree: { nodes: [] }, controlledFields, adapters, plan: { steps }, maxActions: 10 });

  assert.deepEqual(attempted, ['n1'], 'a rate limit must not be burned through on every remaining step');
  assert.equal(result.stopped, true);
  assert.ok(result.remaining > 0);
});

// ── The verifier has to say what did not match ───────────────────────────────

test('an unmatched field is named, with the approved and observed digests', async () => {
  const approved = project({ summary: 'Approved', subtasks: [], parent: null }, controlledFields);
  const baselineTree = {
    nodes: [{ logicalNodeId: 'root', originalIssueId: 1, currentIssueId: 1, issueKey: 'VJIRA-16',
      parentLogicalId: null, digests: approved.digests }]
  };
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ tree: { nodes: [{ id: '1', key: 'VJIRA-16',
      fields: { summary: 'Still wrong', subtasks: [], parent: null, status: { id: '3' } } }] } }),
    readTree: async () => {}, rootIssueKey: 'VJIRA-16', baselineTree, controlledFields, replacements: []
  });

  assert.equal(verified.matches, false);
  const [unmatched] = verified.unmatched ?? [];
  assert.ok(unmatched, 'a verification that refuses to say COMPLETE must name what stopped it');
  assert.equal(unmatched.fieldId, 'summary');
  assert.equal(unmatched.fieldName, 'Summary');
  assert.equal(unmatched.issueKey, 'VJIRA-16');
  assert.equal(unmatched.expected, approved.digests.summary);
  assert.ok(unmatched.actual && unmatched.actual !== unmatched.expected);
  assert.ok(typeof unmatched.reason === 'string' && unmatched.reason.length > 0);
});

// ── The worker must not claim an unverified restore is clean ─────────────────

function workerFixture(verifyResult) {
  const calls = [];
  const restore = { restore_id: Buffer.alloc(16, 1), approval_id: Buffer.alloc(16, 3),
    baseline_id: Buffer.alloc(16, 2), baseline_version: 3, actor_account_id: 'reviewer',
    state: 'QUEUING', total_steps: 1, completed_steps: 0, detail: { actionPlan: [{ stepKey: 's1' }] } };
  return {
    calls,
    deps: {
      restoreById: async () => restore,
      activeBaseline: async () => ({ baseline_id: Buffer.alloc(16, 2), version: 3 }),
      approvalById: async () => ({ decision: 'REJECT', approval_id: Buffer.alloc(16, 3) }),
      claimRestore: async () => true,
      heartbeatRestore: async () => {},
      beginRestoreVerification: async () => true,
      finishRestore: async args => { calls.push(['finish', args.state]); restore.state = args.state; },
      failRestore: async () => { calls.push(['fail']); },
      markRestoreQueued: async () => {},
      markRestoreQueueFailure: async () => {},
      markDecided: async () => { calls.push(['decided']); },
      release: async args => { calls.push(['release', args.state, args.counters?.driftCount]); },
      append: async args => { calls.push(['append', args.eventType]); },
      enqueue: async () => ({ jobId: 'j' }),
      prepare: async () => ({ issue: { id: '10', key: 'T-10' }, issueId: 10, projectId: 1,
        baseline: { baseline_id: Buffer.alloc(16, 2), version: 3 }, fields: controlledFields,
        baselineTree: { nodes: [] }, currentTree: { nodes: [] } }),
      executeBatch: async () => ({ state: 'READY_TO_VERIFY', attempted: 1, completed: 1, remaining: 0, refused: [] }),
      verify: async () => verifyResult
    }
  };
}

const workerBody = { restoreId: Buffer.alloc(16, 1).toString('base64'), issueId: 10,
  baselineId: Buffer.alloc(16, 2).toString('base64'), baselineVersion: 3 };

test('a restore the verifier refused is never recorded as completed and baselined', async () => {
  const { calls, deps } = workerFixture({ matches: false, progress: true, statusMatches: true,
    changes: [{ kind: 'FIELD_CHANGED', logicalNodeId: 'root', fields: ['summary'] }],
    unmatched: [{ fieldId: 'summary', fieldName: 'Summary', issueKey: 'T-10', expected: 'a', actual: 'b', reason: 'x' }] });

  const result = await runRestoreWorker(workerBody, deps);

  assert.equal(result.state, 'PARTIAL');
  assert.ok(!calls.some(c => c[0] === 'decided'),
    'drift must not be marked decided while tracked fields still differ from the baseline');
  const release = calls.find(c => c[0] === 'release');
  assert.ok(release && release[1] !== 'BASELINED',
    `an unverified restore must not release the item as BASELINED: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some(c => c[0] === 'append' && String(c[1]).includes('RESTORE_COMPLETED')),
    'the ledger must not record RESTORE_COMPLETED for a restore that did not complete');
});

test('a verified restore is still recorded as completed and baselined', async () => {
  const { calls, deps } = workerFixture({ matches: true, progress: true, statusMatches: true, changes: [], unmatched: [] });
  const result = await runRestoreWorker(workerBody, deps);
  assert.equal(result.state, 'COMPLETE');
  assert.ok(calls.some(c => c[0] === 'decided'));
  assert.ok(calls.some(c => c[0] === 'release' && c[1] === 'BASELINED'));
});

test('a restore whose permission preflight fails is settled, not requeued for ever', async () => {
  const { calls, deps } = workerFixture({ matches: true, changes: [] });
  deps.executeBatch = async () => ({ state: 'FAILED', attempted: 0, completed: 0, remaining: 4, replacements: [] });
  let enqueued = 0;
  deps.enqueue = async () => { enqueued += 1; return { jobId: 'j' }; };

  const result = await runRestoreWorker(workerBody, deps);

  assert.equal(enqueued, 0, `a batch that could do nothing must not be handed straight back to the queue: ${JSON.stringify(calls)}`);
  assert.equal(result.state, 'FAILED');
});

// ── A retry of a tree restore has to be possible ─────────────────────────────

test('a tree restore that already wrote the approved values can still be retried', () => {
  // The three sides of this comparison have to be computed over the same node
  // and the same fields. A tree baseline keeps its digests per node and writes
  // va_baseline.field_digests as '{}', so reading the column left the approved
  // value out of the permitted set and refused every retry that had worked.
  const baseline = { tree_hash: 't'.repeat(64), field_digests: '{}' };
  const baselineTree = { nodes: [{ logicalNodeId: 'root', originalIssueId: 66430,
    parentLogicalNodeId: null, digests: { summary: 'approved', duedate: 'approved-due' } }] };

  const approved = approvedDigestsFor({ baseline, baselineTree, issueId: 66430 });
  assert.deepEqual(approved, { summary: 'approved', duedate: 'approved-due' },
    'a tree baseline keeps its approved digests on the node, not on the baseline row');

  const check = resumable({
    baselineDigests: comparableDigests(approved),
    candidateDigests: comparableDigests({ summary: 'rejected', duedate: 'rejected-due' }),
    currentDigests: comparableDigests({ summary: 'approved', duedate: 'approved-due' })
  });
  assert.equal(check.ok, true, `restored values are on the signed path and must permit a retry: ${JSON.stringify(check)}`);
});

test('a single-issue baseline still resumes from its own stored digests', () => {
  const approved = approvedDigestsFor({ baseline: { field_digests: '{"summary":"approved"}' },
    baselineTree: null, issueId: 1 });
  assert.deepEqual(approved, { summary: 'approved' });
});

test('a retry is not refused because the tree moved a node it was supposed to move', () => {
  // `parent` and `subtasks` are Jira ids the restore itself changes. Comparing
  // them field-by-field here would report the app's own correct work as an
  // outside edit and refuse the retry.
  const check = resumable({
    baselineDigests: comparableDigests({ summary: 'approved', subtasks: 'old-ids', parent: 'old-parent' }),
    candidateDigests: comparableDigests({ summary: 'rejected', subtasks: 'old-ids', parent: 'old-parent' }),
    currentDigests: comparableDigests({ summary: 'approved', subtasks: 'new-ids', parent: 'new-parent' })
  });
  assert.equal(check.ok, true, `structural ids must not block a retry: ${JSON.stringify(check)}`);
});
