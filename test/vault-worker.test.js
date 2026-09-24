import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runVaultWorker } from '../src/jobs/vaultWorker.js';

function baseBody() {
  return { baselineId: 'b1', issueId: 42, issueKey: 'ENG-1', projectId: 7 };
}

function baseOverrides(overrides = {}) {
  return {
    ensureVaultSpace: async () => ({ spaceId: 's1', spaceKey: 'VATVAULT', projectPageId: 'pp1' }),
    getVaultPage: async () => ({ confluence_page_id: 'p1' }),
    insertVaultPage: async () => {},
    findPageByTitle: async () => null,
    createVaultPage: async () => ({ id: 'p1' }),
    isAttachmentVaulted: async () => false,
    insertVaultAttachment: async () => 'va1',
    uploadAttachmentToPage: async () => ({ id: 'catt1' }),
    readIssueAttachments: async () => [{ id: 'a1', filename: 'x.png' }],
    downloadAttachment: async () => Buffer.from('bytes'),
    tryAppend: async () => {},
    now: () => 1000,
    ...overrides
  };
}

test('rejects a body missing required fields', async () => {
  const result = await runVaultWorker({ body: { issueId: 42 } }, baseOverrides());
  assert.equal(result.state, 'FAILED');
  assert.equal(result.reason, 'INVALID_BODY');
});

test('creates the issue page under its project page when none exists yet', async () => {
  const calls = [];
  const overrides = baseOverrides({
    getVaultPage: async () => null,
    createVaultPage: async (args) => { calls.push(args); return { id: 'new-p1' }; },
    insertVaultPage: async (args) => calls.push(args)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.state, 'COMPLETE');
  assert.deepEqual(calls[0], { spaceId: 's1', parentId: 'pp1', issueKey: 'ENG-1' });
  assert.equal(calls[1].confluencePageId, 'new-p1');
});

test('an issue page orphaned by an earlier failed run is found by title, not duplicated', async () => {
  let created = 0;
  const recorded = [];
  const overrides = baseOverrides({
    getVaultPage: async () => null,
    findPageByTitle: async ({ title }) => (title === 'ENG-1' ? { id: 'p-old' } : null),
    createVaultPage: async () => { created += 1; return { id: 'p-new' }; },
    insertVaultPage: async (args) => recorded.push(args)
  });
  await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(created, 0);
  assert.equal(recorded[0].confluencePageId, 'p-old');
});

test('vaults every current attachment, named by its Jira id so two same-named files never collide', async () => {
  const uploaded = [];
  const recorded = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: 'a1', filename: 'one.png' }, { id: 'a2', filename: 'one.png' }],
    downloadAttachment: async (a) => Buffer.from(a.id),
    uploadAttachmentToPage: async (args) => { uploaded.push(args.filename); return { id: `c-${args.filename}` }; },
    insertVaultAttachment: async (args) => { recorded.push(args); return 'row-id'; }
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.vaulted, 2);
  assert.deepEqual(uploaded, ['a1-one.png', 'a2-one.png']);
  assert.equal(recorded[0].filename, 'one.png', 'the ledger keeps the original Jira filename');
  assert.equal(recorded[0].contentHash, createHash('sha256').update(Buffer.from('a1')).digest('hex'));
});

test('skips an attachment already vaulted for this baseline (queues redeliver)', async () => {
  const overrides = baseOverrides({
    isAttachmentVaulted: async ({ jiraAttachmentId }) => jiraAttachmentId === 'a1',
    readIssueAttachments: async () => [{ id: 'a1', filename: 'one.png' }, { id: 'a2', filename: 'two.png' }]
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.skipped, 1);
  assert.equal(result.vaulted, 1);
});

test('one failed attachment does not stop the rest and is recorded as failed', async () => {
  let call = 0;
  const auditedEvents = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: 'a1', filename: 'bad.png' }, { id: 'a2', filename: 'good.png' }],
    downloadAttachment: async () => { call += 1; if (call === 1) throw new Error('network blip'); return Buffer.from('ok'); },
    tryAppend: async (event) => auditedEvents.push(event.eventType)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.failed, 1);
  assert.equal(result.vaulted, 1);
  assert.ok(auditedEvents.includes('ATTACHMENT_VAULT_FAILED'));
  assert.ok(auditedEvents.includes('ATTACHMENT_VAULTED'));
});

test('provisions the project into the vault lazily when the eager attempt never happened', async () => {
  const calls = [];
  const overrides = baseOverrides({ ensureVaultSpace: async (projectId) => { calls.push(projectId); return { spaceId: 's1', projectPageId: 'pp1' }; } });
  await runVaultWorker({ body: baseBody() }, overrides);
  assert.deepEqual(calls, [7]);
});

test('an issue with no attachments still gets its page and completes', async () => {
  const result = await runVaultWorker({ body: baseBody() }, baseOverrides({ readIssueAttachments: async () => [] }));
  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.vaulted, 0);
});
