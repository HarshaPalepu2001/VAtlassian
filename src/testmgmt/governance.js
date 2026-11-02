import { contentDigest } from './content.js';
import { chainDigest, chainPosition, validateChain } from './chain.js';

export const GOVERNANCE_KINDS = Object.freeze(['ASSIGNMENT', 'TARGET', 'EXCEPTION']);
export const HISTORICAL_METADATA = Object.freeze(['reportedBuild', 'classification', 'provenance']);
export const governanceFail = reason => { throw Object.assign(new Error(reason), { reason }); };
export const validAuditProof = proof => Number.isSafeInteger(proof?.seq) && proof.seq > 0 && /^[a-f0-9]{64}$/.test(proof?.entryHash ?? '');
export const sameGovernanceValue = (left, right) => contentDigest(left ?? null) === contentDigest(right ?? null);

/** Roles, order, counts, and separation must be demonstrably at least as strong. */
export function governanceChainDominates(candidate, required) {
  if (!candidate?.steps?.length || !required?.steps?.length || required.distinctSigners && !candidate.distinctSigners) return false;
  let at = 0;
  for (const step of candidate.steps) if (step.role === required.steps[at]?.role) at++;
  return at === required.steps.length;
}

export function governancePolicyProblem(project) {
  const chains = ['assignmentChain', 'targetChain', 'exceptionChain'].map(key => validateChain(project?.[key]).chain);
  if (chains.some(chain => !chain)) return 'INVALID_CHAIN';
  return chains.slice(0, 2).every(chain => governanceChainDominates(chains[2], chain)) ? null : 'EXCEPTION_CHAIN_TOO_WEAK';
}

/** Rebuild every approval proof, including signer separation and the exact frozen meaning. */
export function governanceRecordProof(record, signatures, { requireActivation = true } = {}) {
  if (!record?.content || !GOVERNANCE_KINDS.includes(record.kind) || record.content.kind !== record.kind ||
      contentDigest(record.content) !== record.digest || !record.chain?.steps?.length || chainDigest(record.chain) !== record.chainDigest ||
      record.content.chainDigest !== record.chainDigest || !Array.isArray(signatures) || !chainPosition(record.chain, signatures).complete ||
      signatures.length !== record.chain.steps.length) return false;
  const ordered = [...signatures].sort((a,b)=>Number(a.step_index)-Number(b.step_index));
  if (record.chain.distinctSigners && new Set(ordered.map(s=>s.account_id)).size !== ordered.length) return false;
  if (record.content.authorSeparation && ordered.some(s=>s.account_id===record.createdBy)) return false;
  if (!ordered.every((s,index)=>Number(s.step_index)===index && s.state==='ACTIVE' && s.decision==='SIGN' && s.role===record.chain.steps[index].role &&
    s.meaning===record.chain.steps[index].meaning && s.contentHash===record.digest && validAuditProof({seq:s.auditSeq,entryHash:s.auditHash}))) return false;
  return !requireActivation || record.state === 'SIGNED' && validAuditProof(record.activationProof);
}

/** Exact test version and context, deliberately excluding the as-yet absent build. */
export function mandatoryRunScope(run, test, context) {
  return run.testVersionId === test.testVersionId && String(run.testIssueId) === String(test.testIssueId) &&
    (run.configuration ?? '') === (context.configuration ?? '') && (run.environment ?? '') === (context.environment ?? '') &&
    String(run.release?.id ?? '') === String(context.release?.id ?? '');
}
export const missingHistoricalMetadata = (run, name) => run.evidenceSchema !== 2 && (run[name] == null || name === 'reportedBuild' && Object.keys(run[name]).length === 0);
