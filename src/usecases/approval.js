import { providerFor } from '../lib/approval/registry.js';
import { meetsAssurance, isAssuranceLevel, effectiveAssurance } from '../lib/approval/levels.js';
import { makeApproval, validEvidence } from '../lib/approval/record.js';
import { FailClosed, DENY } from '../lib/errors.js';

const fail = reason => { throw new FailClosed(reason); };
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

export function createApprovalUsecases(deps) {
  async function submit({ payload = {}, context }) {
    try {
      const accountId = actorId(context);
      if (!['APPROVE', 'REJECT'].includes(payload.decision)) fail('NOT_CONFIGURED');
      if (payload.note != null && (typeof payload.note !== 'string' || payload.note.length > 1024)) fail('NOT_CONFIGURED');
      const issue = await deps.issue({ payload, context });
      const actor = await deps.actor(accountId);
      const hasTransition = payload.decision === 'APPROVE' && (payload.transitionId != null || payload.toStatusId != null);
      const transition = hasTransition ? await deps.transition(issue, payload) : null;
      if (hasTransition && !transition) fail('NOT_CONFIGURED');
      const prepared = await deps.prepare({ issue, actor, decision: payload.decision, expectedEvidenceHash: payload.expectedEvidenceHash, forTransition: hasTransition });
      if (payload.expectedEvidenceHash != null && payload.expectedEvidenceHash !== prepared.evidenceHash) fail('CONTENT_CHANGED');
      const ct = await deps.edge(issue, transition, prepared);
      checkPolicy(ct);
      if (!await deps.eligible({ accountId, projectId: issue.projectId, issueTypeId: issue.issueTypeId, role: ct.required_role })) fail('NOT_ELIGIBLE');
      if (['RESTORING','DECIDING','LOCKED','ERROR'].includes(prepared.review?.state)) fail('RESTORE_IN_PROGRESS');
      if (hasTransition && yes(ct.block_on_drift) && prepared.driftCount > 0) fail('UNDECIDED_DRIFT');
      const binding = { accountId, issueId: issue.issueId, fromStatusId: issue.statusId,
        toStatusId: transition?.toStatusId ?? issue.statusId, contentHash: prepared.contentHash, decision: payload.decision };
      // The floor applies to APPROVE and REJECT alike. A supplied code requests
      // stronger authentication and never silently downgrades to native.
      const required = effectiveAssurance(ct.required_assurance);
      const level = payload.code != null ? 'ESIGNATURE' : required;
      const proof = await providerFor(level).verify({ binding, confirmed: payload.confirmed, code: payload.code, totpDeps: deps.totpDeps });
      if (!proof.ok) {
        await deps.audit({ eventType: 'APPROVAL_REFUSED', actorAccountId: accountId, issueId: issue.issueId,
          payload: { reason: proof.reason, requiredAssurance: required } });
        return { success: false, reason: proof.reason, error: proof.error ?? DENY[proof.reason] ?? DENY.SERVICE_UNAVAILABLE };
      }
      if (!meetsAssurance(proof.level, required)) fail('INSUFFICIENT_ASSURANCE');
      const row = makeApproval({ ...binding, issueKey: issue.issueKey, projectId: issue.projectId, issueTypeId: issue.issueTypeId,
        actorName: actor.displayName, signerRole: ct.required_role, meaning: ct.meaning, transitionId: transition?.id,
        proof, now: deps.now(), baselineId: prepared.baseline?.baseline_id, baselineVersion: prepared.baselineVersion,
        coversFromHash: prepared.baseline?.content_hash, driftCount: prepared.driftCount, reportHash: prepared.reportHash, note: payload.note });
      await deps.record(row);
      await deps.audit({ eventType: 'APPROVAL_RECORDED', actorAccountId: accountId, issueId: issue.issueId, approvalId: row.approval_id,
        payload: { decision: row.decision, meaning: row.meaning, printedName: row.printed_name, assuranceLevel: row.assurance_level,
          providerId: row.provider_id, evidenceHash: row.evidence_hash, contentHash: row.content_hash, fromStatusId: row.from_status_id, toStatusId: row.to_status_id } });
      let applied;
      if (true) {
        applied = await deps.apply({ issue, actor, approval: row, prepared, context });
        if (applied?.success !== true) fail('SERVICE_UNAVAILABLE');
      }
      const result = { success: true, approvalId: row.approval_id.toString('hex'), assuranceLevel: row.assurance_level,
        printedName: row.printed_name, meaning: row.meaning, transitioned: false };
      if (hasTransition && payload.preauthorize !== true) Object.assign(result, await deps.performTransition(issue, transition, row));
      const state = hasTransition ? (result.transitioned ? 'CONSUMED' : 'PENDING') : 'CONSUMED';
      if (!await deps.activate({ approvalId: row.approval_id, now: deps.now(), state })) fail('SERVICE_UNAVAILABLE');
      result.state = state;
      if (applied?.restore) result.restore = applied.restore;
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
          || row.from_status_id !== issue.statusId || !validEvidence(row)) fail('NO_DECISION');
      const transition = await deps.transition(issue, { transitionId: payload.transitionId ?? row.transition_id });
      if (!transition || transition.toStatusId !== row.to_status_id || transition.id !== row.transition_id) fail('NO_DECISION');
      const ct = await deps.edge(issue, transition);
      checkPolicy(ct);
      if (!meetsAssurance(row.assurance_level, effectiveAssurance(ct.required_assurance))) fail('INSUFFICIENT_ASSURANCE');
      if (!await deps.eligible({ accountId, projectId: issue.projectId, issueTypeId: issue.issueTypeId, role: ct.required_role })) fail('NOT_ELIGIBLE');
      const prepared = await deps.prepare({ issue, actor: await deps.actor(accountId), decision: 'APPROVE', forTransition: true });
      if (prepared.contentHash !== row.content_hash) fail('CONTENT_CHANGED');
      return { success: true, approvalId: payload.approvalId, ...await deps.performTransition(issue, transition, row) };
    } catch (error) { return failure(error); }
  }
  return { submit, retryTransition };
}

export async function submit(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).submit(args); }
export async function retryTransition(args) { return createApprovalUsecases(await (await import('../lib/approval/runtime.js')).approvalRuntime()).retryTransition(args); }
