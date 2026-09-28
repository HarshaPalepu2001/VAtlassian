import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { restoreAttachments, planAttachmentChanges, AttachmentRestoreError } from '../src/lib/restore/attachments.js';
import { attachmentRejection, removedNodeFiles } from '../src/lib/restore/attachmentPreflight.js';

const hash = text => createHash('sha256').update(Buffer.from(text)).digest('hex');
const file = (id, filename) => ({ id, filename, size: 4, mimeType: 'text/plain', author: { accountId: 'u1' } });

/**
 * A simulated Jira issue, vault and ledger. `jira` holds the files on the
 * issue by real id with their bytes; `vault` the vaulted copies by original id.
 */
function world({ onIssue = [], vault = {}, aliases = {} } = {}) {
  const w = { jira: new Map(onIssue.map(([f, bytes]) => [f.id, { ...f, bytes }])), vault, aliases: new Map(Object.entries(aliases)),
    audit: [], calls: [], nextId: 900, faults: new Set() };
  w.deps = {
    aliases: async () => new Map(w.aliases),
    readCurrent: async () => [...w.jira.values()].map(({ bytes, ...rest }) => rest),
    vaultedCopies: async ({ attachmentIds }) => new Map(attachmentIds.filter(id => w.vault[id]).map(id => [id, {
      jira_attachment_id: id, filename: w.vault[id].filename, content_hash: w.vault[id].hash ?? hash(w.vault[id].bytes),
      confluence_attachment_id: `c${id}`, confluence_page_id: 'p1', baseline_id: 'b1' }])),
    downloadVaulted: async copy => Buffer.from(w.vault[copy.jira_attachment_id].bytes),
    upload: async ({ filename, buffer }) => {
      if (w.faults.has('upload')) throw Object.assign(new Error('refused'), { status: 400 });
      if (w.faults.has('upload5xx')) throw Object.assign(new Error('down'), { status: 503 });
      const id = String(w.nextId++);
      w.jira.set(id, { id, filename, size: buffer.length, bytes: w.faults.has('mangle') ? 'garbage' : buffer.toString() });
      w.calls.push(['upload', id, filename]);
      return { id, filename };
    },
    download: async id => {
      if (!w.jira.has(id)) throw Object.assign(new Error('gone'), { status: 404 });
      return Buffer.from(w.jira.get(id).bytes);
    },
    remove: async id => {
      if (w.faults.has('delete403')) throw Object.assign(new Error('forbidden'), { status: 403 });
      w.calls.push(['remove', id]);
      w.jira.delete(id);
    },
    recordAlias: async alias => { w.calls.push(['alias', alias.attachmentId, alias.standsForId]); w.aliases.set(alias.attachmentId, alias.standsForId); },
    audit: async (eventType, payload) => {
      if (w.faults.has('audit')) throw Object.assign(new Error('ledger down'), { status: 503 });
      w.calls.push(['audit', eventType]); w.audit.push({ eventType, payload });
    },
    preserve: async () => ({ confluenceAttachmentId: 'kept-1' })
  };
  return w;
}
const approved = [file('1', 'spec.pdf'), file('2', 'data.csv')];
const run = (w, target = approved) => restoreAttachments({ issueKey: 'T-1', issueId: 10, target, deps: w.deps });

test('a removed file is uploaded again from the vault and recorded as standing for the original', async () => {
  const w = world({ onIssue: [[file('2', 'data.csv'), 'csv']], vault: { 1: { filename: 'spec.pdf', bytes: 'pdf' } } });
  const result = await run(w);
  assert.deepEqual(result.restored, [{ id: '1', attachmentId: '900', filename: 'spec.pdf' }]);
  assert.deepEqual(w.calls, [['upload', '900', 'spec.pdf'], ['alias', '900', '1'], ['audit', 'ATTACHMENT_RESTORED']]);
  assert.equal(w.audit[0].payload.contentHash, hash('pdf'));
});

test('an added file is written to the ledger with its hash, then deleted', async () => {
  const w = world({ onIssue: [[file('1', 'spec.pdf'), 'pdf'], [file('2', 'data.csv'), 'csv'], [file('3', 'evil.exe'), 'mz']] });
  const result = await run(w);
  assert.deepEqual(result.removed, [{ id: '3', filename: 'evil.exe' }]);
  assert.deepEqual(w.calls, [['audit', 'ATTACHMENT_REMOVED_BY_RESTORE'], ['remove', '3']], 'evidence before destruction');
  assert.equal(w.audit[0].payload.contentHash, hash('mz'));
  assert.equal(w.audit[0].payload.vaultCopy, 'kept-1');
});

test('nothing is deleted when the ledger entry cannot be written', async () => {
  const w = world({ onIssue: [[file('1', 'spec.pdf'), 'pdf'], [file('2', 'data.csv'), 'csv'], [file('3', 'x'), 'x']] });
  w.faults.add('audit');
  await assert.rejects(() => run(w), error => error.status === 503);
  assert.equal(w.jira.has('3'), true);
});

test('a file already restored is found by its alias and not uploaded again', async () => {
  const w = world({ onIssue: [[file('900', 'spec.pdf'), 'pdf'], [file('2', 'data.csv'), 'csv']], aliases: { 900: '1' } });
  const result = await run(w);
  assert.deepEqual(result, { restored: [], removed: [] });
  assert.deepEqual(w.calls, []);
});

test('a file with no vaulted copy is named, and everything else still goes ahead', async () => {
  const w = world({ onIssue: [[file('3', 'added.txt'), 'a']], vault: { 2: { filename: 'data.csv', bytes: 'csv' } } });
  await assert.rejects(() => run(w), error => {
    assert.ok(error instanceof AttachmentRestoreError);
    assert.equal(error.status, 422, 'a refusal, not a system failure');
    assert.deepEqual(error.refused.map(r => r.filename), ['spec.pdf']);
    assert.match(error.detail, /No copy of this file is in the vault/);
    return true;
  });
  assert.ok(w.calls.some(c => c[0] === 'upload' && c[2] === 'data.csv'));
  assert.ok(w.calls.some(c => c[0] === 'remove' && c[1] === '3'));
});

test('a vaulted copy changed in Confluence is refused before anything reaches Jira', async () => {
  const w = world({ vault: { 1: { filename: 'spec.pdf', bytes: 'tampered', hash: hash('pdf') }, 2: { filename: 'data.csv', bytes: 'csv' } } });
  await assert.rejects(() => run(w), /no longer matches the hash/);
  assert.equal(w.calls.filter(c => c[0] === 'upload').map(c => c[2]).join(), 'data.csv');
});

test('an upload whose bytes do not read back as the vaulted ones is removed and never aliased', async () => {
  const w = world({ onIssue: [[file('2', 'data.csv'), 'csv']], vault: { 1: { filename: 'spec.pdf', bytes: 'pdf' } } });
  w.faults.add('mangle');
  await assert.rejects(() => run(w), /stored different bytes/);
  assert.deepEqual(w.calls.map(c => c[0]), ['upload', 'remove']);
  assert.equal(w.aliases.size, 0);
});

test('a project that will not let the app delete leaves the file and says why', async () => {
  const w = world({ onIssue: [[file('1', 'spec.pdf'), 'pdf'], [file('2', 'data.csv'), 'csv'], [file('3', 'x.txt'), 'x']] });
  w.faults.add('delete403');
  await assert.rejects(() => run(w), /not allowed to delete attachments/);
  assert.equal(w.jira.has('3'), true);
});

test('a system failure is thrown at once so a queued restore retries', async () => {
  const w = world({ vault: { 1: { filename: 'spec.pdf', bytes: 'pdf' }, 2: { filename: 'data.csv', bytes: 'csv' } } });
  w.faults.add('upload5xx');
  await assert.rejects(() => run(w), error => error.status === 503);
});

test('a refused upload is named, not retried for ever', async () => {
  const w = world({ onIssue: [[file('2', 'data.csv'), 'csv']], vault: { 1: { filename: 'spec.pdf', bytes: 'pdf' } } });
  w.faults.add('upload');
  await assert.rejects(() => run(w), error => error.status === 422 && /Jira refused the upload/.test(error.detail));
});

test('an added file already gone counts as removed', async () => {
  const w = world({ onIssue: [[file('1', 'spec.pdf'), 'pdf'], [file('2', 'data.csv'), 'csv']] });
  w.deps.readCurrent = async () => [file('1', 'spec.pdf'), file('2', 'data.csv'), file('3', 'ghost.txt')];
  const result = await run(w);
  assert.deepEqual(result.removed, [{ id: '3', filename: 'ghost.txt' }]);
});

test('a missing approved list refuses rather than deleting every file', async () => {
  const w = world({ onIssue: [[file('1', 'spec.pdf'), 'pdf']] });
  await assert.rejects(() => run(w, null), /was not stored/);
  assert.deepEqual(w.calls, []);
});

test('the change plan compares canonical ids', () => {
  const plan = planAttachmentChanges({ target: [{ id: '1' }, { id: '2' }], current: [{ id: '1', jiraId: '900' }, { id: '3' }] });
  assert.deepEqual(plan.missing.map(a => a.id), ['2']);
  assert.deepEqual(plan.extra.map(a => a.id), ['3']);
});

test('the reject dialog is told which files go, which come back, and which cannot', async () => {
  const rejection = await attachmentRejection({
    reviewFields: [
      { kind: 'attachments', added: [{ id: '3', filename: 'added.txt' }], removed: [{ id: '1', filename: 'spec.pdf' }, { id: '4', filename: 'lost.doc' }] },
      { kind: 'attachments', group: { issueId: 11, issueKey: 'T-2' }, removed: [{ id: '7', filename: 'child.pdf' }] },
      { kind: 'text', added: [{ id: 'x' }] }
    ],
    issue: { issueId: 10, issueKey: 'T-1' },
    removedNodes: [{ issueId: 12, issueKey: 'T-3', files: [{ id: '8', filename: 'gone-with-item.png' }] }],
    lookup: async ({ issueId, attachmentIds }) => new Map(attachmentIds.filter(id => id !== '4').map(id => [id, { issueId }]))
  });
  assert.deepEqual(rejection.deleteFiles, [{ issueId: 10, issueKey: 'T-1', id: '3', filename: 'added.txt' }]);
  assert.deepEqual(rejection.restoreFiles.map(f => `${f.issueKey}:${f.filename}`), ['T-1:spec.pdf', 'T-2:child.pdf', 'T-3:gone-with-item.png']);
  assert.deepEqual(rejection.unrestorableFiles.map(f => f.filename), ['lost.doc']);
  assert.equal(rejection.vaultChecked, true);
});

test('when the vault cannot be checked the dialog says so instead of guessing', async () => {
  const rejection = await attachmentRejection({
    reviewFields: [{ kind: 'attachments', removed: [{ id: '1', filename: 'spec.pdf' }] }],
    issue: { issueId: 10, issueKey: 'T-1' }, lookup: async () => { throw new Error('down'); }
  });
  assert.equal(rejection.vaultChecked, false);
  assert.deepEqual(rejection.unrestorableFiles, []);
  assert.equal(rejection.restoreFiles.length, 1);
});

test('removedNodeFiles lists the files of work items a tree rejection recreates', () => {
  const files = removedNodeFiles({
    treeDiff: { changes: [{ kind: 'NODE_REMOVED', logicalNodeId: 'n2' }, { kind: 'NODE_ADDED', logicalNodeId: 'n3' }] },
    baselineTree: { nodes: [{ logicalNodeId: 'n2', originalIssueId: 12, issueKey: 'T-3' }, { logicalNodeId: 'n4', issueKey: 'T-4' }],
      values: { n2: { attachment: [{ id: '8', filename: 'a.png' }] }, n4: { attachment: [{ id: '9' }] } } }
  });
  assert.deepEqual(files, [{ issueId: 12, issueKey: 'T-3', files: [{ id: '8', filename: 'a.png' }] }]);
});
