import { createHash } from 'node:crypto';
import { FailClosed } from '../lib/errors.js';
import { defaultVaultObjectStore } from '../lib/vaultObjectStore.js';
import { objectKeyFor } from '../lib/vaultLocation.js';

export const MAX_RETAINED_EVIDENCE_BYTES = 20 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw new FailClosed(reason); };

/** Called after the caller has authorized the issue/run; never accept a client object key. */
export function createEvidenceService({ objectStore, readAttachmentBytes }) {
  function retainedReference(entry) {
    const retained = entry?.retained;
    if (retained?.kind !== 'FORGE_OBJECT_STORE' || !retained.objectKey) fail('EVIDENCE_RETENTION_REQUIRED');
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.size) || entry.size < 0
      || entry.size > MAX_RETAINED_EVIDENCE_BYTES || retained.sha256 !== entry.sha256 || retained.size !== entry.size
      || retained.objectKey !== objectKeyFor(entry.sha256)) fail('EVIDENCE_CORRUPT');
    return retained;
  }
  async function readRetainedEvidence(entry) {
    const retained = retainedReference(entry);
    let bytes;
    try { bytes = Buffer.from(await objectStore.getContent(retained.objectKey)); }
    catch (error) { fail(error?.status === 404 ? 'EVIDENCE_MISSING' : 'EVIDENCE_UNREADABLE'); }
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) fail('EVIDENCE_CORRUPT');
    return { bytes, filename: entry.filename, mimeType: entry.mimeType ?? 'application/octet-stream' };
  }
  /** Transport checks only; complete-file SHA-256 is verified before the browser downloads it. */
  async function readRetainedEvidenceRange(entry, { offset, length }) {
    const retained = retainedReference(entry);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset > entry.size) fail('EVIDENCE_CORRUPT');
    let bytes;
    try { bytes = Buffer.from(await objectStore.getContentRange(retained.objectKey, { offset, length, totalBytes: entry.size })); }
    catch (error) { fail(error?.status === 404 ? 'EVIDENCE_MISSING' : error?.status === 416 ? 'EVIDENCE_CORRUPT' : 'EVIDENCE_UNREADABLE'); }
    if (bytes.length !== Math.min(length, entry.size - offset)) fail('EVIDENCE_CORRUPT');
    return { bytes, filename: entry.filename, mimeType: entry.mimeType ?? 'application/octet-stream' };
  }
  async function retainEvidence({ attachment, issueId, viewer }) {
    if (!attachment?.id || !issueId || !viewer) fail('EVIDENCE_UNREADABLE');
    if (Number(attachment.size) > MAX_RETAINED_EVIDENCE_BYTES) fail('EVIDENCE_TOO_LARGE');
    let bytes;
    try { bytes = Buffer.from(await readAttachmentBytes(String(attachment.id), { issueId: String(issueId), viewer })); }
    catch (error) { if (error?.reason) throw error; fail('EVIDENCE_UNREADABLE'); }
    if (bytes.length > MAX_RETAINED_EVIDENCE_BYTES) fail('EVIDENCE_TOO_LARGE');
    const sha256 = hash(bytes);
    const copy = await objectStore.putContent({ buffer: bytes, hash: sha256 });
    const entry = { attachmentId: String(attachment.id),
      filename: String(attachment.filename ?? 'Evidence').replace(/[\r\n\u0000]/g, '').slice(0, 255),
      mimeType: String(attachment.mimeType ?? 'application/octet-stream'), size: bytes.length, sha256,
      retained: { kind: 'FORGE_OBJECT_STORE', objectKey: copy?.objectKey, sha256, size: bytes.length } };
    // A successful upload or reused key is insufficient: read back and hash the retained bytes.
    await readRetainedEvidence(entry);
    return entry;
  }
  async function verifyEvidence(entries) {
    if (!Array.isArray(entries)) fail('EVIDENCE_UNREADABLE');
    for (const entry of entries) await readRetainedEvidence(entry);
    return { ok: true, verified: entries.length };
  }
  return { retainEvidence, verifyEvidence, readRetainedEvidence, readRetainedEvidenceRange };
}

async function production() {
  const [objectStore, jira] = await Promise.all([defaultVaultObjectStore(), import('./jira.js')]);
  return createEvidenceService({ objectStore, readAttachmentBytes: jira.readAttachmentBytes });
}
export const retainEvidence = async args => (await production()).retainEvidence(args);
export const verifyEvidence = async entries => (await production()).verifyEvidence(entries);
export const readRetainedEvidence = async entry => (await production()).readRetainedEvidence(entry);
export const readRetainedEvidenceRange = async (entry, range) => (await production()).readRetainedEvidenceRange(entry, range);
