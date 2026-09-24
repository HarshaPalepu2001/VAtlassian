import { test } from 'node:test';
import assert from 'node:assert';
import {
  GovernedObjectRef,
  ContentSnapshot,
  GovernancePolicy,
  JiraAdapter,
  FakeConfluenceAdapter
} from '../src/lib/governanceCore.js';

test('JiraAdapter passes existing behavior', async (t) => {
  const adapter = new JiraAdapter();
  assert.strictEqual(adapter.product, 'jira');
  const ref = new GovernedObjectRef('jira', 't1', 'space1', 'page', 'p1', 1);
  assert.strictEqual(await adapter.read(ref), null);
  assert.strictEqual(await adapter.stableCapture(ref), null);
});

test('FakeConfluenceAdapter passes contracts', async (t) => {
  const adapter = new FakeConfluenceAdapter();
  assert.strictEqual(adapter.product, 'confluence');
  
  const ref = new GovernedObjectRef('confluence', 't1', 'space1', 'page', 'p1', 1);
  const snapshot = new ContentSnapshot('body', 'title', {}, [], [], []);
  
  adapter.pages.set('p1', { body: 'body', title: 'title' });
  
  const readRes = await adapter.read(ref);
  assert.strictEqual(readRes.body, 'body');
  
  const captureRes = await adapter.stableCapture(ref);
  assert.strictEqual(captureRes.body, 'body');
  
  const diffRes = await adapter.diff(ref, snapshot);
  assert.deepStrictEqual(diffRes, []);
  
  const lockRes = await adapter.lock(ref);
  assert.strictEqual(lockRes, true);
  
  const wcRes = await adapter.createWorkingCopy(ref);
  assert.strictEqual(wcRes.contentId, 'p1_wc');
  
  const promoteRes = await adapter.promote(wcRes);
  assert.strictEqual(promoteRes, true);
  const promotedPage = await adapter.read(ref);
  assert.strictEqual(promotedPage.body, 'promoted');
  
  const restoreRes = await adapter.restore(ref, snapshot);
  assert.strictEqual(restoreRes, true);
  
  const verifyRes = await adapter.verify(ref, snapshot);
  assert.strictEqual(verifyRes, true);
  
  const reconcileRes = await adapter.reconcile(ref);
  assert.strictEqual(reconcileRes, true);
});
