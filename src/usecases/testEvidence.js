import { actorFrom, respond } from './access.js';
import { resolveSubject } from './testAuthoring.js';

export const EVIDENCE_DOWNLOAD_CHUNK_BYTES = 192 * 1024;
const messages = {
  EVIDENCE_RETENTION_REQUIRED: 'This older evidence record has no retained copy. For an open run, remove and re-add it. A frozen record requires a new run; its signed evidence cannot be rewritten.',
  EVIDENCE_MISSING: 'The retained evidence is missing. This record cannot be treated as complete.',
  EVIDENCE_CORRUPT: 'The retained evidence failed its integrity check. No download was returned.',
  EVIDENCE_UNREADABLE: 'The retained evidence could not be read. Try again when the storage service is available.'
};
const fail = (reason, message) => { throw Object.assign(new Error(message), { reason, userMessage: message }); };
const notFound = () => fail('NOT_FOUND', 'That evidence was not found, or you cannot see its execution and test.');

/** The client supplies identities only. Vault references come exclusively from persisted run evidence. */
export function createTestEvidence(deps) {
  async function retrieve({ issueKey, runId, stepId, attachmentId, offset = 0 }, actor) {
    if (!actor?.accountId) fail('AUTHENTICATION_REQUIRED', 'Sign in before retrieving evidence.');
    if (!issueKey || !/^[0-9a-f]{32}$/.test(String(runId ?? '')) || !stepId || !attachmentId
      || !Number.isSafeInteger(offset) || offset < 0) notFound();
    const { issue, project } = await resolveSubject(issueKey, deps, 'EXECUTION');
    if (String(issue.fields?.project?.id) !== String(project.projectId)) notFound();
    const run = await deps.readRun(runId);
    if (!run || String(run.executionIssueId) !== String(issue.id) || String(run.projectId) !== String(project.projectId)) notFound();
    const test = await resolveSubject(run.testIssueId, deps, 'TEST');
    if (String(test.projectId) !== String(project.projectId)) notFound();
    const step = run.steps?.find(step => step.id === String(stepId));
    const matches = step?.evidence?.filter(entry => entry.attachmentId === String(attachmentId)) ?? [];
    if (matches.length !== 1) notFound();
    const saved = matches[0];
    if (!Number.isSafeInteger(saved.size) || offset > saved.size) notFound();
    const end = Math.min(saved.size, offset + EVIDENCE_DOWNLOAD_CHUNK_BYTES);
    let part;
    try { part = await deps.readRetainedEvidenceRange(saved, { offset, length: EVIDENCE_DOWNLOAD_CHUNK_BYTES }); }
    catch (error) {
      if (error?.name === 'NEEDS_AUTHENTICATION_ERR') throw error;
      const reason = messages[error?.reason] ? error.reason : 'EVIDENCE_UNREADABLE'; fail(reason, messages[reason]);
    }
    const bytes = Buffer.from(part.bytes);
    if (bytes.length !== end - offset) fail('EVIDENCE_CORRUPT', messages.EVIDENCE_CORRUPT);
    return { filename: String(saved.filename ?? 'Evidence').replace(/[\x00-\x1f\\/]/g, '_').slice(0, 255),
      mimeType: String(saved.mimeType ?? 'application/octet-stream'), sha256: saved.sha256, totalBytes: saved.size,
      offset, nextOffset: end, complete: end === saved.size, dataBase64: bytes.toString('base64') };
  }
  return { retrieve };
}

export async function getRunEvidence({ payload = {}, context }, suppliedDeps = null) {
  return respond(async () => {
    const actor = actorFrom(context);
    const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
    return createTestEvidence(deps).retrieve(payload, actor);
  });
}
