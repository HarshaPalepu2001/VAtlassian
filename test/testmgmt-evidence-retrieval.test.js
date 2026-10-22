import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceService } from '../src/testmgmt/evidence.js';
import { retestWorld } from './helpers/tm-retest-world.js';
const module = await import('../src/usecases/testEvidence.js').catch(() => ({}));
const actor = { accountId: 'tester' };
async function world(bytes = Buffer.from('retained proof')) {
  const w = retestWorld(), objects = new Map(); let fullReads = 0, rangeBytes = 0;
  const evidence = createEvidenceService({ objectStore: {
    putContent: async ({ buffer, hash }) => { const objectKey = `vault/sha256/${hash}`; objects.set(objectKey, buffer); return { objectKey }; },
    getContent: async key => { fullReads++; if (!objects.has(key)) throw Object.assign(new Error('gone'), { status: 404 }); return objects.get(key); },
    getContentRange: async (key, { offset, length, totalBytes }) => {
      if (!objects.has(key)) throw Object.assign(new Error('gone'), { status: 404 });
      const bytes = objects.get(key); if (bytes.length !== totalBytes) throw Object.assign(new Error('size changed'), { status: 416 });
      const part = bytes.subarray(offset, Math.min(totalBytes, offset + length)); rangeBytes += part.length; return part;
    }
  }, readAttachmentBytes: async () => bytes });
  const entry = await evidence.retainEvidence({ attachment: { id: '50', filename: 'proof.txt', mimeType: 'text/plain' }, issueId: '12', viewer: actor });
  fullReads = 0;
  const run = w.runs.get('1'.padStart(32, '0')); run.steps[0].evidence = [entry];
  let vaultReads = 0;
  w.deps.readRetainedEvidence = async saved => { vaultReads++; return evidence.readRetainedEvidence(saved); };
  w.deps.readRetainedEvidenceRange = async (saved, range) => { vaultReads++; return evidence.readRetainedEvidenceRange(saved, range); };
  assert.equal(typeof module.createTestEvidence, 'function', 'authorized evidence retrieval must exist');
  return { w, entry, objects, bytes, vaultReads: () => vaultReads, fullReads: () => fullReads, rangeBytes: () => rangeBytes, uc: module.createTestEvidence(w.deps),
    payload: { issueKey: 'VAT-12', runId: run.runId, stepId: run.steps[0].id, attachmentId: '50' } };
}
test('retrieval authorizes the execution and test then reads only the saved evidence reference', async () => {
  const { uc, payload, bytes, entry } = await world();
  const result = await uc.retrieve({ ...payload, objectKey: 'arbitrary-secret-object', retained: { objectKey: 'other' } }, actor);
  assert.equal(Buffer.from(result.dataBase64, 'base64').toString(), bytes.toString());
  assert.equal(result.sha256, entry.sha256); assert.equal(result.complete, true); assert.equal(result.objectKey, undefined);
});
test('hidden and cross-project test, wrong execution, type or attachment never reach the vault', async () => {
  for (const mutate of [x => x.w.hidden.add('12'), x => x.w.hidden.add('21'), x => { x.w.issues.get('21').fields.project.id = '200'; },
    x => { x.w.issues.get('21').fields.issuetype.id = '7'; }, x => { x.payload.attachmentId = 'not-saved'; },
    x => { x.w.runs.get(x.payload.runId).executionIssueId = '99'; }]) {
    const x = await world(); mutate(x);
    await assert.rejects(x.uc.retrieve(x.payload, actor)); assert.equal(x.vaultReads(), 0);
  }
});
test('large evidence is retrieved in bounded independently authorized chunks', async () => {
  const x = await world(Buffer.alloc(500_000, 90)); let offset = 0; const chunks = [];
  do { const result = await x.uc.retrieve({ ...x.payload, offset }, actor); assert.ok(result.dataBase64.length < 300_000);
    chunks.push(Buffer.from(result.dataBase64, 'base64')); assert.equal(result.offset, offset); offset = result.nextOffset;
    if (result.complete) break;
  } while (offset < x.bytes.length);
  assert.deepEqual(Buffer.concat(chunks), x.bytes); assert.equal(offset, x.bytes.length);
  assert.equal(x.fullReads(), 0); assert.equal(x.rangeBytes(), x.bytes.length);
});
test('deleted/corrupt retained proof and legacy hashes report explicit retrieval refusal', async () => {
  const x = await world(); x.objects.clear(); await assert.rejects(x.uc.retrieve(x.payload, actor), e => e.reason === 'EVIDENCE_MISSING');
  const y = await world(); y.objects.set(y.entry.retained.objectKey, Buffer.from('corrupt')); await assert.rejects(y.uc.retrieve(y.payload, actor), e => e.reason === 'EVIDENCE_CORRUPT');
  const z = await world(); delete z.w.runs.get(z.payload.runId).steps[0].evidence[0].retained;
  await assert.rejects(z.uc.retrieve(z.payload, actor), e => e.reason === 'EVIDENCE_RETENTION_REQUIRED');
});
test('permission revoked between chunks stops further retained-object reads', async () => {
  const x = await world(Buffer.alloc(300_000, 90));
  const first = await x.uc.retrieve(x.payload, actor); const reads = x.vaultReads();
  x.w.hidden.add('21');
  await assert.rejects(x.uc.retrieve({ ...x.payload, offset: first.nextOffset }, actor));
  assert.equal(x.vaultReads(), reads);
});
