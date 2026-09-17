import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { run as runUpdated } from '../src/triggers/issue-updated.js';
import { run as runDeleted } from '../src/triggers/issue-deleted.js';
import { run as runCreated } from '../src/triggers/issue-created.js';
import { collectAffectedTrees } from '../src/lib/collect.js';

let _collectCalls = [];
let _driftKinds = [];

function fixture() {
  return {
    collectCalls: _collectCalls,
    driftKinds: _driftKinds,
    deps: {
      affectedTreeRoots: async () => [{ rootIssueId: 1, rootIssueKey: 'FEAT-1' }],
      collectAffectedTrees,
      collectTree: async (args) => {
        _collectCalls.push({ rootIssueId: args.rootIssueId, rootIssueKey: args.rootIssueKey });
        if (args.eventId === 'e2') { _driftKinds.push('NODE_REMOVED'); }
        if (args.eventId === 'e3') { _driftKinds.push('NODE_ADDED'); }
        return { outcome: 'DRIFT_RECORDED', kinds: _driftKinds };
      },
      collect: async () => ({ outcome: 'NO_CHANGE' }), recordReceipt: async () => {}
    }
  };
}

function grandchildEvent() { return { issue: { id: '3', key: 'FEAT-3' }, eventId: 'e1' }; }
function deletedStoryEvent() { return { issue: { id: '2', key: 'FEAT-2' }, eventId: 'e2' }; }
function createdSubtaskEvent() { return { issue: { id: '4', key: 'FEAT-4' }, eventId: 'e3' }; }

test('a grandchild update wakes its active governed root', async () => {
  _collectCalls = []; _driftKinds = [];
  const result = await runUpdated(grandchildEvent(), fixture().deps);
  assert.deepEqual(fixture().collectCalls, [{ rootIssueId: 1, rootIssueKey: 'FEAT-1' }]);
  assert.equal(result.outcome, 'DRIFT_RECORDED');
});

test('deleting a baseline child records NODE_REMOVED on the root', async () => {
  _collectCalls = []; _driftKinds = [];
  await runDeleted(deletedStoryEvent(), fixture().deps);
  assert.deepEqual(fixture().driftKinds, ['NODE_REMOVED']);
});

test('creating a new descendant records NODE_ADDED on the root', async () => {
  _collectCalls = []; _driftKinds = [];
  await runCreated(createdSubtaskEvent(), fixture().deps);
  assert.deepEqual(fixture().driftKinds, ['NODE_ADDED']);
});

test('created trigger treats Forge context as context, not injected dependencies', async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './runtime.js' && String(context.parentURL).endsWith('/src/triggers/issue-created.js')) {
        return { url: 'fixture:created-runtime', shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === 'fixture:created-runtime') return { format: 'module', shortCircuit: true, source: `
        export async function triggerRuntime() { return globalThis.vaCreatedRuntime; }
      ` };
      return next(url, context);
    }
  });
  globalThis.vaCreatedRuntime = {
    collectAffectedTrees: async () => [{ outcome: 'NO_CHANGE' }],
    affectedTreeRoots: async () => [],
    collectTree: async () => ({ outcome: 'NO_CHANGE' })
  };
  try {
    const result = await runCreated(createdSubtaskEvent(), { cloudId: 'cloud', moduleKey: 'on-issue-created' });
    assert.equal(result.outcome, 'NO_CHANGE');
  } finally {
    delete globalThis.vaCreatedRuntime;
    hooks.deregister();
  }
});
