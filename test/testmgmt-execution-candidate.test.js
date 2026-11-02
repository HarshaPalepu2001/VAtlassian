import test from 'node:test';
import assert from 'node:assert/strict';

test('an execution binds one audited sender-attested candidate and rejects another identity', async () => {
  const { createExecutionCandidates } = await import('../src/testmgmt/executionCandidate.js');
  let record = null;
  const deps = { now: () => 1, audit: async () => ({ seq: 1, entryHash: 'a'.repeat(64) }),
    insertExecutionCandidate: async value => { record ??= structuredClone(value); return true; },
    readExecutionCandidate: async () => structuredClone(record),
    confirmExecutionCandidate: async ({ proof }) => { record.auditProof = proof; return true; } };
  const api = createExecutionCandidates(deps), first = { executionIssueId: '12', projectId: '100', reportedBuild: { id: 'build-A' }, actorAccountId: 'human' };
  const candidate = await api.claimExecutionCandidate(first);
  assert.deepEqual(candidate.reportedBuild, first.reportedBuild);
  assert.deepEqual(await api.claimExecutionCandidate(first), candidate);
  await assert.rejects(api.claimExecutionCandidate({ ...first, reportedBuild: { id: 'build-B' } }), { reason: 'EXECUTION_CANDIDATE_MISMATCH' });
});

test('a candidate whose creation audit failed stays unavailable until the same binding recovers', async () => {
  const { createExecutionCandidates } = await import('../src/testmgmt/executionCandidate.js');
  let record;
  const deps = { now: () => 1, audit: async () => { throw new Error('offline'); },
    insertExecutionCandidate: async r => { record ??= structuredClone(r); }, readExecutionCandidate: async () => structuredClone(record),
    confirmExecutionCandidate: async ({ proof }) => { record.auditProof = proof; return true; } };
  const api = createExecutionCandidates(deps), input = { executionIssueId: '12', projectId: '100', reportedBuild: { id: 'A' }, actorAccountId: 'human' };
  await assert.rejects(api.claimExecutionCandidate(input), /offline/);
  assert.equal(record.auditProof, null);
  deps.audit = async () => ({ seq: 1, entryHash: 'a'.repeat(64) });
  assert.ok((await api.claimExecutionCandidate(input)).auditProof);
});

test('concurrent first candidates cannot both bind one execution', async () => {
  const { createExecutionCandidates } = await import('../src/testmgmt/executionCandidate.js');
  let record;
  const deps = { now: () => 1, audit: async () => ({seq:1,entryHash:'a'.repeat(64)}),
    insertExecutionCandidate: async r => { record ??= structuredClone(r); }, readExecutionCandidate: async () => structuredClone(record),
    confirmExecutionCandidate: async ({proof}) => { record.auditProof=proof;return true; } };
  const api = createExecutionCandidates(deps), base={executionIssueId:'12',projectId:'100',actorAccountId:'human'};
  const results=await Promise.allSettled(['A','B'].map(id=>api.claimExecutionCandidate({...base,reportedBuild:{id}})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.reason,'EXECUTION_CANDIDATE_MISMATCH');
});
