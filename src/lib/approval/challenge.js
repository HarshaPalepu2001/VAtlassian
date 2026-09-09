import crypto from 'crypto';
import { FailClosed } from '../errors.js';
import { canonical, sha256Hex } from '../hash.js';

/** Bind the declaration and restore target as well as the current field values. */
export function challengeContextHash({ issue, transition, prepared, policy }) {
  return sha256Hex(canonical({
    fromStatusId: String(issue.statusId), toStatusId: String(transition?.toStatusId ?? issue.statusId),
    transitionId: transition?.id == null ? null : String(transition.id),
    baselineId: prepared.baseline?.baseline_id?.toString('hex') ?? null,
    baselineVersion: Number(prepared.baselineVersion ?? 0),
    baselineHash: prepared.baseline?.content_hash ?? null,
    evidenceHash: prepared.evidenceHash ?? null, plan: prepared.plan ?? null,
    policy: { meaning: policy.meaning, role: policy.required_role,
      assurance: policy.required_assurance, captureBaseline: !!Number(policy.capture_baseline),
      blockOnDrift: !!Number(policy.block_on_drift) }
  }));
}

export function generateNonce() {
  return crypto.randomBytes(32).toString('hex');
}

export function createChallengePayload(params) {
  if (!params.tenantId || !params.issueId || !params.signerAccountId || !params.decision || !params.candidateHash) {
    throw new FailClosed('NOT_CONFIGURED');
  }

  return {
    tenant_id: params.tenantId,
    issue_id: params.issueId,
    signer_account_id: params.signerAccountId,
    decision: params.decision,
    meaning: params.meaning || 'Approval required',
    baseline_id: params.baselineId,
    candidate_hash: params.candidateHash,
    transition_id: params.transitionId || null,
    operation_plan_hash: params.operationPlanHash || null,
    nonce: generateNonce(),
    state: 'PENDING',
    created_at: params.now,
    expires_at: params.now + 5 * 60 * 1000 // 5 minutes
  };
}
