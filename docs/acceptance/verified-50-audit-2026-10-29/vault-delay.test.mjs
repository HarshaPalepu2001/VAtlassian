import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runVaultWorker } from '../../../src/jobs/vaultWorker.js';

function baseBody() {
  return { baselineId: 'b1', issueId: 42, issueKey: 'ENG-1', projectId: 7,
    attachments: [{ id: 'a1', filename: 'x.png' }, { id: 'a2', filename: 'two.png' }] };
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
    hasContent: async () => true,
    tryAppend: async () => {},
    now: () => 1000,
    ...overrides
  };
}

test('audit: real vault worker returns 5,10,20,40,60 seconds for retry counts 0..4', async () => {
  const delays = [];
  for (let retryCount = 0; retryCount < 5; retryCount++) {
    const result = await runVaultWorker({ body: baseBody(), retryContext: { retryCount } },
      baseOverrides({ readIssueAttachments: async () => { throw new Error('audit temporary failure'); } }));
    delays.push(result.retryOptions?.retryAfter ?? result.retryAfter);
  }
  assert.deepEqual(delays, [5, 10, 20, 40, 60]);
  console.log('Verified vault delay sequence', delays);
});
