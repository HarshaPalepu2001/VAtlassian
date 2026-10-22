import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const evidence = await import('../src/testmgmt/evidence.js').catch(() => ({}));
const attachment = { id: '50', filename: 'proof.txt', mimeType: 'text/plain', size: 5 };
async function service(options = {}) {
  assert.equal(typeof evidence.createEvidenceService, 'function', 'retained evidence service must exist');
  const objects = new Map(); let jira = Buffer.from('proof');
  const store = { putContent: async ({ buffer, hash }) => { const objectKey = `vault/sha256/${hash}`; objects.set(objectKey, Buffer.from(buffer)); return { objectKey }; },
    getContent: async key => { if (!objects.has(key)) throw Object.assign(new Error('gone'), { status: 404 }); return objects.get(key); } };
  const api = evidence.createEvidenceService({ objectStore: store, readAttachmentBytes: async () => jira, ...options });
  return { api, store, objects, removeJira: () => { jira = null; } };
}
test('evidence is retained and immediately read back before accepting its protected reference', async () => {
  const { api, removeJira } = await service();
  const entry = await api.retainEvidence({ attachment, issueId: '12', viewer: 'tester' });
  assert.equal(entry.sha256, createHash('sha256').update('proof').digest('hex'));
  assert.equal(entry.retained.kind, 'FORGE_OBJECT_STORE');
  removeJira(); assert.equal((await api.readRetainedEvidence(entry)).bytes.toString(), 'proof');
  const verified = await api.verifyEvidence([entry]);
  assert.equal(verified.verified, 1); assert.equal(verified.ok, true);
});
test('a corrupted retained upload is rejected by its immediate readback', async () => {
  const { api } = await service({ objectStore: { putContent: async () => ({ objectKey: 'vault/sha256/' + 'a'.repeat(64) }), getContent: async () => Buffer.from('wrong') } });
  await assert.rejects(api.retainEvidence({ attachment, issueId: '12', viewer: 'tester' }), e => e.reason === 'EVIDENCE_CORRUPT');
});
test('deleted or corrupt retained proof blocks verification; old attachment hashes need explicit remediation', async () => {
  const { api, objects } = await service();
  const entry = await api.retainEvidence({ attachment, issueId: '12', viewer: 'tester' });
  objects.set(entry.retained.objectKey, Buffer.from('other'));
  await assert.rejects(api.verifyEvidence([entry]), e => e.reason === 'EVIDENCE_CORRUPT');
  objects.clear(); await assert.rejects(api.verifyEvidence([entry]), e => e.reason === 'EVIDENCE_MISSING');
  await assert.rejects(api.verifyEvidence([{ attachmentId: '50', sha256: entry.sha256, size: 5 }]), e => e.reason === 'EVIDENCE_RETENTION_REQUIRED');
});
