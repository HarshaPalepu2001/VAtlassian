import { providerFor } from '../lib/approval/registry.js';
import { meetsAssurance, isAssuranceLevel, effectiveAssurance, controlledAuthenticationMethod } from '../lib/approval/levels.js';
import { makeApproval, validEvidence } from '../lib/approval/record.js';
import { FailClosed, DENY } from '../lib/errors.js';
import { createChallengePayload, challengeContextHash } from '../lib/approval/challenge.js';
import { writeChallenge, getChallenge, markChallengeConsumed } from '../db/challengeStore.js';
import { LOCK_TTL_MS } from '../lib/decision.js';
import { REVIEW_STATE } from '../lib/interception.js';

const fail = reason => { throw new FailClosed(reason); };
/**
 * Return only the evidence fields accepted by the configured provider, and
 * reject any field that belongs to the OTHER provider. This runs BEFORE any
 * provider is invoked, so a mismatched payload field is caught and returned
 * as WRONG_AUTHENTICATION_METHOD without spending any OTP attempt or WebAuthn
 * challenge.
 */
function providerInput(required, payload) {
  if (required === 'BIOMETRIC') {
    if (payload.code != null && payload.code !== '') fail('WRONG_AUTHENTICATION_METHOD');
    return { webauthn: payload.webauthn };
  }
  // ESIGNATURE
  if (payload.webauthn != null) fail('WRONG_AUTHENTICATION_METHOD');
  return { code: payload.code };
}

const MAX_NOTE_LENGTH = 4000;
function actorId(context) {
  if (typeof context?.accountId !== 'string' || !context.accountId) fail('NOT_ELIGIBLE');
  return context.accountId;
}
const yes = value => [true, 1, '1'].includes(value);
function checkPolicy(ct) {
  if (!ct || !isAssuranceLevel(ct.required_assurance) || !ct.required_role || !ct.meaning
      || ![true, false, 0, 1, '0', '1'].includes(ct.capture_baseline)
      || ![true, false, 0, 1, '0', '1'].includes(ct.block_on_drift)) fail('NOT_CONFIGURED');
}
function failure(error) {
  return { success: false, reason: error.reason ?? 'SERVICE_UNAVAILABLE', error: DENY[error.reason] ?? DENY.SERVICE_UNAVAILABLE };
}
function note(payload) {
  if (payload.note == null) return null;
  if (typeof payload.note !== 'string' || payload.note.length > MAX_NOTE_LENGTH) fail('NOT_CONFIGURED');
  return payload.note || null;
}
function activeOperationLock(review, now) {
  if (review?.state === REVIEW_STATE.LOCKED) return true;
  if (![REVIEW_STATE.RESTORING, REVIEW_STATE.DECIDING].includes(review?.state)) return false;
  const checkedAt = Number(review.last_checked_at);
  return review.last_checked_at == null || !Number.isFinite(checkedAt) || now - checkedAt <= LOCK_TTL_MS;
}

export function createApprovalUsecases(deps) {
  const challenges = {
    write: deps.writeChallenge ?? writeChallenge,
    get: deps.getChallenge ?? getChallenge,
    consume: deps.markChallengeConsumed ?? markChallengeConsumed
  };

  async function decisionContext({ issue, actor, decision, requested = {}, expectedEvidenceHash }) {
    // First discover the latest active baseline without allowing any client
    // transition facts to influence drift authority.
    let prepared = await deps.prepare({ issue, actor, decision, expectedEvidenceHash,
      forTransition: false, transition: null });
    let transition = null;
    let ct = prepared.approvalPolicy ?? null;

    if (prepared.baseline) {
      if (!ct) fail('BASELINE_POLICY_INCOMPLETE');
      if (decision === 'APPROVE') {
        transition = await deps.transition(issue, { transitionId: ct.transition_id });
        if (!transition || String(transition.id) !== String(ct.transition_id)
            || String(transition.toStatusId) !== String(ct.to_status_id)
            || String(issue.statusId) !== String(ct.from_status_id)) fail('CONTENT_CHANGED');
      } else transition = { id: String(ct.transition_id), toStatusId: String(ct.to_status_id) };
    } else {
      const requestedTransition = decision === 'APPROVE'
        && (requested.transitionId != null || requested.toStatusId != null);
      transition = requestedTransition ? await deps.transition(issue, requested) : null;
      if (requestedTransition && !transition) fail('NOT_CONFIGURED');
      if (transition) {
        prepared = await deps.prepare({ issue, actor, decision, expectedEvidenceHash,
          forTransition: true, transition });
      }
      ct = await deps.edge(issue, transition, prepared);
    }

    checkPolicy(ct);
    if (!await deps.eligible({ accountId: actor.accountId, projectId: issue.projectId,
      issueTypeId: issue.issueTypeId, role: ct.required_role })) fail('NOT_ELIGIBLE');
    return { prepared, transition, ct, hasTransition: decision === 'APPROVE' && transition != null };
  }

  async function challenge({ payload = {}, context }) {
    try {
      const accountId = actorId(context);
      if (!['APPROVE', 'REJECT'].includes(payload.decision)) fail('NOT_CONFIGURED');
      const issue = await deps.issue({ payload, context });
      const actor = await deps.actor(accountId);
      const { prepared, transition, ct } = await decisionContext({ issue, actor,
        decision: payload.decision, requested: payload, expectedEvidenceHash: payload.expectedEvidenceHash });
      if (payload.expectedEvidenceHash != null && payload.expectedEvidenceHash !== prepared.evidenceHash) fail('CONTENT_CHANGED');

      const tenantId = context.siteUrl || 'local';

      const chRow = createChallengePayload({
        tenantId,
        issueId: issue.issueId,
        signerAccountId: accountId,
        decision: payload.decision,
        meaning: ct.meaning,
        candidateHash: prepared.contentHash,
        transitionId: transition?.id,
        baselineId: prepared.baseline?.baseline_id,
        operationPlanHash: challengeContextHash({ issue, transition, prepared, policy: ct }),
        now: deps.now()
      });

      const challengeId = await challenges.write(chRow);
      return { success: true, challengeId: challengeId.toString('hex'), nonce: chRow.nonce, meaning: chRow.meaning, requiredAssurance: effectiveAssurance(ct.required_assurance), expiresAt: chRow.expires_at };
    } catch (error) {
      return failure(error);
    }
  }

  async function submit({ payload = {}, context }) {
    try {
      const accountId = actorId(context);
      let issue, actor, ct, prepared, hasTransition, transition, required, binding;
      let challengeRow = null;

      if (payload.challengeId) {
        const approvalNote = note(payload);
        if (typeof payload.challengeId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.challengeId)) fail('NO_DECISION');
        challengeRow = await challenges.get(Buffer.from(payload.challengeId, 'hex'));
        if (!challengeRow || challengeRow.state !== 'PENDING' || challengeRow.signer_account_id !== accountId || Number(challengeRow.expires_at) <= deps.now()) {
          fail('NO_DECISION');
        }

        issue = await deps.issue({ payload: { issueKey: payload.issueKey }, context });
        if (issue.issueId !== challengeRow.issue_id) fail('NOT_CONFIGURED');
        actor = await deps.actor(accountId);
        ({ prepared, transition, ct, hasTransition } = await decisionContext({ issue, actor,
          decision: challengeRow.decision, requested: { transitionId: challengeRow.transition_id } }));
        if (String(challengeRow.transition_id ?? '') !== String(transition?.id ?? '')) fail('CONTENT_CHANGED');
        if (prepared.contentHash !== challengeRow.candidate_hash) fail('CONTENT_CHANGED');
        if (activeOperationLock(prepared.review, deps.now())) fail('RESTORE_IN_PROGRESS');
        // A signed capture resolves this drift in apply(), before a pending
        // transition capability is published. Non-capturing edges still block.
        if (hasTransition && !yes(ct.capture_baseline) && prepared.driftCount > 0) fail('UNDECIDED_DRIFT');
        if (challengeRow.operation_plan_hash !== challengeContextHash({ issue, transition, prepared, policy: ct })) fail('CONTENT_CHANGED');

        required = controlledAuthenticationMethod(ct.required_assurance);
        binding = { accountId, issueId: issue.issueId, fromStatusId: issue.statusId,
          toStatusId: transition?.toStatusId ?? issue.statusId, contentHash: prepared.contentHash, decision: challengeRow.decision };
        payload = { ...payload, decision: challengeRow.decision, note: approvalNote };

      } else {
        if (!['APPROVE', 'REJECT'].includes(payload.decision)) fail('NOT_CONFIGURED');
        const approvalNote = note(payload);
        issue = await deps.issue({ payload, context });
        actor = await deps.actor(accountId);
        ({ prepared, transition, ct, hasTransition } = await decisionContext({ issue, actor,
          decision: payload.decision, requested: payload, expectedEvidenceHash: payload.expectedEvidenceHash }));
        if (payload.expectedEvidenceHash != null && payload.expectedEvidenceHash !== prepared.evidenceHash) fail('CONTENT_CHANGED');
        if (activeOperationLock(prepared.review, deps.now())) fail('RESTORE_IN_PROGRESS');
        if (hasTransition && !yes(ct.capture_baseline) && prepared.driftCount > 0) fail('UNDECIDED_DRIFT');
        binding = { accountId, issueId: issue.issueId, fromStatusId: issue.statusId,
          toStatusId: transition?.toStatusId ?? issue.statusId, contentHash: prepared.contentHash, decision: payload.decision };
        required = controlledAuthenticationMethod(ct.required_assurance);
        payload = { ...payload, note: approvalNote };
      }

      // Preauthorization only defers Jira's transition; it is not affirmation.
      if (payload.confirmed !== true) fail('NO_DECISION');
      // Dispatch to the ONE provider configured for this edge. providerInput()
      // rejects any payload field belonging to the OTHER provider before any
      // provider code runs (so no OTP attempt or WebAuthn challenge is spent).
      const proof = await providerFor(required).verify({
        binding: { ...binding, transitionId: transition?.id ?? null },
        confirmed: payload.confirmed,
        ...providerInput(required, payload),
        totpDeps: deps.totpDeps,
        webauthnDeps: deps.webauthnDeps,
        context
      });
      if (!proof.ok || proof.level !== required) {
        const reason = proof.reason ?? 'INSUFFICIENT_ASSURANCE';
        await deps.audit({ eventType: 'APPROVAL_REFUSED', actorAccountId: accountId, issueId: issue.issueId,
          payload: { reason, requiredAssurance: required } });
        return { success: false, reason, error: proof.error ?? DENY[reason] ?? DENY.SERVICE_UNAVAILABLE };
      }

      if (challengeRow && !await challenges.consume(challengeRow.challenge_id)) fail('NO_DECISION');

      const row = makeApproval({ ...binding, issueKey: issue.issueKey, projectId: issue.projectId, issueTypeId: issue.issueTypeId,
        actorName: actor.displayName, signerRole: ct.required_role, meaning: ct.meaning, transitionId: transition?.id,
        proof, now: deps.now(), baselineId: prepared.baseline?.baseline_id, baselineVersion: prepared.baselineVersion,
        coversFromHash: prepared.baseline?.content_hash, driftCount: prepared.driftCount, reportHash: prepared.reportHash, note: payload.note || null });
      await deps.record(row);
      await deps.audit({ eventType: 'APPROVAL_RECORDED', actorAccountId: accountId, issueId: issue.issueId, approvalId: row.approval_id,
        payload: { decision: row.decision, meaning: row.meaning, printedName: row.printed_name, assuranceLevel: row.assurance_level,
          providerId: row.provider_id, evidenceHash: row.evidence_hash, contentHash: row.content_hash, fromStatusId: row.from_status_id, toStatusId: row.to_status_id } });

      const applied = await deps.apply({ issue, actor, approval: row, prepared, context, policy: ct });
      if (applied?.success !== true && !(row.decision === 'REJECT' && applied?.state)) fail('SERVICE_UNAVAILABLE');
      // Publish only after the approval audit and application are durable. Jira's
      // synchronous validator must be able to consume this row during the POST.
      const initialState = hasTransition ? 'PENDING' : 'CONSUMED';
      if (!await deps.activate({ approvalId: row.approval_id, now: deps.now(), state: initialState })) fail('SERVICE_UNAVAILABLE');
      const result = { success: true, approvalId: row.approval_id.toString('hex'), assuranceLevel: row.assurance_level,
        printedName: row.printed_name, meaning: row.meaning, transitioned: false,
        baselinePublished: applied?.baselinePublished === true || applied?.capture?.captured === true,
        retryableApprovalId: null };
      if (hasTransition && payload.preauthorize !== true) {
        try { Object.assign(result, await deps.performTransition(issue, transition, row)); }
        catch { result.transitionError = 'Approval recorded. Refresh the work item to check the transition result.'; }
        if (result.transitioned !== true) {
          if (prepared.baseline) await deps.invalidate?.({ approvalId: row.approval_id, now: deps.now() });
          else result.retryableApprovalId = result.approvalId;
        }
      }
      // Another Jira validator may refuse after ours has spent the approval.
      // Preserve the actual lifecycle; never reactivate a spent capability.
      result.state = (await deps.byId(row.approval_id))?.state ?? initialState;
      if (row.decision === 'REJECT') result.restore = applied;
      return result;
    } catch (error) { return failure(error); }
  }

  async function retryTransition({ payload = {}, context }) {
    try {
      const accountId = actorId(context);
      if (typeof payload.approvalId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.approvalId)) fail('NO_DECISION');
      const issue = await deps.issue({ payload, context });
      const row = await deps.byId(Buffer.from(payload.approvalId, 'hex'));
      if (!row || row.account_id !== accountId || String(row.issue_id) !== String(issue.issueId)
          || row.state !== 'PENDING' || row.decision !== 'APPROVE' || Number(row.expires_at) <= deps.now()
          || row.from_status_id !== issue.statusId || row.baseline_id != null || !validEvidence(row)) fail('NO_DECISION');
      const transition = await deps.transition(issue, { transitionId: payload.transitionId ?? row.transition_id });
      if (!transition || transition.toStatusId !== row.to_status_id || transition.id !== row.transition_id) fail('NO_DECISION');
      const ct = await deps.edge(issue, transition);
      checkPolicy(ct);
      if (!meetsAssurance(row.assurance_level, effectiveAssurance(ct.required_assurance))) fail('INSUFFICIENT_ASSURANCE');
      if (!await deps.eligible({ accountId, projectId: issue.projectId, issueTypeId: issue.issueTypeId, role: ct.required_role })) fail('NOT_ELIGIBLE');
      const prepared = await deps.prepare({ issue, actor: await deps.actor(accountId), decision: 'APPROVE', forTransition: true, transition });
      if (prepared.contentHash !== row.content_hash) fail('CONTENT_CHANGED');
      return { success: true, approvalId: payload.approvalId, ...await deps.performTransition(issue, transition, row) };
    } catch (error) { return failure(error); }
  }
  return { challenge, submit, retryTransition };
}

export async function submit(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).submit(args); }
export async function retryTransition(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).retryTransition(args); }
export async function challenge(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).challenge(args); }
