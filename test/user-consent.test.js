import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { respond, retryGuidance } from '../src/usecases/access.js';
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

test('retryGuidance never echoes a 403/404 status: that would hand back the one distinction NOT_FOUND exists to hide', async () => {
  // testmgmt/jira.js's json() collapses both into the same reason precisely so
  // a caller can never tell "exists but you can't see it" from "does not
  // exist". This prevents an existence oracle. The raw status must not leak.
  assert.deepEqual(retryGuidance(Object.assign(new Error('nope'), { status: 403 })), {});
  assert.deepEqual(retryGuidance(Object.assign(new Error('nope'), { status: 404 })), {});
  assert.deepEqual(
    await respond(async () => { throw Object.assign(new Error('nope'), { reason: 'NOT_FOUND', status: 403 }); }),
    { error: 'nope', reason: 'NOT_FOUND' },
    'the envelope the client sees carries no status field for this case'
  );
});

test('retryGuidance forwards status and retryAfterMs only for a genuinely transient failure', () => {
  assert.deepEqual(retryGuidance(Object.assign(new Error('nope'), { status: 429, retryAfterMs: 3000 })),
    { status: 429, retryAfterMs: 3000 });
  assert.deepEqual(retryGuidance(Object.assign(new Error('nope'), { status: 503, retryAfterMs: 1500 })),
    { status: 503, retryAfterMs: 1500 });
  assert.deepEqual(retryGuidance(Object.assign(new Error('nope'), { status: 500, retryAfterMs: 1500 })), {},
    'an ordinary server error is not a documented transient signal, so nothing is forwarded for it');
  assert.deepEqual(retryGuidance(new Error('nope')), {}, 'no status at all forwards nothing');
});

test('signing lets a missing user consent reach Forge', async () => {
  const { createApprovalUsecases } = await import('../src/usecases/approval.js');
  const api = createApprovalUsecases({ issue: async () => { throw consentNeeded(); } });
  await assert.rejects(() => api.challenge({ payload: { decision: 'APPROVE', issueKey: 'VAT-1' }, context: { accountId: 'a' } }),
    { name: 'NEEDS_AUTHENTICATION_ERR' });
});
