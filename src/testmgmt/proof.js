import { chainDigest, chainPosition } from './chain.js';
import { contentDigest, runContent, runSteps } from './content.js';
import { runResult } from './results.js';

/** A terminal label is never sufficient proof of the signatures behind it. */
export function terminalProofProblem(run, signatures, closures = []) {
  const usable = s => s.state === 'ACTIVE' && Number.isSafeInteger(s.auditSeq) && s.auditSeq > 0
    && /^[0-9a-f]{64}$/.test(s.auditHash ?? '') && s.contentHash === run.frozenDigest;
  if (!run.frozenDigest || !run.chain?.steps?.length || chainDigest(run.chain) !== run.chainDigest) return 'RUN_PROOF_INVALID';
  if (run.state === 'NOT_EXECUTED') {
    return closures.length === 1 && usable(closures[0]) && closures[0].decision === 'NOT_EXECUTED'
      && closures[0].step_index === 0 && String(closures[0].reason ?? '').trim() ? null : 'RUN_PROOF_INVALID';
  }
  if (signatures.some((s, i) => !usable(s) || s.role !== run.chain.steps[i]?.role)) return 'RUN_PROOF_INVALID';
  if (run.chain.distinctSigners && new Set(signatures.map(s => s.account_id)).size !== signatures.length) return 'RUN_PROOF_INVALID';
  const position = chainPosition(run.chain, signatures);
  if (run.state === 'SIGNED') return position.complete && signatures.every(s => s.decision === 'SIGN') ? null : 'RUN_PROOF_INVALID';
  if (run.state === 'REJECTED') return position.rejected ? null : 'RUN_PROOF_INVALID';
  return 'RUN_NOT_TERMINAL';
}

export async function verifyVersionProof(version, deps) {
  if (!version || version.state !== 'SIGNED' || contentDigest(version.content) !== version.digest
    || chainDigest(version.chain) !== version.chainDigest) return { ok: false, reason: 'VERSION_PROOF_INVALID' };
  const signatures = await deps.listSignatures('TEST_VERSION', version.versionId);
  const ok = chainPosition(version.chain, signatures).complete && signatures.every((s, i) => s.state === 'ACTIVE'
    && Number.isSafeInteger(s.auditSeq) && s.auditSeq > 0 && /^[0-9a-f]{64}$/.test(s.auditHash ?? '') && s.decision === 'SIGN'
    && s.contentHash === version.digest && s.role === version.chain.steps[i]?.role)
    && (!version.chain.distinctSigners || new Set(signatures.map(s => s.account_id)).size === signatures.length);
  return { ok: !!ok, reason: ok ? null : 'VERSION_PROOF_INVALID' };
}

export async function verifyRunProof(run, version, deps) {
  if (!(await verifyVersionProof(version, deps)).ok || run.testVersionId !== version.versionId || run.testDigest !== version.digest) return { ok: false, reason: 'VERSION_PROOF_INVALID' };
  const [signatures, closures] = await Promise.all([deps.listSignatures('RUN', run.runId), deps.listSignatures('RUN_NOT_EXECUTED', run.runId)]);
  const issue = terminalProofProblem(run, signatures, closures);
  if (issue) return { ok: false, reason: issue };
  const definition = run.resolvedSteps ?? version.content.steps;
  const steps = runSteps(definition, run.steps);
  const result = runResult([{ steps: steps.map(s => s.status) }]);
  if (contentDigest(runContent(run, steps, result)) !== run.frozenDigest) return { ok: false, reason: 'RUN_CONTENT_CHANGED' };
  return { ok: true };
}
