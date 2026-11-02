import { randomBytes } from 'node:crypto';
import { executionCandidateProof } from '../testmgmt/executionCandidate.js';
import { actorFrom } from './access.js';
import { resolveSubject } from './testAuthoring.js';
import { tmFail, tmRespond } from '../testmgmt/messages.js';
import { INTAKE_LIMITS, intakeHash, validIntakeId, parseIntake, verifyIntakeSecret, assertIntakeAuthority, preparedIntakeDigest, mapIntakeResult, validateIntakeReceipt } from '../testmgmt/intake.js';

const publicToken = ({ secretHash: _secret, ...token }) => token;
const publicReceipt = receipt => ({ receiptId: receipt.receiptId, status: receipt.status, payloadDigest: receipt.payloadDigest,
  receivedAt: receipt.receivedAt, reportedBuild: receipt.reportedBuild, tokenId: receipt.tokenId, grantId: receipt.grantId,
  mappings: receipt.mappings, progress: receipt.progress, auditConfirmed: receipt.status === 'APPLIED' && !!receipt.auditProof });
const active = (record, now) => !!record && record.revokedAt == null && record.expiresAt > now;

export function createTestIntake(deps) {
  async function scope(issueKey, actor, write = true) {
    if (!actor?.accountId) tmFail('AUTHENTICATION_REQUIRED');
    const subject = await resolveSubject(issueKey, deps, 'EXECUTION');
    const role = subject.project?.runChain?.steps?.[0]?.role;
    const canManage = !!role && await deps.hasIssuePermission(subject.issue.id, 'EDIT_ISSUES')
      && await deps.isEligibleFor({ accountId: actor.accountId, projectId: subject.projectId, issueTypeId: subject.issue.fields.issuetype.id, role });
    if (write && !canManage) tmFail('NOT_ELIGIBLE');
    return { ...subject, canManage };
  }
  function expiry(expiresAt, max = deps.now() + INTAKE_LIMITS.lifetime) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= deps.now() || expiresAt > max) tmFail('INVALID_INPUT');
    return expiresAt;
  }
  async function view({ issueKey }, actor) {
    const { issue, projectId, canManage } = await scope(issueKey, actor, false);
    const [tokens, grants, receipts] = await Promise.all([deps.listIntakeTokens(projectId), deps.listIntakeGrants(issue.id), deps.listIntakeReceipts(issue.id)]);
    return { canManage, tokens: canManage ? tokens.map(publicToken) : [], grants: canManage ? grants : [], receipts: receipts.map(publicReceipt), limits: INTAKE_LIMITS };
  }
  async function createToken({ issueKey, label, expiresAt }, actor) {
    const { projectId } = await scope(issueKey, actor);
    if (!deps.installationId || typeof label !== 'string' || !label.trim() || label.length > 100) tmFail('INVALID_INPUT');
    const secret = randomBytes(32).toString('hex');
    const token = { tokenId: deps.newHexId(), installationId: deps.installationId, projectId, label: label.trim(),
      secretHash: intakeHash(secret), expiresAt: expiry(expiresAt), revokedAt: null, createdBy: actor.accountId, createdAt: deps.now() };
    await deps.audit({ eventType: 'TM_INTAKE_TOKEN_CREATED', actorAccountId: actor.accountId, payload: publicToken(token) });
    if (!await deps.insertIntakeToken(token)) tmFail('STALE');
    return { ...publicToken(token), token: `tmci_${token.tokenId}_${secret}` };
  }
  async function revokeToken({ issueKey, tokenId }, actor) {
    const { projectId } = await scope(issueKey, actor), token = await deps.readIntakeToken(tokenId);
    if (!token || token.projectId !== projectId || token.installationId !== deps.installationId) tmFail('NOT_FOUND');
    await deps.revokeIntakeToken(tokenId, deps.now());
    await deps.audit({ eventType: 'TM_INTAKE_TOKEN_REVOKED', actorAccountId: actor.accountId, payload: { tokenId } });
    return { tokenId, revoked: true };
  }
  async function grant({ issueKey, tokenId, runIds, expiresAt }, actor) {
    const { issue, projectId } = await scope(issueKey, actor), token = await deps.readIntakeToken(tokenId);
    if (!active(token, deps.now()) || token.projectId !== projectId || token.installationId !== deps.installationId) tmFail('INTAKE_UNAUTHORIZED');
    if (String(issue.fields.status?.statusCategory?.key).toLowerCase() === 'done' || !Array.isArray(runIds) || !runIds.length
      || runIds.length > INTAKE_LIMITS.runs || new Set(runIds).size !== runIds.length || runIds.some(id => !validIntakeId(id))) tmFail('INVALID_INPUT');
    for (const runId of runIds) {
      const run = await deps.readRun(runId);
      if (!run || run.projectId !== projectId || run.executionIssueId !== String(issue.id) || run.state !== 'IN_PROGRESS' || run.intakeReceiptId || run.evidenceSchema !== 2) tmFail('INTAKE_MAPPING_INVALID');
      await deps.readIssueAsUser(run.testIssueId);
    }
    const record = { grantId: deps.newHexId(), installationId: deps.installationId, projectId, tokenId, executionIssueId: String(issue.id),
      runIds, expiresAt: expiry(expiresAt, token.expiresAt), revokedAt: null, createdBy: actor.accountId, createdAt: deps.now() };
    await deps.audit({ eventType: 'TM_INTAKE_GRANTED', actorAccountId: actor.accountId, issueId: Number(issue.id), payload: record });
    if (!await deps.insertIntakeGrant(record)) tmFail('STALE');
    return record;
  }
  async function revokeGrant({ issueKey, grantId }, actor) {
    const { issue, projectId } = await scope(issueKey, actor), grant = await deps.readIntakeGrant(grantId);
    if (!grant || grant.projectId !== projectId || grant.executionIssueId !== String(issue.id) || grant.installationId !== deps.installationId) tmFail('NOT_FOUND');
    await deps.revokeIntakeGrant(grantId, deps.now());
    await deps.audit({ eventType: 'TM_INTAKE_GRANT_REVOKED', actorAccountId: actor.accountId, issueId: Number(issue.id), payload: { grantId } });
    return { grantId, revoked: true };
  }
  async function receipt({ issueKey, receiptId }, actor) {
    const { issue, projectId } = await scope(issueKey, actor, false), record = await deps.readIntakeReceipt(receiptId);
    if (!record || record.projectId !== projectId || record.executionIssueId !== String(issue.id)) tmFail('NOT_FOUND');
    for (const mapping of record.mappings) {
      const run = await deps.readRun(mapping.runId);
      if (!run || run.projectId !== projectId || run.executionIssueId !== String(issue.id)) tmFail('NOT_FOUND');
      await deps.readIssueAsUser(run.testIssueId);
    }
    return { ...publicReceipt(record), originalPayload: record.originalPayload, provenance: record.provenance };
  }
  async function retry({ issueKey, receiptId }, actor) {
    await scope(issueKey, actor); await receipt({ issueKey, receiptId }, actor);
    await deps.enqueueIntake({ receiptId }); return { receiptId, queued: true };
  }
  async function authority({ tokenId, grantId, projectId, executionIssueId, runIds }) {
    const [token, grant, issue, project] = await Promise.all([deps.readIntakeToken(tokenId), deps.readIntakeGrant(grantId),
      deps.readIntakeExecution(executionIssueId), deps.readProject(projectId)]);
    assertIntakeAuthority(token, grant, { installationId: deps.installationId, now: deps.now(), projectId, executionIssueId, runIds });
    if (!project?.enabled || String(issue?.id) !== String(executionIssueId) || String(issue.fields?.project?.id) !== String(projectId)
      || String(issue.fields?.issuetype?.id) !== String(project.executionTypeId)
      || String(issue.fields?.status?.statusCategory?.key).toLowerCase() === 'done') tmFail('INTAKE_UNAUTHORIZED');
    return { token, grant };
  }
  async function receive({ authorization, body }) {
    const payload = parseIntake(body), match = /^Bearer tmci_([a-f0-9]{32})_/.exec(authorization ?? '');
    if (!match) tmFail('INTAKE_UNAUTHORIZED');
    const token = await deps.readIntakeToken(match[1]); verifyIntakeSecret(authorization, token);
    const projectId = token.projectId;
    await authority({ tokenId: token.tokenId, grantId: payload.grantId, projectId, executionIssueId: payload.executionIssueId, runIds: payload.results.map(result => result.runId) });
    const payloadDigest = intakeHash(body), idempotencyHash = intakeHash(`${deps.installationId}:${token.tokenId}:${payload.idempotencyKey}`);
    const previous = await deps.findIntakeReceipt(idempotencyHash);
    if (previous) {
      if (previous.payloadDigest !== payloadDigest) tmFail('IDEMPOTENCY_CONFLICT');
      if (previous.status !== 'APPLIED') await deps.enqueueIntake({ receiptId: previous.receiptId });
      return publicReceipt(previous);
    }
    const receiptId = deps.newHexId(), receivedAt = deps.now();
    const provenance = { kind: 'MACHINE', tokenId: token.tokenId, grantId: payload.grantId, installationId: deps.installationId, receiptId, payloadDigest, receivedAt };
    const mappings = [];
    for (const result of payload.results) {
      const run = await deps.readRun(result.runId);
      if (!run || run.projectId !== projectId || run.executionIssueId !== payload.executionIssueId || run.revision !== result.expectedRevision
        || run.intakeReceiptId || run.steps?.some(step => step.recordedBy != null)) tmFail('INTAKE_MAPPING_INVALID');
      mapIntakeResult(result, run, provenance);
      mappings.push({ runId: run.runId, expectedRevision: run.revision, preparedDigest: preparedIntakeDigest(run) });
    }
    if (!deps.claimExecutionCandidate) tmFail('CANDIDATE_PENDING');
    await deps.claimExecutionCandidate({ executionIssueId: payload.executionIssueId, projectId, reportedBuild: payload.reportedBuild, actorAccountId: `ci:${token.tokenId}` });
    const record = { receiptId, installationId: deps.installationId, projectId, executionIssueId: payload.executionIssueId,
      tokenId: token.tokenId, grantId: payload.grantId, idempotencyHash, payloadDigest, originalPayload: body,
      reportedBuild: payload.reportedBuild, provenance, receivedAt, status: 'QUEUED', progress: [], mappings,
      auditEventId: deps.newHexId(), auditProof: null };
    if (!await deps.insertIntakeReceipt(record)) {
      const other = await deps.findIntakeReceipt(idempotencyHash);
      if (!other || other.payloadDigest !== payloadDigest) tmFail('IDEMPOTENCY_CONFLICT');
      await deps.enqueueIntake({ receiptId: other.receiptId }); return publicReceipt(other);
    }
    await deps.enqueueIntake({ receiptId }); return publicReceipt(record);
  }
  async function process({ receiptId }) {
    const record = await deps.readIntakeReceipt(receiptId);
    if (!record || record.installationId !== deps.installationId) tmFail('INTAKE_RECORD_INVALID');
    const payload = validateIntakeReceipt(record);
    if(!deps.readExecutionCandidate||!executionCandidateProof(await deps.readExecutionCandidate(record.executionIssueId),record)) tmFail('CANDIDATE_PENDING');
    if (record.status === 'APPLIED') {
      if (!await deps.confirmIntakeAudit(record)) tmFail('INTAKE_PENDING');
      return publicReceipt(record);
    }
    const recheck = () => authority({ tokenId: record.tokenId, grantId: record.grantId, projectId: record.projectId,
      executionIssueId: record.executionIssueId, runIds: record.mappings.map(mapping => mapping.runId) });
    await recheck();
    // Reserve every run first. A later outage leaves all receipt members blocked.
    for (const mapping of record.mappings) {
      await recheck();
      const run = await deps.readRun(mapping.runId);
      if (!run || preparedIntakeDigest(run) !== mapping.preparedDigest) tmFail('INTAKE_MAPPING_INVALID');
      if (!await deps.reserveIntakeRun({ ...mapping, receiptId, now: deps.now() })) tmFail('INTAKE_MAPPING_INVALID');
    }
    for (const mapping of record.mappings) {
      await recheck();
      const run = await deps.readRun(mapping.runId), result = payload.results.find(value => value.runId === mapping.runId);
      const mapped = mapIntakeResult(result, run, record.provenance);
      if (!await deps.applyIntakeRun({ runId: run.runId, receiptId, expectedRevision: mapping.expectedRevision,
        ...mapped, reportedBuild: record.reportedBuild, provenance: record.provenance, now: deps.now() })) tmFail('INTAKE_MAPPING_INVALID');
      await recheck();
      await deps.markIntakeProgress(receiptId, run.runId, deps.now());
    }
    await recheck();
    let proof = await deps.confirmIntakeAudit(record);
    if (!proof) {
      await deps.audit({ eventId: Buffer.from(record.auditEventId, 'hex'), eventType: 'TM_INTAKE_APPLIED', actorAccountId: `ci:${record.tokenId}`,
        issueId: Number(record.executionIssueId), payload: { receiptId, payloadDigest: record.payloadDigest, tokenId: record.tokenId, grantId: record.grantId,
          executionIssueId: record.executionIssueId, mappings: record.mappings, reportedBuild: record.reportedBuild } });
      proof = await deps.confirmIntakeAudit(record);
    }
    if (!proof) tmFail('LEDGER_UNAVAILABLE');
    await recheck();
    if (!await deps.completeIntakeReceipt(receiptId, proof, deps.now())) tmFail('INTAKE_PENDING');
    return publicReceipt(await deps.readIntakeReceipt(receiptId));
  }
  return { view, createToken, revokeToken, grant, revokeGrant, receipt, retry, receive, process };
}

const call = method => async ({ payload = {}, context }) => tmRespond(async () => {
  const actor = actorFrom(context), deps = await (await import('../testmgmt/runtime.js')).testManagementRuntime();
  return createTestIntake(deps)[method](payload, actor);
});
export const getIntake = call('view');
export const createIntakeToken = call('createToken');
export const revokeIntakeToken = call('revokeToken');
export const grantIntake = call('grant');
export const revokeIntakeGrant = call('revokeGrant');
export const getIntakeReceipt = call('receipt');
export const retryIntakeReceipt = call('retry');
