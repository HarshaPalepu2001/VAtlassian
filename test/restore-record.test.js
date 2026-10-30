import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * Record a completed restore.
 *
 * The panel summarizes a finished restore on the Baseline card, and the
 * review window lists each restore in the Baseline record. Both need the
 * actor, completion time, and restored version from the restore row and its
 * reject approval.
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
    if (specifier === '@forge/api') return { url: 'fixture:viewer-api', shortCircuit: true };
    let resolved = specifier;
    try { resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL || 'file:///').pathname : specifier; } catch {}
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:viewer-api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({ requestJira: (...a) => globalThis.vaRestore.request(...a) }) };` };
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
  assert.match(result.restores[1].error, /Restore could not be completed/);
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

test('a retry resumes a per-field decision\'s restore under its own signature, and refuses any other kind of approval', async () => {
  for (const [decision, expected] of [['MIXED', 'RESTORING'], ['REJECT', 'RESTORING'], ['APPROVE', undefined]]) {
    const { args } = retryFixture();
    const original = globalThis.vaRestore.approvalById;
    globalThis.vaRestore.approvalById = async id => ({ ...(await original(id)), decision });
    const result = await retry(args);
    assert.equal(result.state, expected, decision);
    if (expected === undefined) assert.equal(result.reason, 'NOT_ELIGIBLE');
  }
});


test('restore:getState retains progress and visible child detail without exposing worker plans or protected children', async () => {
  const source = { restore_id: 'cg==', state: 'PARTIAL', total_steps: 5, completed_steps: 2,
    last_error: 'SECRET-99 hidden-error', candidate_digests: { tree: 'hidden-candidate' },
    detail: [{ unmatched: [{ issueKey: 'T-11', actual: 'visible-current' },
      { issueKey: 'SECRET-99', actual: 'hidden-current' }, { issueKey: 'NEW-777', actual: 'hidden-new' }],
      refused: [{ issueKey: 'SECRET-99', error: { detail: 'hidden-refused' } }],
      verification: { changes: [{ issueId: 99, actual: 'hidden-change' }] },
      plan: { steps: [{ issueKey: 'SECRET-99', values: { summary: 'hidden-plan' } }] } }]
  };
  const original = JSON.stringify(source);
  globalThis.vaRestore = {
    load: async () => ({ issueId: 10, issue: { id: '10', key: 'T-10' }, tree: { nodes: [
      { id: '10', key: 'T-10' }, { id: '11', key: 'T-11' }, { id: '99', key: 'SECRET-99' }
    ] } }),
    restoresForIssue: async () => [source], approvalById: async () => null,
    request: async (url, options) => ({ ok: true, json: async () => String(url).includes('/permissions/check')
      ? { projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [11] }] }
      : { issues: [], isLast: true } })
  };
  const result = await getState(args);
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.restores[0].progress, { totalSteps: 5, completedSteps: 2, remainingSteps: 3 });
  assert.equal(result.restores[0].detail[0].unmatched[0].actual, 'visible-current');
  assert.doesNotMatch(JSON.stringify(result), /SECRET-99|NEW-777|hidden-|candidate_digests|"plan"/);
  assert.equal(JSON.stringify(source), original);
});


test('retrying an already complete restore returns viewer evidence rather than its raw signed candidate or worker detail', async () => {
  const { args } = retryFixture({ restoreState: 'COMPLETE' });
  const read = globalThis.vaRestore.restoreById;
  globalThis.vaRestore.restoreById = async (...args) => ({ ...await read(...args),
    detail: [{ unmatched: [{ issueKey: 'SECRET-99', actual: 'hidden-current' }] }], last_error: 'SECRET-99 hidden-error' });
  const result = await retry(args);
  assert.equal(result.success, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-99|hidden-|candidate_digests/);
});

test('restore state and completed retry suppress opaque nested worker errors while retaining safe verification guidance', async () => {
  const { opaqueRestoreEvidence, safeVerificationGuidance, assertOpaqueEvidenceHidden } = await import('./helpers/opaque-restore-evidence.js');
  const { args } = retryFixture({ restoreState: 'COMPLETE' });
  const read = globalThis.vaRestore.restoreById;
  const row = { ...await read(), detail: opaqueRestoreEvidence() };
  globalThis.vaRestore.restoreById = async () => row;
  globalThis.vaRestore.restoresForIssue = async () => [row];
  const prepared = globalThis.vaRestore.load;
  globalThis.vaRestore.load = async () => ({ ...await prepared(), issue: { id: '10', key: 'T-10' },
    tree: { nodes: [{ id: '99', key: 'SECRET-99' }] } });
  globalThis.vaRestore.request = async () => ({ ok: true,
    json: async () => ({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [] }] }) });
  const before = JSON.stringify(row);
  for (const readResponse of [getState, retry]) {
    const result = await readResponse(args);
    assert.equal(result.reason, undefined);
    assertOpaqueEvidenceHidden(assert, result);
    const visible = result.restores?.[0] ?? result.restore;
    assert.equal(visible.detail[0].unmatched[2].reason, safeVerificationGuidance);
    assert.ok(visible.detail[0].refused[0].error.detail);
  }
  assert.equal(JSON.stringify(row), before);
});
