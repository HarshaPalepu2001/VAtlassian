import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * WHAT A FINISHED RESTORE LEAVES ON THE RECORD.
 *
 * The panel folds a finished restore into one line on the Baseline card, and
 * the review window's Baseline record lists every restore. Both need who
 * triggered it, when it finished, and which version it put the item back to —
 * all already on the restore row and its reject approval.
 */

const modules = {
  'usecases/panelAccess.js': ['load'],
  'db/restoreStore.js': ['restoresForIssue', 'restoreById', 'markRestoreQueued', 'markRestoreQueueFailure'],
  'db/approvalStore.js': ['approvalById'],
  'db/restoreTreeStore.js': ['clearRefusedRestoreActions'],
  'db/itemStateStore.js': ['acquire'],
  'lib/restore/queue.js': ['enqueueRestore'],
  'lib/reviewer.js': ['isEligible']
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    let resolved = specifier;
    try { resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL || 'file:///').pathname : specifier; } catch {}
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const names = modules[url.slice(8)];
    if (!names) return next(url, context);
    const access = url.endsWith('panelAccess.js')
      ? `export { respond, fail } from ${JSON.stringify(new URL('../src/usecases/access.js', import.meta.url).href)};` : '';
    return { format: 'module', shortCircuit: true,
      source: access + names.map(n => `export const ${n} = (...a) => globalThis.vaRestore.${n}(...a);`).join('\n') };
  }
});
const { getState } = await import('../src/usecases/restore.js');
hooks.deregister();

const args = { payload: { issueKey: 'T-10' }, context: { accountId: 'reviewer-1' } };

test('each restore says who triggered it, when it ran, and which version it restored to', async () => {
  const lookups = [];
  globalThis.vaRestore = {
    load: async () => ({ issueId: 10 }),
    restoresForIssue: async () => [
      { restore_id: 'cg==', approval_id: 'YQ==', state: 'COMPLETE', started_at: 1000, finished_at: 5000, baseline_version: 3 },
      { restore_id: 'cw==', approval_id: 'YQ==', state: 'FAILED', started_at: 500, finished_at: 900, baseline_version: 3, last_error: 'Jira refused' },
      { restore_id: 'dA==', approval_id: 'Yg==', state: 'RUNNING', started_at: 6000, finished_at: null, baseline_version: 3 }
    ],
    approvalById: async id => { lookups.push(id); return id === 'YQ==' ? { printed_name: 'Priya Raman', actor_name: 'priya' } : null; }
  };

  const result = await getState(args);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.restores.map(r => [r.actorName, r.startedAt, r.finishedAt, r.baselineVersion]), [
    ['Priya Raman', 1000, 5000, 3],
    ['Priya Raman', 500, 900, 3],
    [null, 6000, null, 3]
  ]);
  assert.equal(result.restores[1].error, 'Jira refused');
  assert.deepEqual(lookups.sort(), ['YQ==', 'Yg=='], 'each approval is read once, however many restores it started');
});

test('an unreadable approval leaves the restore listed without a name', async () => {
  globalThis.vaRestore = {
    load: async () => ({ issueId: 10 }),
    restoresForIssue: async () => [{ restore_id: 'cg==', approval_id: 'YQ==', state: 'COMPLETE', started_at: 1, finished_at: 2, baseline_version: 1 }],
    approvalById: async () => { throw new Error('storage unavailable'); }
  };

  const result = await getState(args);

  assert.equal(result.error, undefined);
  assert.equal(result.restores[0].actorName, null);
  assert.equal(result.restores[0].finishedAt, 2);
});

const { retry } = await import('../src/usecases/restore.js');
const bid = Buffer.alloc(16, 2);

/** A FAILED restore of baseline v3 that a Retry could resume, and a record of what the retry touched. */
function retryFixture({ restoreState = 'FAILED', others = [], acquired = true } = {}) {
  const touched = [];
  const restore = { restore_id: Buffer.alloc(16, 1), approval_id: Buffer.alloc(16, 3), issue_id: 10,
    baseline_id: bid, baseline_version: 3, state: restoreState, total_steps: 2, completed_steps: 1,
    candidate_digests: { summary: 'candidate' } };
  globalThis.vaRestore = {
    load: async () => ({ issueId: 10, projectId: 1, issueTypeId: '5', baselineVersion: 3,
      actor: { accountId: 'reviewer-1' }, review: { version: 7, state: 'ERROR' }, digests: { summary: 'candidate' },
      baseline: { baseline_id: bid, version: 3, field_digests: JSON.stringify({ summary: 'approved' }),
        transition_id: '21', from_status_id: '1', to_status_id: '3', required_role: 'QA',
        required_assurance: 'ESIGNATURE', controlled_fields_hash: 'a'.repeat(64) } }),
    restoreById: async () => restore,
    restoresForIssue: async () => [restore, ...others],
    isEligible: async () => true,
    approvalById: async () => ({ decision: 'REJECT', actor_account_id: 'reviewer-1' }),
    clearRefusedRestoreActions: async () => { touched.push('reopen'); },
    acquire: async () => { touched.push('acquire'); return { acquired }; },
    enqueueRestore: async () => { touched.push('enqueue'); return { jobId: 'job-2' }; },
    markRestoreQueued: async () => { touched.push('queued'); },
    markRestoreQueueFailure: async () => { touched.push('queue-failed'); }
  };
  return { touched, args: { payload: { issueKey: 'T-10', restoreId: 'AQ==' }, context: { accountId: 'reviewer-1' } } };
}

test('a retry resumes a failed restore when nothing else is restoring the item', async () => {
  const { touched, args } = retryFixture();
  const result = await retry(args);
  assert.equal(result.error, undefined);
  assert.equal(result.state, 'RESTORING');
  assert.deepEqual(touched, ['acquire', 'reopen', 'enqueue', 'queued'], 'refused actions reopen only once the lock is held');
});

test('a retry is refused while another restore of the same item is still running', async () => {
  const { touched, args } = retryFixture({ others: [{ restore_id: Buffer.alloc(16, 9), state: 'RESTORING', baseline_version: 3 }] });
  const result = await retry(args);
  assert.equal(result.reason, 'ALREADY_RESTORING');
  assert.deepEqual(touched, [], 'nothing reopened, locked or queued underneath the running restore');
});

test('a retry is refused while the restore is verifying its own writes', async () => {
  const { touched, args } = retryFixture({ restoreState: 'VERIFYING' });
  const result = await retry(args);
  assert.equal(result.reason, 'ALREADY_RESTORING');
  assert.deepEqual(touched, []);
});

test('a retry that cannot take the lock reopens nothing', async () => {
  const { touched, args } = retryFixture({ acquired: false });
  const result = await retry(args);
  assert.equal(result.reason, 'ALREADY_DECIDING');
  assert.deepEqual(touched, ['acquire']);
});

test('each restore says whether this viewer may retry it: only the reviewer who rejected', async () => {
  globalThis.vaRestore = {
    load: async () => ({ issueId: 10, actor: { accountId: 'reviewer-1' } }),
    restoresForIssue: async () => [
      { restore_id: 'cg==', approval_id: 'YQ==', state: 'PARTIAL', actor_account_id: 'reviewer-1', baseline_version: 3 },
      { restore_id: 'cw==', approval_id: 'Yg==', state: 'FAILED', actor_account_id: 'reviewer-2', baseline_version: 3 }
    ],
    approvalById: async () => null
  };
  const result = await getState(args);
  assert.deepEqual(result.restores.map(r => r.canRetry), [true, false]);
});
