import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { respond } from '../src/usecases/access.js';
import { fixture, request } from './admin-fixture.js';

// What @forge/api throws from asUser() for somebody who has never clicked
// "Allow access". Forge shows its consent screen only if this reaches the
// platform; caught and turned into a message, the person is simply refused.
const consentNeeded = () => Object.assign(new Error('Authentication Required'), { name: 'NEEDS_AUTHENTICATION_ERR' });

test('the administration check lets a missing user consent reach Forge', async () => {
  const deps = fixture({ unauthorized: true });
  deps.isJiraAdmin = async () => { throw consentNeeded(); };
  await assert.rejects(() => admin.check(request(), deps), { name: 'NEEDS_AUTHENTICATION_ERR' });
});

test('any other failed Jira-administrator read still reads as not an administrator', async () => {
  const deps = fixture({ unauthorized: true });
  deps.isJiraAdmin = async () => { throw new Error('Could not verify Jira administrator permission.'); };
  const result = await admin.check(request(), deps);
  assert.equal(result.isAdmin, false);
  assert.equal(result.isJiraAdmin, false);
});

test('bootstrap and roster actions let a missing user consent reach Forge', async () => {
  for (const name of ['bootstrap', 'listAdmins', 'grantAdmin']) {
    const deps = fixture({ unauthorized: true });
    deps.isJiraAdmin = async () => { throw consentNeeded(); };
    await assert.rejects(() => admin[name](request({ targetAccountId: 'someone' }), deps), { name: 'NEEDS_AUTHENTICATION_ERR' }, name);
  }
});

test('panel and queue resolvers let a missing user consent reach Forge', async () => {
  await assert.rejects(() => respond(async () => { throw consentNeeded(); }), { name: 'NEEDS_AUTHENTICATION_ERR' });
  assert.deepEqual(await respond(async () => { throw Object.assign(new Error('nope'), { reason: 'NOT_ELIGIBLE' }); }),
    { error: 'You are not an eligible reviewer for this work item, so this transition was blocked.', reason: 'NOT_ELIGIBLE' });
});

test('signing lets a missing user consent reach Forge', async () => {
  const { createApprovalUsecases } = await import('../src/usecases/approval.js');
  const api = createApprovalUsecases({ issue: async () => { throw consentNeeded(); } });
  await assert.rejects(() => api.challenge({ payload: { decision: 'APPROVE', issueKey: 'VAT-1' }, context: { accountId: 'a' } }),
    { name: 'NEEDS_AUTHENTICATION_ERR' });
});
