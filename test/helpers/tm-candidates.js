import { createExecutionCandidates } from '../../src/testmgmt/executionCandidate.js';
export function candidateWorld(deps) {
  const candidates = new Map();
  const store = {
    insertExecutionCandidate: async record => { if (!candidates.has(record.executionIssueId)) candidates.set(record.executionIssueId, structuredClone(record)); },
    readExecutionCandidate: async id => structuredClone(candidates.get(String(id)) ?? null),
    confirmExecutionCandidate: async ({ executionIssueId, proof }) => { const r = candidates.get(executionIssueId); if (!r) return false; r.auditProof = structuredClone(proof); return true; }
  };
  return { ...store, ...createExecutionCandidates({ ...deps, ...store }) };
}
