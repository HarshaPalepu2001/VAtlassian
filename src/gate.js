import { DENY, FailClosed } from './lib/errors.js';
import { meetsAssurance, isAssuranceLevel, effectiveAssurance } from './lib/approval/levels.js';
import { validEvidence } from './lib/approval/record.js';
import { normalizeCode } from './lib/totp.js';

export function submittedApprovalToken(fields) {
  if (!fields || typeof fields !== 'object') return null;
  return Object.values(fields).find(value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)) ?? null;
}
export function rawCodeSubmitted(fields) {
  return fields && typeof fields === 'object'
    ? Object.values(fields).some(value => typeof value === 'string' && /^\d{6}$/.test(normalizeCode(value))) : false;
}

/** Stateless lambda validator. Identity was established by the resolver, never this payload. */
export function createGate(deps) {
  return async function validate(payload) {
    const startedAt = deps.now();
    const issueKey = payload?.issue?.key;
    const fromStatusId = payload?.transition?.from?.id == null ? null : String(payload.transition.from.id);
    const toStatusId = payload?.transition?.to?.id == null ? null : String(payload.transition.to.id);
    // The exact Jira transition, not just the status pair it moves between.
    // Two sibling transitions can share a destination status, and this is what
    // stops a receipt signed for one from completing the other.
    const transitionId = payload?.transition?.id == null ? null : String(payload.transition.id);
    const token = submittedApprovalToken(payload?.transition?.modifiedFields);
    const rawCode = rawCodeSubmitted(payload?.transition?.modifiedFields);
    const facts = { issueKey, fromStatusId, toStatusId, transitionId, hasToken: token != null, hasRawCode: rawCode };
    deps.log({ event: 'gate:enter', ...facts });
    const deny = async (reason, detail, extra = {}) => {
      const elapsedMs = deps.now() - startedAt;
      deps.log({ event: 'gate:deny', ...facts, reason, detail, elapsedMs });
      try { await deps.audit({ eventType: 'TRANSITION_BLOCKED', actorAccountId: 'system', payload: { ...facts, reason, detail: detail ?? null, elapsedMs } }, { deadlineMs: 1200 }); } catch { /* refusal remains closed even if evidence storage is down */ }
      const assurance = extra.required ? ` Obtained: ${extra.obtained ?? 'none'}. Required: ${extra.required}.` : '';
      return { result: false, errorMessage: (DENY[reason] ?? DENY.SERVICE_UNAVAILABLE) + assurance };
    };
    if (!issueKey || !fromStatusId || !toStatusId || !transitionId) return deny('SERVICE_UNAVAILABLE', 'MALFORMED_PAYLOAD');
    if (rawCode) return deny('RAW_CODE_ON_SCREEN', 'RAW_TOTP_CODE_IN_MODIFIED_FIELDS');
    try {
      const snapshot = await deps.load({ issueKey, fromStatusId, toStatusId, transitionId, modifiedFields: payload?.transition?.modifiedFields });
      const { ct, item, issueId, projectId, issueTypeId, contentHash, driftCount } = snapshot;
      if (!ct || !isAssuranceLevel(ct.required_assurance) || !ct.required_role || !ct.meaning
          || ![true, false, 0, 1, '0', '1'].includes(ct.block_on_drift)) return deny('NOT_CONFIGURED', 'INVALID_EDGE_POLICY');
      if (['RESTORING', 'DECIDING', 'ERROR'].includes(item?.state) || item?.lock_token) return deny('RESTORE_IN_PROGRESS', 'ITEM_BUSY');
      if (item?.state === 'LOCKED') return deny('RECORD_LOCKED', 'ITEM_LOCKED');
      if (!Number.isSafeInteger(driftCount) || driftCount > 0) return deny('UNDECIDED_DRIFT', 'DRIFT_OUTSTANDING');
      const approval = await deps.pending({ issueId, fromStatusId, toStatusId, transitionId, now: deps.now(), approvalId: token });
      if (!approval || approval.state !== 'PENDING' || approval.decision !== 'APPROVE') return deny('NO_DECISION', 'NO_CANDIDATE_ROW');
      if (token && approval.approval_id.toString('hex') !== token) return deny('NO_DECISION', 'TRANSITION_SCREEN_TOKEN_MISMATCH');
      if (Number(approval.expires_at) <= deps.now()) return deny('DECISION_EXPIRED', 'EXPIRED');
      if (String(approval.issue_id) !== String(issueId) || String(approval.project_id) !== String(projectId)
          || String(approval.issue_type_id) !== String(issueTypeId) || approval.from_status_id !== fromStatusId
          || approval.to_status_id !== toStatusId || String(approval.transition_id) !== transitionId) return deny('NO_DECISION', 'EDGE_BINDING_MISMATCH');
      const required = effectiveAssurance(ct.required_assurance);
      if (!meetsAssurance(approval.assurance_level, required)) return deny('INSUFFICIENT_ASSURANCE', 'ASSURANCE_FLOOR', { obtained: approval.assurance_level, required });
      if (!validEvidence(approval) || approval.content_hash !== contentHash) return deny('CONTENT_CHANGED', 'CONTENT_OR_EVIDENCE_CHANGED');
      if (approval.signer_role !== ct.required_role || approval.meaning !== ct.meaning) return deny('NOT_CONFIGURED', 'POLICY_CHANGED');
      if (!await deps.eligible({ accountId: approval.account_id, issueTypeId, projectId, role: ct.required_role })) return deny('ELIGIBILITY_REVOKED', 'ELIGIBILITY_REVOKED');
      const result = await deps.consume({ approvalId: approval.approval_id, now: deps.now() });
      if (!result?.consumed) return deny('NO_DECISION', 'CAS_LOST_RACE');
      // Consumed before the success audit; an audit failure spends the approval but never allows Jira.
      await deps.audit({ eventType: 'APPROVAL_CONSUMED', actorAccountId: approval.account_id, issueId,
        approvalId: approval.approval_id, payload: { fromStatusId, toStatusId, assuranceLevel: approval.assurance_level } });
      await deps.voidOthers({ issueId, exceptApprovalId: approval.approval_id, now: deps.now() });
      deps.log({ event: 'gate:allow', ...facts, elapsedMs: deps.now() - startedAt });
      return { result: true };
    } catch (error) {
      return deny(error instanceof FailClosed ? error.reason : 'SERVICE_UNAVAILABLE', 'FAIL_CLOSED');
    }
  };
}

export async function validate(payload) {
  // Entry is logged before lazy imports, so cold-start/import failures are visible too.
  console.log('gate:invoked', JSON.stringify({ issueKey: payload?.issue?.key ?? null }));
  try {
    const { gateRuntime } = await import('./lib/approval/runtime.js');
    return await createGate(await gateRuntime())(payload);
  } catch {
    console.log('gate:deny', JSON.stringify({ reason: 'SERVICE_UNAVAILABLE', detail: 'INITIALIZATION_FAILED' }));
    return { result: false, errorMessage: DENY.SERVICE_UNAVAILABLE };
  }
}
