import { randomBytes } from 'node:crypto';
import { canonical, sha256Hex } from '../hash.js';
import { isAssuranceLevel } from './levels.js';
export const APPROVAL_STATE = Object.freeze({ PENDING: 'PENDING', CONSUMED: 'CONSUMED', VOID: 'VOID' });
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
export const DECISION = Object.freeze({ APPROVE: 'APPROVE', REJECT: 'REJECT' });
const hashPattern = /^[a-f0-9]{64}$/;
export function makeApproval(input) {
  const { proof, now, accountId, contentHash } = input;
  if (!proof?.ok || !isAssuranceLevel(proof.level) || !accountId || !hashPattern.test(contentHash)
      || !Object.values(DECISION).includes(input.decision) || !Number.isSafeInteger(now)) throw new TypeError('Invalid approval');
  const row = {
    approval_id: randomBytes(16), issue_id: input.issueId, issue_key: input.issueKey,
    project_id: input.projectId, issue_type_id: input.issueTypeId,
    baseline_id: input.baselineId ?? null, baseline_version: input.baselineVersion ?? null,
    decision: input.decision, state: APPROVAL_STATE.VOID,
    actor_account_id: accountId, account_id: accountId, actor_name: input.actorName, printed_name: input.actorName,
    decided_at: now, signed_at: now, created_at: now, expires_at: now + APPROVAL_TTL_MS, consumed_at: null,
    from_status_id: input.fromStatusId ?? null, to_status_id: input.toStatusId ?? null,
    transition_id: input.transitionId ?? null, signer_role: input.signerRole, meaning: input.meaning,
    content_hash: contentHash, covers_from_hash: input.coversFromHash ?? null, covers_to_hash: contentHash,
    drift_count: input.driftCount ?? 0, report_hash: input.reportHash ?? null, note: input.note ?? null,
    assurance_level: proof.level, provider_id: proof.providerId, provider_ref: proof.providerRef ?? null,
    provider_evidence: canonical(proof.evidence)
  };
  row.evidence_hash = evidenceHash(row);
  if (!validEvidence(row)) throw new TypeError('Approval proof does not match record');
  return row;
}
/** Immutable identity/content/policy binding; lifecycle state is deliberately excluded. */
export function evidenceHash(row) {
  const keys = ['issue_id','project_id','issue_type_id','actor_account_id','account_id','decision',
    'from_status_id','to_status_id','transition_id','signer_role','meaning','content_hash','covers_to_hash',
    'assurance_level','provider_id','provider_ref','provider_evidence','signed_at'];
  return sha256Hex(canonical(Object.fromEntries(keys.map(key => [key, row[key] == null ? null : String(row[key])]))));
}
export function validEvidence(row) {
  try {
    const proof = JSON.parse(row.provider_evidence);
    const b = proof.binding;
    return isAssuranceLevel(row.assurance_level) && hashPattern.test(row.content_hash)
      && row.actor_account_id === row.account_id && row.evidence_hash === evidenceHash(row)
      && b.accountId === row.account_id && String(b.issueId) === String(row.issue_id)
      && (b.fromStatusId ?? null) === row.from_status_id && (b.toStatusId ?? null) === row.to_status_id
      && b.contentHash === row.content_hash && b.decision === row.decision;
  } catch { return false; }
}
