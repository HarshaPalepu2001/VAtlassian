import { providerFor } from '../lib/approval/registry.js';
import { meetsAssurance, isAssuranceLevel, effectiveAssurance, controlledAuthenticationMethod } from '../lib/approval/levels.js';
import { makeApproval, validEvidence } from '../lib/approval/record.js';
import { FailClosed, DENY, ancestorDriftMessage, needsUserConsent } from '../lib/errors.js';
import { canonical } from '../lib/hash.js';
import { createChallengePayload, challengeContextHash } from '../lib/approval/challenge.js';
import { writeChallenge, getChallenge, markChallengeConsumed } from '../db/challengeStore.js';
import { lockLeaseMs } from '../lib/decision.js';
import { REVIEW_STATE } from '../lib/interception.js';
import { MIXED_INTENT } from '../lib/approval/mixedDecision.js';
import { harnessLog } from '../lib/harnessLogger.js';
import { hashBasis } from '../lib/hashBasis.js';

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
      || ![true, false, 0, 1, '0', '1'].includes(ct.capture_baseline)) fail('NOT_CONFIGURED');
}
function failure(error, context = {}) {
  // Forge asks the person to allow access only if this leaves the resolver.
  if (needsUserConsent(error)) throw error;
  if (!error?.reason) console.error('approval: unhandled failure', {
    ...context,
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    reason: error?.reason ?? null,
    message: typeof error?.message === 'string' ? error.message.split('\n')[0].slice(0, 300) : null,
    stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 3).join('\n') : null
  });
  return { success: false, reason: error.reason ?? 'SERVICE_UNAVAILABLE',
    error: error.userMessage ?? DENY[error.reason] ?? DENY.SERVICE_UNAVAILABLE };
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
  return review.last_checked_at == null || !Number.isFinite(checkedAt) || now - checkedAt <= lockLeaseMs(review.state);
}

export function createApprovalUsecases(deps) {
  // HELD FROM ABOVE (lib/ancestorHold.js): the validator refuses any
  // transition of a work item whose ancestor has undecided drift, so a
  // signature for one is refused here, before any authentication is spent.
  // Drift decisions are about content, not movement, and are never refused.
  async function refuseIfHeldFromAbove(issue) {
    if (typeof deps.ancestorDrift !== 'function') return;
    const above = await deps.ancestorDrift(issue);
    if (above) throw Object.assign(new FailClosed('ANCESTOR_DRIFT'), { userMessage: ancestorDriftMessage(above) });
  }

  const challenges = {
    write: deps.writeChallenge ?? writeChallenge,
    get: deps.getChallenge ?? getChallenge,
    consume: deps.markChallengeConsumed ?? markChallengeConsumed
  };

  async function decisionContext({ issue, actor, decision, requested = {}, expectedEvidenceHash, decisions }) {
    const requestedTransition = decision === 'APPROVE'
      && requested.intent !== 'DRIFT'
      && (requested.transitionId != null || requested.toStatusId != null);

    // An explicit workflow action is a different intent from a baseline drift
    // decision. Resolve and prepare that exact edge first, even when an older
    // active baseline is present; otherwise the baseline's historical edge is
    // incorrectly replayed against the item's current status.
    if (requestedTransition) {
      const transition = await deps.transition(issue, requested);
      if (!transition) fail('TRANSITION_UNAVAILABLE');
      const prepared = await deps.prepare({ issue, actor, decision, expectedEvidenceHash,
        forTransition: true, transition });
      const ct = await deps.edge(issue, transition, prepared);
      checkPolicy(ct);
      if (!await deps.eligible({ accountId: actor.accountId, projectId: issue.projectId,
        issueTypeId: issue.issueTypeId, role: ct.required_role })) fail('NOT_ELIGIBLE');
      return { prepared, transition, ct, hasTransition: true, workflowTransition: true };
    }

    // No transition means this is baseline-owned drift authority. Client
    // transition facts are deliberately ignored on this path.
    let prepared = await deps.prepare({ issue, actor, decision, expectedEvidenceHash,
      forTransition: false, transition: null, decisions });
    // A per-field decision is only meaningful against an approved baseline.
    if (decision === 'MIXED' && !prepared.baseline) fail('NO_BASELINE');
    let transition = null;
    let ct = prepared.approvalPolicy ?? null;

    if (prepared.baseline) {
      if (!ct) fail('BASELINE_POLICY_INCOMPLETE');

      // APPROVING DRIFT CAPTURES A BASELINE. IT DOES NOT TAKE A TRANSITION.
      //
      // This used to replay the baseline's original edge: require the item to
      // be back at that edge's starting status, re-resolve the transition, and
      // run it. That made drift undecidable as soon as the item moved on.
      // VJIRA-16 drifted in In Progress against a baseline captured on
      // Selected for Development -> In Progress, and its workflow offers no
      // route back to Selected for Development, so APPROVE was refused
      // STATUS_CHANGED with no way to ever satisfy it — leaving reject and
      // restore as the only exit from an unreviewed change.
      //
      // The two intents are genuinely different. A WORKFLOW action runs a gated
      // edge and records a fresh signature for it, above. A drift decision
      // answers "is what is on this work item now the approved version", which
      // is a question about CONTENT and carries no opinion about where the item
      // should sit. Approving it therefore captures a new baseline in place,
      // under the policy the latest baseline recorded — see drift.js's
      // ratification branch, which preserves that baseline's own transition,
      // review status and destination rather than promoting the item's current
      // status into a new policy edge.
      //
      // REJECT still carries the baseline edge, because the restore reads it to
      // decide where the approved content belongs. APPROVE and a per-field
      // (MIXED) decision resolve no edge: the mixed restore is scoped by its
      // own field plan, and its capture preserves the baseline's own edge.
      if (decision === 'REJECT') transition = { id: String(ct.transition_id), toStatusId: String(ct.to_status_id) };
    } else ct = await deps.edge(issue, transition, prepared);

    checkPolicy(ct);
    if (!await deps.eligible({ accountId: actor.accountId, projectId: issue.projectId,
      issueTypeId: issue.issueTypeId, role: ct.required_role })) fail('NOT_ELIGIBLE');
    return { prepared, transition, ct, hasTransition: decision === 'APPROVE' && transition != null,
      workflowTransition: false };
  }

  async function challenge({ payload = {}, context }) {
    let phase = 'start';
    let decision = null;
    try {
      phase = 'resolve-actor';
      const accountId = actorId(context);
      const mixed = payload.intent === MIXED_INTENT;
      decision = mixed ? 'MIXED' : payload.decision;
      if (!['APPROVE', 'REJECT', 'MIXED'].includes(decision)) fail('NOT_CONFIGURED');
      phase = 'resolve-issue';
      const issue = await deps.issue({ payload, context });
      phase = 'resolve-signer';
      const actor = await deps.actor(accountId);
      // A per-field map is validated here, against the server's own reading of
      // the drift, before a challenge row exists: an impossible choice is
      // refused before any authentication is spent.
      phase = 'prepare-evidence';
      const { prepared, transition, ct, workflowTransition } = await decisionContext({ issue, actor,
        decision, requested: payload, expectedEvidenceHash: payload.expectedEvidenceHash,
        decisions: mixed ? payload.decisions : undefined });
      phase = 'verify-evidence';
      if (payload.expectedEvidenceHash != null && payload.expectedEvidenceHash !== prepared.evidenceHash) fail('CONTENT_CHANGED');
      phase = 'ancestor-hold';
      if (workflowTransition) await refuseIfHeldFromAbove(issue);

      const tenantId = context.siteUrl || 'local';

      phase = 'build-challenge';
      const chRow = createChallengePayload({
        tenantId,
        issueId: issue.issueId,
        signerAccountId: accountId,
        decision,
        meaning: ct.meaning,
        candidateHash: prepared.contentHash,
        // A baseline-owned drift decision uses the baseline edge internally for
        // its declaration, but it is not a workflow transition request. Keeping
        // this null lets submit recover the same intent instead of replaying the
        // historical edge as current workflow intent.
        transitionId: workflowTransition ? transition?.id : null,
        baselineId: prepared.baseline?.baseline_id,
        operationPlanHash: challengeContextHash({ issue, transition, prepared, policy: ct }),
        now: deps.now()
      });

      phase = 'write-challenge';
      const challengeId = await challenges.write(chRow);
      return { success: true, challengeId: challengeId.toString('hex'), nonce: chRow.nonce, meaning: chRow.meaning, requiredAssurance: effectiveAssurance(ct.required_assurance), expiresAt: chRow.expires_at,
        ...(prepared.linkPolicy?.version === 2 ? { linkPolicyNotice: 'This approval records the test link rules: a Test owns its Verifies links. Linked source approvals exclude those links; other issue links remain controlled.' } : {}),
        ...(prepared.mixed ? { mixed: { approve: prepared.mixed.approvedIds, reject: prepared.mixed.rejectedIds,
          evidenceHash: prepared.evidenceHash ?? null } } : {}) };
    } catch (error) {
      return failure(error, { phase, decision, issueKey: payload.issueKey ?? payload.issueId ?? null,
        mixedFieldCount: Array.isArray(payload.decisions) ? payload.decisions.length : null });
    }
  }

  async function submit({ payload = {}, context }) {
    try {
      const accountId = actorId(context);

      // EVERY SIGNATURE ANSWERS A CHALLENGE. The challenge fixed, once, the
      // meaning the signer was shown, the candidate content and the exact edge;
      // a submit without one would choose its own transition and could leave
      // the evidence hash out, approving content nobody reviewed. Every client
      // (panel, review window, both transition-screen fields) signs this way.
      const approvalNote = note(payload);
      if (typeof payload.challengeId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.challengeId)) fail('NO_DECISION');
      const challengeRow = await challenges.get(Buffer.from(payload.challengeId, 'hex'));
      if (!challengeRow || challengeRow.state !== 'PENDING' || challengeRow.signer_account_id !== accountId || Number(challengeRow.expires_at) <= deps.now()) {
        fail('NO_DECISION');
      }

      const issue = await deps.issue({ payload: { issueKey: payload.issueKey }, context });
      if (issue.issueId !== challengeRow.issue_id) fail('NOT_CONFIGURED');
      const actor = await deps.actor(accountId);
      const { prepared, transition, ct, hasTransition, workflowTransition } = await decisionContext({ issue, actor,
        decision: challengeRow.decision,
        requested: challengeRow.transition_id != null
          ? { intent: 'WORKFLOW', transitionId: challengeRow.transition_id }
          : { intent: challengeRow.decision === 'MIXED' ? MIXED_INTENT : 'DRIFT' },
        decisions: challengeRow.decision === 'MIXED' ? payload.decisions : undefined });
      if (challengeRow.transition_id != null && String(challengeRow.transition_id) !== String(transition?.id ?? '')) fail('TRANSITION_MISMATCH');
      if (challengeRow.transition_id == null && workflowTransition) fail('TRANSITION_MISMATCH');
      if (prepared.contentHash !== challengeRow.candidate_hash) fail('CONTENT_CHANGED');
      // What the signed hash covers, so a later validator denial can be compared
      // against it (gate.js logs the same shape). Same labels as the validator's.
      harnessLog('APPROVAL', 'approval:hash-basis', { issueKey: issue.issueKey, contentHash: prepared.contentHash,
        basis: hashBasis({ mode: prepared.treeHash ? 'tree' : 'flat',
          scopeSource: prepared.ruleScope?.source === 'INHERITED' ? 'governing-root' : 'own',
          scopeIssueTypeId: prepared.ruleScope?.issueTypeId, fields: prepared.fields ?? [], issue: prepared.issue }) });
      if (activeOperationLock(prepared.review, deps.now())) fail('RESTORE_IN_PROGRESS');
      if (workflowTransition) await refuseIfHeldFromAbove(issue);
      // A signed capture resolves this drift in apply(), before a pending
      // transition capability is published. Non-capturing edges still block.
      // Its OWN drift, as the validator holds it: for a tree, driftCount also
      // counts the children's changes, which flag a parent but never hold it
      // (found live 2026-10-12: VAT-72's Development Phase refused at submit
      // for a sub-task's label).
      if (hasTransition && !yes(ct.capture_baseline)) {
        const own = typeof deps.ownDriftCount === 'function' ? await deps.ownDriftCount(issue) : prepared.driftCount;
        if (own > 0) fail('UNDECIDED_DRIFT');
      }
      if (challengeRow.operation_plan_hash !== challengeContextHash({ issue, transition, prepared, policy: ct })) fail('CONTENT_CHANGED');

      const required = controlledAuthenticationMethod(ct.required_assurance);
      const binding = { accountId, issueId: issue.issueId, fromStatusId: issue.statusId,
        toStatusId: transition?.toStatusId ?? issue.statusId, contentHash: prepared.contentHash, decision: challengeRow.decision,
        // Only a mixed decision binds a map, so every whole-set binding is unchanged.
        ...(prepared.mixed ? { decisionMapHash: prepared.mixed.mapHash } : {}) };
      payload = { ...payload, decision: challengeRow.decision, note: approvalNote };

      // Preauthorization only defers Jira's transition; it is not affirmation.
      if (payload.confirmed !== true) fail('NO_DECISION');
      // Dispatch to the ONE provider configured for this edge. providerInput()
      // rejects any payload field belonging to the OTHER provider before any
      // provider code runs (so no OTP attempt or WebAuthn challenge is spent).
      const proof = await providerFor(required).verify({
        binding: { ...binding, transitionId: transition?.id ?? null },
        approvalChallengeId: challengeRow.challenge_id,
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

      if (!await challenges.consume(challengeRow.challenge_id)) fail('NO_DECISION');

      const row = makeApproval({ ...binding, issueKey: issue.issueKey, projectId: issue.projectId, issueTypeId: issue.issueTypeId,
        actorName: actor.displayName, signerRole: ct.required_role, meaning: ct.meaning, transitionId: transition?.id,
        proof, now: deps.now(), baselineId: workflowTransition ? null : prepared.baseline?.baseline_id,
        baselineVersion: workflowTransition ? null : prepared.baselineVersion,
        coversFromHash: workflowTransition ? null : prepared.baseline?.content_hash,
        driftCount: prepared.driftCount, reportHash: prepared.reportHash, note: payload.note || null, linkPolicy: prepared.linkPolicy,
        ...(prepared.mixed ? { decisionMap: canonical(prepared.mixed.decisions), decisionMapHash: prepared.mixed.mapHash } : {}) });
      await deps.record(row);
      await deps.audit({ eventType: 'APPROVAL_RECORDED', actorAccountId: accountId, issueId: issue.issueId, approvalId: row.approval_id,
        payload: { decision: row.decision, meaning: row.meaning, printedName: row.printed_name, assuranceLevel: row.assurance_level,
          providerId: row.provider_id, evidenceHash: row.evidence_hash, contentHash: row.content_hash, fromStatusId: row.from_status_id, toStatusId: row.to_status_id,
          ...(prepared.mixed ? { decisionMap: prepared.mixed.decisions, approvedCount: prepared.mixed.approvedIds.length,
            rejectedCount: prepared.mixed.rejectedIds.length } : {}) } });

      const applied = await deps.apply({ issue, actor, approval: row, prepared, context, policy: ct, workflowTransition });
      // A queued restore reports success:false with its state: it is running, not failed.
      if (applied?.success !== true && !(['REJECT', 'MIXED'].includes(row.decision) && applied?.state)) fail('SERVICE_UNAVAILABLE');
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
      if (row.decision === 'MIXED') result.mixed = applied?.mixed ?? null;
      if (['REJECT', 'MIXED'].includes(row.decision)) result.restore = applied;
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
      const prepared = await deps.prepare({ issue, actor: await deps.actor(accountId), decision: 'APPROVE', forTransition: true, transition,
        linkPolicy: row.link_policy ?? null });
      if (prepared.contentHash !== row.content_hash) fail('CONTENT_CHANGED');
      return { success: true, approvalId: payload.approvalId, ...await deps.performTransition(issue, transition, row) };
    } catch (error) { return failure(error); }
  }
  return { challenge, submit, retryTransition };
}

export async function submit(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).submit(args); }
export async function retryTransition(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).retryTransition(args); }
export async function challenge(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).challenge(args); }
