import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runVaultWorker } from '../src/jobs/vaultWorker.js';

function baseBody() {
  return { baselineId: 'b1', issueId: 42, issueKey: 'ENG-1', projectId: 7 };
}

function baseOverrides(overrides = {}) {
  return {
    isAttachmentVaulted: async () => false,
    insertVaultAttachment: async () => 'va1',
    readIssueAttachments: async () => [{ id: 'a1', filename: 'x.png' }],
    downloadAttachment: async () => Buffer.from('bytes'),
    identityRecords: async () => new Map(),
    mediaIdOf: async () => null,
    vaultedCopies: async () => new Map(),
    putContent: async ({ hash }) => ({ storage: 'OBJECT_STORE', objectKey: `vault/sha256/${hash}` }),
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

test('vaults every current attachment to the Forge Object Store', async () => {
  const recorded = [];
  const puts = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: 'a1', filename: 'one.png' }, { id: 'a2', filename: 'one.png' }],
    downloadAttachment: async (a) => Buffer.from(a.id),
    putContent: async (args) => { puts.push(args); return { storage: 'OBJECT_STORE', objectKey: `vault/sha256/${args.hash}` }; },
    insertVaultAttachment: async (args) => { recorded.push(args); return 'row-id'; }
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.vaulted, 2);
  assert.equal(result.storage, 'OBJECT_STORE');
  assert.equal(recorded[0].filename, 'one.png', 'the ledger keeps the original Jira filename');
  const h1 = createHash('sha256').update(Buffer.from('a1')).digest('hex');
  assert.equal(recorded[0].contentHash, h1);
  assert.equal(recorded[0].storage, 'OBJECT_STORE');
  assert.equal(recorded[0].objectKey, `vault/sha256/${h1}`);
  assert.equal(puts.length, 2);
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

test('an issue with no attachments completes', async () => {
  const result = await runVaultWorker({ body: baseBody() }, baseOverrides({ readIssueAttachments: async () => [] }));
  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.vaulted, 0);
});

test('a baseline that recorded its files vaults exactly those, not whatever is on the issue now', async () => {
  const recorded = [];
  const overrides = baseOverrides({
    // Added after approval, before this job ran: not part of what was signed.
    readIssueAttachments: async () => [{ id: 'a1', filename: 'spec.pdf' }, { id: 'a9', filename: 'late.txt' }],
    insertVaultAttachment: async (args) => recorded.push(args)
  });
  const result = await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', jiraId: 'a1', filename: 'spec.pdf' }] } }, overrides);
  assert.deepEqual(result, { state: 'COMPLETE', storage: 'OBJECT_STORE', vaulted: 1, skipped: 0, failed: 0 });
  assert.deepEqual(recorded.map(r => r.jiraAttachmentId), ['a1']);
});

test('a recorded file gone from the issue is carried forward from its earlier vaulted copy', async () => {
  const recorded = [];
  const audits = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [],
    vaultedCopies: async ({ attachmentIds }) => new Map([[attachmentIds[0], { content_hash: 'h1', storage: 'OBJECT_STORE', object_key: 'vault/sha256/h1' }]]),
    insertVaultAttachment: async (args) => recorded.push(args),
    tryAppend: async (event) => audits.push(event)
  });
  const result = await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', jiraId: 'a1', filename: 'spec.pdf' }] } }, overrides);
  assert.equal(result.vaulted, 1);
  assert.equal(recorded[0].contentHash, 'h1');
  assert.equal(recorded[0].storage, 'OBJECT_STORE');
  assert.equal(recorded[0].objectKey, 'vault/sha256/h1');
  assert.equal(audits[0].payload.carriedForward, true);
});

test('a recorded file gone from the issue and never vaulted is reported, not invented', async () => {
  const audits = [];
  const overrides = baseOverrides({ readIssueAttachments: async () => [], tryAppend: async (event) => audits.push(event) });
  const result = await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', jiraId: 'a1', filename: 'spec.pdf' }] } }, overrides);
  assert.equal(result.failed, 1);
  assert.equal(audits[0].eventType, 'ATTACHMENT_VAULT_FAILED');
  assert.match(audits[0].payload.error, /removed from the work item before it could be vaulted/);
});

test('a restored copy is vaulted under the id of the original it stands for, downloaded by its real id', async () => {
  const downloads = [];
  const recorded = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: '900', filename: 'spec.pdf' }],
    identityRecords: async () => new Map([[42, { files: new Map([['900', 'a1']]), media: new Map([['m-900', 'm-a1']]) }]]),
    mediaIdOf: async () => 'm-900',
    downloadAttachment: async (attachment) => { downloads.push(attachment.jiraId); return Buffer.from('bytes'); },
    insertVaultAttachment: async (args) => recorded.push(args)
  });
  await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', jiraId: '900', filename: 'spec.pdf' }] } }, overrides);
  assert.deepEqual(downloads, ['900']);
  assert.equal(recorded[0].jiraAttachmentId, 'a1');
  assert.equal(recorded[0].mediaId, 'm-a1', 'recorded under the media id the approved rich text points at');
});

test('a file carried forward keeps the object key of its earlier copy', async () => {
  const rows = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [],
    vaultedCopies: async () => new Map([['a1', { content_hash: 'h', storage: 'OBJECT_STORE', object_key: 'vault/sha256/h', media_id: 'm' }]]),
    insertVaultAttachment: async row => rows.push(row)
  });
  await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', filename: 'x.png' }] } }, overrides);
  assert.deepEqual({ storage: rows[0].storage, objectKey: rows[0].objectKey },
    { storage: 'OBJECT_STORE', objectKey: 'vault/sha256/h' });
});

test('a file larger than the vault takes is refused from its reported size, before it is downloaded', async () => {
  let downloaded = false;
  const events = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: 'a1', filename: 'huge.iso', size: 2 * 1024 * 1024 * 1024 }],
    downloadAttachment: async () => { downloaded = true; return Buffer.from('x'); },
    tryAppend: async event => events.push(event)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(downloaded, false);
  assert.equal(result.failed, 1);
  assert.equal(events[0].eventType, 'ATTACHMENT_VAULT_FAILED');
  assert.match(events[0].payload.error, /TOO_LARGE/);
});
