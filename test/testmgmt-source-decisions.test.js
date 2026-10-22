import test from 'node:test';
import assert from 'node:assert/strict';
import { contentDigest } from '../src/testmgmt/content.js';
import { chainDigest } from '../src/testmgmt/chain.js';
const module = await import('../src/testmgmt/sourceDecisions.js').catch(() => ({}));
const coverageModule = await import('../src/usecases/testCoverage.js');
const actor = { accountId: 'reviewer' }, H = 'a'.repeat(64), NEW = 'b'.repeat(64);
const oldSource = { issueId: '21', issueKey: 'VAT-21', projectId: '100', siteId: 'site', sourceDigest: H,
  baseline: { id: '1'.repeat(32), version: 1, hash: H }, governedReady: true, drifted: false };
function setup() {
  const current = { ...structuredClone(oldSource), sourceDigest: NEW, baseline: { id: '2'.repeat(32), version: 2, hash: NEW } };
  const chain = { steps: [{ role: 'QA', label: 'Review source applicability', meaning: 'I approve this exact source decision.' }], distinctSigners: true };
  const version = { versionId: '3'.repeat(32), testIssueId: '11', projectId: '100', state: 'SIGNED', signedAt: 1,
    content: { objective: 'Read', preconditions: '', steps: [{ id: 's1', action: 'Read', data: '', expected: '10' }], verifies: [oldSource] } };
  version.digest = contentDigest(version.content);
  const run = { runId: '4'.repeat(32), executionIssueId: '12', projectId: '100', testIssueId: '11', testVersionId: version.versionId,
    testDigest: version.digest, frozenDigest: H, state: 'SIGNED', result: 'PASSED', steps: [], configuration: 'ECU', environment: 'bench', release: { id: '7', name: '1.0' }, createdAt: 1, updatedAt: 2 };
  const state = { current, chain, version, run, records: new Map(), signatures: [], eligible: true, proof: true, evidence: true, signaturePending: false, code: null, listComplete: true };
  const deps = {
    now: () => 100, readIssueAsUser: async value => ({ id: String(value).replace('VAT-', ''), key: `VAT-${String(value).replace('VAT-', '')}`,
      fields: { project: { id: '100' }, issuetype: { id: String(value).includes('12') ? '2' : '1' } } }),
    readProject: async () => ({ enabled: true, projectId: '100', testTypeId: '1', executionTypeId: '2', versionChain: chain }),
    hasIssuePermission: async () => true, latestSignedVersion: async () => version, readVersion: async () => version, readDraft: async () => null,
    resolveTestSources: async () => [structuredClone(current)], verifyVersionProof: async () => ({ ok: state.proof }),
    readRun: async () => run, verifyRunProof: async () => ({ ok: state.proof }), verifyEvidence: async () => ({ ok: state.evidence }),
    isEligibleFor: async () => state.eligible, myself: async () => ({ displayName: 'Reviewer' }),
    roleHolders: async () => ({ QA: ['reviewer'] }),
    insertSourceDecision: async record => { if (state.records.has(record.decisionId)) return false; state.records.set(record.decisionId, structuredClone(record)); return true; },
    readSourceDecision: async id => structuredClone(state.records.get(id) ?? null),
    setSourceDecisionState: async ({ decisionId, from, to, now }) => { const record = state.records.get(decisionId); if (record.state !== from) return false; record.state = to; record.signedAt = now; return true; },
    readSourceDecisionsForTestComplete: async () => ({ records: [...state.records.values()].map(record => structuredClone(record)), complete: state.listComplete }),
    listSignatures: async (kind, id) => state.signatures.filter(signature => signature.subject_kind === kind && signature.subjectId === id),
    hasPendingSignatures: async (kind, id) => state.signatures.some(s => s.subject_kind === kind && s.subjectId === id && s.state === 'PENDING'),
    recordSignature: async args => {
      state.code = args.code;
      if (args.code !== '123456') return { ok: false, reason: 'CODE_INVALID_OR_REPLAYED' };
      state.signatures.push({ subject_kind: args.kind, subjectId: args.subjectId, step_index: args.stepIndex,
        account_id: args.signer.accountId, role: args.step.role, label: args.step.label, meaning: args.step.meaning,
        contentHash: args.contentHash, decision: args.decision, state: state.signaturePending ? 'PENDING' : 'ACTIVE', auditSeq: 1, auditHash: H, signedAt: 100 });
      return { ok: true };
    },
    readRunsForTestComplete: async () => ({ records: [run], complete: true }),
    readBlockingDefects: async () => ({ ok: true, blocking: false }), validateRunPlanningSnapshot: async () => ({ ok: true }),
    verifySourceLinkProjection: async () => ({ ok: true })
  };
  function uc() { assert.equal(typeof module.createSourceDecisions, 'function', 'createSourceDecisions must exist'); return module.createSourceDecisions(deps); }
  const request = { issueKey: 'VAT-11', sourceIssueId: '21', kind: 'SUSPECT_REVIEW', decision: 'FITS', rationale: 'The pressure criterion and stimulus are unchanged.' };
  return { state, deps, uc, request };
}
async function signReview(fixture) {
  const prepared = await fixture.uc().prepare(fixture.request, actor);
  return fixture.uc().sign({ decisionId: prepared.decisionId, contentHash: prepared.digest, code: '123456' }, actor);
}

test('signed Suspect review pins both approved baselines and clears only the definition', async () => {
  const f = setup(); const review = await signReview(f);
  assert.equal(review.state, 'SIGNED'); assert.equal(review.content.oldBaseline.id, '1'.repeat(32)); assert.equal(review.content.newBaseline.id, '2'.repeat(32));
  assert.equal(review.content.testVersionId, f.state.version.versionId); assert.equal(review.content.testDigest, f.state.version.digest);
  const model = await coverageModule.createTestCoverage(f.deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].suspect, false); assert.equal(model.rows[0].governed, 'UNKNOWN');
  assert.ok(model.rows[0].reasons.includes('NEW_RUN_OR_APPLICABILITY_REQUIRED'));
});

test('separate signed applicability pins exact frozen run and permits governed reuse after FITS review', async () => {
  const f = setup(); await signReview(f);
  const prepared = await f.uc().prepare({ ...f.request, kind: 'APPLICABILITY', decision: 'APPLIES', runId: f.state.run.runId,
    rationale: 'The retained trace still demonstrates the unchanged acceptance threshold.' }, actor);
  assert.equal(prepared.content.run.runId, f.state.run.runId); assert.equal(prepared.content.run.frozenDigest, H);
  await f.uc().sign({ decisionId: prepared.decisionId, contentHash: prepared.digest, code: '123456' }, actor);
  const model = await coverageModule.createTestCoverage(f.deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].governed, 'VERIFIED'); assert.equal(model.rows[0].applicabilityDecisionId, prepared.decisionId);
});

for (const invalid of ['unapproved drift', 'not eligible', 'wrong code', 'stale baseline', 'incomplete signature', 'must change']) test(`Suspect decision cannot clear with ${invalid}`, async () => {
  const f = setup();
  if (invalid === 'unapproved drift') { f.state.current.drifted = true; f.state.current.governedReady = false; await assert.rejects(() => f.uc().prepare(f.request, actor), { reason: 'SOURCE_DRIFT' }); return; }
  if (invalid === 'must change') f.request.decision = 'MUST_CHANGE';
  const prepared = await f.uc().prepare(f.request, actor);
  if (invalid === 'not eligible') f.state.eligible = false;
  if (invalid === 'stale baseline') f.state.current.baseline.id = '5'.repeat(32);
  if (invalid === 'incomplete signature') f.state.signaturePending = true;
  if (['not eligible', 'stale baseline'].includes(invalid)) await assert.rejects(() => f.uc().sign({ decisionId: prepared.decisionId, contentHash: prepared.digest, code: '123456' }, actor));
  else if (invalid === 'wrong code') assert.equal((await f.uc().sign({ decisionId: prepared.decisionId, contentHash: prepared.digest, code: 'wrong' }, actor)).reason, 'CODE_INVALID_OR_REPLAYED');
  else { await f.uc().sign({ decisionId: prepared.decisionId, contentHash: prepared.digest, code: '123456' }, actor); }
  const model = await coverageModule.createTestCoverage(f.deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].suspect, true); assert.equal(model.rows[0].governed, 'UNKNOWN');
});

test('applicability is refused until the definition FITS review is fully signed', async () => {
  const f = setup(); await assert.rejects(() => f.uc().prepare({ ...f.request, kind: 'APPLICABILITY', decision: 'APPLIES', runId: f.state.run.runId }, actor), { reason: 'SIGNED_REVIEW_REQUIRED' });
});

test('an applicability decision for another run cannot rescue the latest terminal attempt', async () => {
  const f = setup(); await signReview(f);
  const p = await f.uc().prepare({ ...f.request, kind: 'APPLICABILITY', decision: 'APPLIES', runId: f.state.run.runId }, actor);
  await f.uc().sign({ decisionId: p.decisionId, contentHash: p.digest, code: '123456' }, actor);
  f.state.run.runId = '6'.repeat(32);
  const model = await coverageModule.createTestCoverage(f.deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].governed, 'UNKNOWN'); assert.equal(model.rows[0].applicabilityDecisionId, null);
});

test('truncated decision history never clears Suspect', async () => {
  const f = setup(); await signReview(f); f.state.listComplete = false;
  const model = await coverageModule.createTestCoverage(f.deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.complete, false); assert.equal(model.rows[0].suspect, true);
});

test('a new signed run against the reviewed current baseline needs no old-run applicability', async () => {
  const f = setup(); await signReview(f);
  f.state.run.planningSnapshot = { sourceReferences: [structuredClone(f.state.current)] };
  const model = await coverageModule.createTestCoverage(f.deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].governed, 'VERIFIED'); assert.equal(model.rows[0].applicabilityDecisionId, null);
});

const coverageRules = await import('../src/testmgmt/coverage.js');
test('an interrupted source decision blocks countersigning and recovers its existing audit proof', async () => {
  const f = setup(); f.state.signaturePending = true;
  const prepared = await f.uc().prepare(f.request, actor);
  const waiting = await f.uc().sign({ decisionId: prepared.decisionId, contentHash: prepared.digest, code: '123456' }, actor);
  assert.equal(waiting.canSign, false); assert.equal(waiting.canFinish, true);
  f.deps.recoverSignatures = async () => { f.state.signatures[0].state = 'ACTIVE'; };
  const finished = await f.uc().finish({ decisionId: prepared.decisionId }, actor);
  assert.equal(finished.state, 'SIGNED'); assert.equal(f.state.signatures.length, 1);
});
test('passing retest must descend from the failed run for that exact execution context', async () => {
  assert.equal(typeof coverageRules.passingRetestProblem, 'function', 'passingRetestProblem must exist');
  const f = setup();
  const failed = { ...f.state.run, runId: '8'.repeat(32), state: 'SIGNED', result: 'FAILED', createdAt: 0 };
  const input = { run: f.state.run, priorFailures: [failed] };
  const deps = { readRun: async () => failed, verifyAncestorProof: async () => true };
  assert.equal(await coverageRules.passingRetestProblem(input, deps), 'PASSING_RETEST_REQUIRED');
  f.state.run.retestOf = failed.runId;
  assert.equal(await coverageRules.passingRetestProblem(input, deps), null);
  failed.environment = 'vehicle';
  assert.equal(await coverageRules.passingRetestProblem(input, deps), 'RETEST_PROVENANCE_UNAVAILABLE');
});
