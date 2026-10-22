import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceService } from '../src/testmgmt/evidence.js';

test('retained range retrieval reads only requested bytes while full verifier remains independent', async () => {
  const bytes = Buffer.alloc(20 * 1024 * 1024, 90); let fullReads = 0; let rangeBytes = 0;
  const api = createEvidenceService({ objectStore: {
    putContent: async ({ hash }) => ({ objectKey: `vault/sha256/${hash}` }),
    getContent: async () => { fullReads++; return bytes; },
    getContentRange: async (_key, { offset, length, totalBytes }) => { assert.equal(totalBytes, bytes.length);
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + length)); rangeBytes += part.length; return part; }
  }, readAttachmentBytes: async () => bytes });
  const entry = await api.retainEvidence({ attachment: { id: '50', filename: 'proof.bin' }, issueId: '12', viewer: 'tester' });
  assert.equal(typeof api.readRetainedEvidenceRange, 'function', 'range service must exist');
  fullReads = 0;
  for (let offset = 0; offset < bytes.length; offset += 192 * 1024) {
    const result = await api.readRetainedEvidenceRange(entry, { offset, length: 192 * 1024 });
    assert.ok(result.bytes.length <= 192 * 1024);
  }
  assert.equal(fullReads, 0); assert.equal(rangeBytes, bytes.length, 'one complete download transfers one file, not one whole file per chunk');
  assert.equal((await api.verifyEvidence([entry])).ok, true); assert.equal(fullReads, 1);
});
test('range retrieval validates protected identity before calling object storage', async () => {
  let reads = 0;
  const api = createEvidenceService({ objectStore: { getContentRange: async () => { reads++; return Buffer.alloc(0); } } });
  assert.equal(typeof api.readRetainedEvidenceRange, 'function');
  await assert.rejects(api.readRetainedEvidenceRange({ attachmentId: '1', size: 1, sha256: 'a'.repeat(64) }, { offset: 0, length: 1 }), e => e.reason === 'EVIDENCE_RETENTION_REQUIRED');
  assert.equal(reads, 0);
});
