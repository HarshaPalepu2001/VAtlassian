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
