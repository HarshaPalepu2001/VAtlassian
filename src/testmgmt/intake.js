import { createHash, timingSafeEqual } from 'node:crypto';
import { contentDigest } from './content.js';
import { isStepStatus, runResult } from './results.js';
import { tmFail } from './messages.js';

export const INTAKE_LIMITS = Object.freeze({ bytes: 256 * 1024, runs: 50, steps: 500, text: 4000, log: 16000, lifetime: 90 * 86400000 });
export const intakeHash = value => createHash('sha256').update(value).digest('hex');
export const validIntakeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const string = (value, limit) => typeof value === 'string' && value.length <= limit;

export function parseIntake(body) {
  if (typeof body !== 'string') tmFail('INVALID_INPUT');
  if (Buffer.byteLength(body, 'utf8') > INTAKE_LIMITS.bytes) tmFail('INTAKE_TOO_LARGE');
  let payload; try { payload = JSON.parse(body); } catch { tmFail('INVALID_INPUT'); }
  if (!keys(payload, ['idempotencyKey', 'executionIssueId', 'grantId', 'reportedBuild', 'results'])
    || !/^[a-zA-Z0-9_.:-]{8,100}$/.test(payload.idempotencyKey ?? '') || !/^\d+$/.test(payload.executionIssueId ?? '')
    || !validIntakeId(payload.grantId) || !keys(payload.reportedBuild, ['id', 'name', 'commit', 'repository', 'pipelineUrl', 'artifactDigest'])
    || !string(payload.reportedBuild.id, 255) || !payload.reportedBuild.id.trim()
    || Object.values(payload.reportedBuild).some(value => !string(value, 2000))
    || !Array.isArray(payload.results) || !payload.results.length || payload.results.length > INTAKE_LIMITS.runs) tmFail('INVALID_INPUT');
  let count = 0; const seen = new Set();
  for (const result of payload.results) {
    if (!keys(result, ['runId', 'expectedRevision', 'steps']) || !validIntakeId(result.runId) || seen.has(result.runId)
      || !Number.isSafeInteger(result.expectedRevision) || result.expectedRevision < 1 || !Array.isArray(result.steps) || !result.steps.length) tmFail('INTAKE_MAPPING_INVALID');
    seen.add(result.runId); count += result.steps.length;
    for (const step of result.steps) {
      if (!keys(step, ['stepId', 'iterationId', 'status', 'actual', 'comment', 'log', 'evidence'])
        || !string(step.stepId, 100) || !string(step.iterationId, 100) || !isStepStatus(step.status)
        || !string(step.actual ?? '', INTAKE_LIMITS.text) || !string(step.comment ?? '', INTAKE_LIMITS.text)
        || !string(step.log ?? '', INTAKE_LIMITS.log)
        // This intake stores original logs in the receipt. Jira evidence must
        // be retained by the existing attachment ceremony before human review.
        || (step.evidence != null && (!Array.isArray(step.evidence) || step.evidence.length))) tmFail('INVALID_INPUT');
    }
  }
  if (count > INTAKE_LIMITS.steps) tmFail('INTAKE_TOO_LARGE');
  return payload;
}

export function verifyIntakeSecret(authorization, token) {
  const match = /^Bearer tmci_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(authorization ?? '');
  if (!match || !token || match[1] !== token.tokenId || !/^[a-f0-9]{64}$/.test(token.secretHash ?? '')) tmFail('INTAKE_UNAUTHORIZED');
  if (!timingSafeEqual(Buffer.from(intakeHash(match[2]), 'hex'), Buffer.from(token.secretHash, 'hex'))) tmFail('INTAKE_UNAUTHORIZED');
}

export function assertIntakeAuthority(token, grant, { now, installationId, projectId, executionIssueId, runIds }) {
  if (!installationId || !token || !grant || token.installationId !== installationId || grant.installationId !== installationId
    || String(token.projectId) !== String(projectId) || String(grant.projectId) !== String(projectId)
    || grant.tokenId !== token.tokenId || String(grant.executionIssueId) !== String(executionIssueId)
    || token.revokedAt != null || grant.revokedAt != null || !Number.isSafeInteger(token.expiresAt) || !Number.isSafeInteger(grant.expiresAt) || token.expiresAt <= now || grant.expiresAt <= now
    || !Array.isArray(grant.runIds) || runIds.some(id => !grant.runIds.includes(id))) tmFail('INTAKE_UNAUTHORIZED');
}

export function preparedIntakeDigest(run) {
  return contentDigest({ runId: run.runId, projectId: run.projectId, executionIssueId: run.executionIssueId, testIssueId: run.testIssueId,
    testVersionId: run.testVersionId, testDigest: run.testDigest ?? null, resolvedSteps: run.resolvedSteps,
    iterations: run.iterations, attemptSequence: run.attemptSequence, classification: run.classification ?? null,
    chainDigest: run.chainDigest ?? null, environment: run.environment ?? '', configuration: run.configuration ?? '',
    release: run.release ?? null, planningSnapshot: run.planningSnapshot ?? null });
}

export function mapIntakeResult(result, run, provenance) {
  if (!run || run.evidenceSchema !== 2 || !Number.isSafeInteger(run.attemptSequence) || run.attemptSequence < 1
    || run.state !== 'IN_PROGRESS' || run.stepEventId || !Array.isArray(run.resolvedSteps) || !run.resolvedSteps.length
    || !Array.isArray(run.iterations) || !run.iterations.length || result.steps.length !== run.resolvedSteps.length) tmFail('INTAKE_MAPPING_INVALID');
  const input = new Map();
  for (const step of result.steps) {
    if (input.has(step.stepId)) tmFail('INTAKE_MAPPING_INVALID');
    input.set(step.stepId, step);
  }
  const mapped = run.resolvedSteps.map(definition => {
    const step = input.get(definition.id);
    const iteration = run.iterations.find(value => value.stepIds?.includes(definition.id));
    if (!step || !iteration || step.iterationId !== iteration.id || (definition.iterationId && step.iterationId !== definition.iterationId)) tmFail('INTAKE_MAPPING_INVALID');
    return { id: definition.id, status: step.status, actual: step.actual ?? '', comment: step.comment ?? '', evidence: [],
      recordedBy: `ci:${provenance.tokenId}`, recordedAt: provenance.receivedAt,
      ...(definition.iterationId ? { iterationId: definition.iterationId, sourceStepId: definition.sourceStepId } : {}) };
  });
  return { steps: mapped, result: runResult(run.iterations.map(iteration => ({ steps: mapped.filter(step => iteration.stepIds.includes(step.id)).map(step => step.status) }))) };
}

/** Cross-check materialized receipt fields against the exact preserved submission. */
export function validateIntakeReceipt(receipt) {
  if (!receipt || typeof receipt.originalPayload !== 'string' || intakeHash(receipt.originalPayload) !== receipt.payloadDigest
    || !validIntakeId(receipt.receiptId) || !validIntakeId(receipt.tokenId) || !validIntakeId(receipt.grantId)
    || !Number.isSafeInteger(receipt.receivedAt) || !Array.isArray(receipt.mappings) || !receipt.mappings.length) tmFail('INTAKE_RECORD_INVALID');
  const payload = parseIntake(receipt.originalPayload);
  const expectedProvenance = { kind: 'MACHINE', tokenId: receipt.tokenId, grantId: receipt.grantId, installationId: receipt.installationId,
    receiptId: receipt.receiptId, payloadDigest: receipt.payloadDigest, receivedAt: receipt.receivedAt };
  if (payload.grantId !== receipt.grantId || payload.executionIssueId !== receipt.executionIssueId
    || contentDigest(payload.reportedBuild) !== contentDigest(receipt.reportedBuild)
    || contentDigest(receipt.provenance) !== contentDigest(expectedProvenance)
    || receipt.mappings.length !== payload.results.length || new Set(receipt.mappings.map(mapping => mapping.runId)).size !== receipt.mappings.length
    || receipt.mappings.some(mapping => !/^[a-f0-9]{64}$/.test(mapping.preparedDigest)
      || !payload.results.some(result => result.runId === mapping.runId && result.expectedRevision === mapping.expectedRevision))) tmFail('INTAKE_RECORD_INVALID');
  return payload;
}

/** Receipt readiness is independent of token expiry after completed application. */
export async function assertIntakeReady(run, deps) {
  if (run.provenance?.kind === 'MACHINE' && !run.intakeReceiptId) tmFail('INTAKE_PENDING');
  const receipts = await deps.readIntakeForRun(run.runId);
  if (!Array.isArray(receipts)) tmFail('INTAKE_PENDING');
  const own = run.intakeReceiptId ? await deps.readIntakeReceipt(run.intakeReceiptId) : null;
  if (run.intakeReceiptId && (!own || !receipts.some(value => value.receiptId === own.receiptId))) tmFail('INTAKE_PENDING');
  for (const receipt of receipts) {
    validateIntakeReceipt(receipt);
    if (receipt.status !== 'APPLIED' || !receipt.mappings?.every(mapping => receipt.progress?.includes(mapping.runId))
      || !await deps.confirmIntakeAudit(receipt)) tmFail('INTAKE_PENDING');
  }
  return true;
}
