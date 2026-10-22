import crypto from 'crypto';
import { canonical, sha256Hex } from '../lib/hash.js';
import { isStepStatus } from './results.js';
import { normaliseDataset } from './planning.js';

/**
 * WHAT A TEST VERSION AND A RUN ARE, AS BYTES THAT GET SIGNED.
 *
 * A signature binds a content hash. These functions are the only definition of
 * the content behind it, so the hash recomputed at signing time and the one
 * shown to an auditor later are computed by the same code from the same rows.
 */

export const MAX_STEPS = 200;
export const MAX_TEXT = 4000;
export const MAX_VERIFIES = 50;

const text = (value) => String(value ?? '').replace(/\r\n/g, '\n');

/** A draft as the author sends it, or the reason it is refused. */
export function normaliseDraft(input) {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  if (steps.length > MAX_STEPS) return { error: 'TOO_MANY_STEPS' };
  const seen = new Set();
  const clean = [];
  for (const step of steps) {
    const id = String(step?.id ?? '').trim() || crypto.randomBytes(8).toString('hex');
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || seen.has(id)) return { error: 'STEP_ID_INVALID' };
    seen.add(id);
    const out = { id, action: text(step.action), data: text(step.data), expected: text(step.expected) };
    if ([out.action, out.data, out.expected].some(v => v.length > MAX_TEXT)) return { error: 'STEP_TOO_LONG' };
    clean.push(out);
  }
  const objective = text(input?.objective);
  const preconditions = text(input?.preconditions);
  if (objective.length > MAX_TEXT || preconditions.length > MAX_TEXT) return { error: 'TEXT_TOO_LONG' };
  const verifies = Array.isArray(input?.verifies) ? input.verifies : [];
  if (verifies.length > MAX_VERIFIES) return { error: 'TOO_MANY_VERIFIES' };
  const verifiesClean = [];
  const seenSources = new Set();
  for (const source of verifies) {
    const issueId = String(source?.issueId ?? '');
    const issueKey = String(source?.issueKey ?? '').trim();
    if ((!/^\d+$/.test(issueId) && !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) || seenSources.has(issueId || issueKey)) return { error: 'VERIFIES_INVALID' };
    seenSources.add(issueId || issueKey);
    verifiesClean.push({ ...(issueId ? { issueId } : {}), issueKey });
  }
  const dataset = normaliseDataset(input?.dataset);
  if (dataset.error) return { error: dataset.error };
  const draft = { objective, preconditions, steps: clean, verifies: verifiesClean, dataset: dataset.dataset };
  if (Buffer.byteLength(JSON.stringify(draft)) > 256 * 1024) return { error: 'DEFINITION_TOO_LARGE' };
  return { draft };
}

/** Why a draft cannot be published, or null. */
export function publishProblem(draft) {
  if (!draft?.steps?.length) return 'NO_STEPS';
  if (draft.steps.some(s => !s.action.trim() || !s.expected.trim())) return 'STEP_INCOMPLETE';
  return null;
}

/** The frozen content of a test version. The parent is part of it: decision 9. */
export function versionContent({ testIssueId, projectId, versionNo, parentIssueId, draft }) {
  return {
    kind: 'TEST_VERSION', schema: 1,
    testIssueId: String(testIssueId), projectId: String(projectId), versionNo: Number(versionNo),
    parentIssueId: parentIssueId == null ? null : String(parentIssueId),
    objective: draft.objective, preconditions: draft.preconditions,
    steps: draft.steps.map(s => ({ id: s.id, action: s.action, data: s.data, expected: s.expected })),
    verifies: draft.verifies.map(v => ({ ...v })),
    ...(draft.dataset ? { dataset: draft.dataset } : {})
  };
}

export function contentDigest(content) {
  return sha256Hex(canonical(content));
}

/** A run's step results, merged from the version's steps and what was recorded. */
export function runSteps(versionSteps, recorded) {
  const byId = new Map((recorded ?? []).map(r => [r.id, r]));
  return (versionSteps ?? []).map(step => {
    const r = byId.get(step.id) ?? {};
    return {
      id: step.id,
      status: isStepStatus(r.status) ? r.status : 'NOT_RUN',
      actual: text(r.actual), comment: text(r.comment),
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
      recordedBy: r.recordedBy ?? null, recordedAt: r.recordedAt ?? null,
      ...(step.iterationId ? { iterationId: step.iterationId, sourceStepId: step.sourceStepId } : {})
    };
  });
}

/**
 * The run content every sign-off step signs: the pinned test version, the run's
 * context, every step result with its evidence hashes, and the computed result.
 * Step timestamps are left out on purpose: who recorded a step is part of the
 * record, the millisecond is not something a signer can attest to.
 */
export function runContent(run, steps, result) {
  return {
    kind: 'TEST_RUN', schema: 1,
    runId: run.runId, executionIssueId: String(run.executionIssueId), testIssueId: String(run.testIssueId),
    testVersionId: run.testVersionId, testDigest: run.testDigest,
    environment: run.environment ?? '', configuration: run.configuration ?? '',
    release: run.release ?? null, chainDigest: run.chainDigest,
    retestOf: run.retestOf ?? null,
    ...(run.resolvedSteps ? { resolvedSteps: run.resolvedSteps, iterations: run.iterations, planningSnapshot: run.planningSnapshot } : {}),
    steps: steps.map(s => ({ id: s.id, status: s.status, actual: s.actual, comment: s.comment,
      evidence: (s.evidence ?? []).map(e => ({ attachmentId: String(e.attachmentId), sha256: e.sha256, size: Number(e.size),
        ...(e.retained ? { retained: e.retained, mimeType: e.mimeType ?? 'application/octet-stream' } : {}) })),
      recordedBy: s.recordedBy })),
    result
  };
}
