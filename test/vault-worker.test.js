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
    identityRecords: async () => new Map(),
    mediaIdOf: async () => null,
    vaultedCopies: async () => new Map(),
    resolveTier: async () => ({ tier: 'CONFLUENCE' }),
    putContent: async () => { throw new Error('a Confluence site must not reach the Object Store here'); },
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
  const overrides = baseOverrides({ getVaultPage: async () => null,
    ensureVaultSpace: async (projectId) => { calls.push(projectId); return { spaceId: 's1', projectPageId: 'pp1' }; } });
  await runVaultWorker({ body: baseBody() }, overrides);
  assert.deepEqual(calls, [7]);
});

test('an issue whose vault page exists costs no provisioning call', async () => {
  let provisioned = false;
  await runVaultWorker({ body: baseBody() }, baseOverrides({ ensureVaultSpace: async () => { provisioned = true; return {}; } }));
  assert.equal(provisioned, false);
});

test('an issue with no attachments still gets its page and completes', async () => {
  const result = await runVaultWorker({ body: baseBody() }, baseOverrides({ readIssueAttachments: async () => [] }));
  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.vaulted, 0);
});

test('a baseline that recorded its files vaults exactly those, not whatever is on the issue now', async () => {
  const uploaded = [];
  const recorded = [];
  const overrides = baseOverrides({
    // Added after approval, before this job ran: not part of what was signed.
    readIssueAttachments: async () => [{ id: 'a1', filename: 'spec.pdf' }, { id: 'a9', filename: 'late.txt' }],
    uploadAttachmentToPage: async ({ filename }) => { uploaded.push(filename); return { id: 'c-' + filename }; },
    insertVaultAttachment: async (args) => recorded.push(args)
  });
  const result = await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', jiraId: 'a1', filename: 'spec.pdf' }] } }, overrides);
  assert.deepEqual(result, { state: 'COMPLETE', storage: 'CONFLUENCE', vaulted: 1, skipped: 0, failed: 0 });
  assert.deepEqual(uploaded, ['a1-spec.pdf']);
  assert.deepEqual(recorded.map(r => r.jiraAttachmentId), ['a1']);
});

test('a recorded file gone from the issue is carried forward from its earlier vaulted copy', async () => {
  const recorded = [];
  const audits = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [],
    vaultedCopies: async ({ attachmentIds }) => new Map([[attachmentIds[0], { content_hash: 'h1', confluence_attachment_id: 'c-old' }]]),
    insertVaultAttachment: async (args) => recorded.push(args),
    tryAppend: async (event) => audits.push(event)
  });
  const result = await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', jiraId: 'a1', filename: 'spec.pdf' }] } }, overrides);
  assert.equal(result.vaulted, 1);
  assert.equal(recorded[0].contentHash, 'h1');
  assert.equal(recorded[0].confluenceAttachmentId, 'c-old');
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

// ── Where the copy goes: Confluence, or the Forge Object Store ─────────────

test('a site without Confluence vaults to the Object Store and never asks Confluence for a page', async () => {
  const rows = [];
  const puts = [];
  const events = [];
  const overrides = baseOverrides({
    resolveTier: async () => ({ tier: 'OBJECT_STORE' }),
    ensureVaultSpace: async () => { throw new Error('must not provision Confluence'); },
    getVaultPage: async () => { throw new Error('must not read a Confluence page'); },
    uploadAttachmentToPage: async () => { throw new Error('must not upload to Confluence'); },
    putContent: async args => { puts.push(args); return { storage: 'OBJECT_STORE', objectKey: `vault/sha256/${args.hash}` }; },
    insertVaultAttachment: async row => rows.push(row),
    tryAppend: async event => events.push(event)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  const hash = createHash('sha256').update(Buffer.from('bytes')).digest('hex');
  assert.deepEqual({ state: result.state, storage: result.storage, vaulted: result.vaulted }, { state: 'COMPLETE', storage: 'OBJECT_STORE', vaulted: 1 });
  assert.equal(puts[0].hash, hash);
  assert.equal(rows[0].storage, 'OBJECT_STORE');
  assert.equal(rows[0].objectKey, `vault/sha256/${hash}`);
  assert.equal(rows[0].confluenceAttachmentId, null);
  assert.equal(events[0].payload.fallbackFrom, undefined, 'the chosen home, not a fallback');
});

test('a file Confluence refuses goes to the Object Store instead, and the ledger says why', async () => {
  const rows = [];
  const events = [];
  const overrides = baseOverrides({
    uploadAttachmentToPage: async () => { throw new Error('413 too large for Confluence'); },
    putContent: async ({ hash }) => ({ storage: 'OBJECT_STORE', objectKey: `vault/sha256/${hash}` }),
    insertVaultAttachment: async row => rows.push(row),
    tryAppend: async event => events.push(event)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.vaulted, 1);
  assert.equal(rows[0].storage, 'OBJECT_STORE');
  assert.equal(events[0].payload.fallbackFrom.storage, 'CONFLUENCE');
  assert.match(events[0].payload.fallbackFrom.error, /413/);
});

test('a Confluence site whose vault space cannot be made still vaults every file', async () => {
  const rows = [];
  const overrides = baseOverrides({
    getVaultPage: async () => null,
    ensureVaultSpace: async () => { throw new Error('space permissions unavailable'); },
    putContent: async ({ hash }) => ({ storage: 'OBJECT_STORE', objectKey: `vault/sha256/${hash}` }),
    insertVaultAttachment: async row => rows.push(row)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.state, 'COMPLETE');
  assert.equal(rows[0].storage, 'OBJECT_STORE');
});

test('a file carried forward keeps the home of its earlier copy', async () => {
  const rows = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [],
    vaultedCopies: async () => new Map([['a1', { content_hash: 'h', storage: 'OBJECT_STORE', object_key: 'vault/sha256/h', media_id: 'm' }]]),
    insertVaultAttachment: async row => rows.push(row)
  });
  await runVaultWorker({ body: { ...baseBody(), attachments: [{ id: 'a1', filename: 'x.png' }] } }, overrides);
  assert.deepEqual({ storage: rows[0].storage, objectKey: rows[0].objectKey, confluenceAttachmentId: rows[0].confluenceAttachmentId },
    { storage: 'OBJECT_STORE', objectKey: 'vault/sha256/h', confluenceAttachmentId: null });
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
