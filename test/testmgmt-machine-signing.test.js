import test from 'node:test';
import assert from 'node:assert/strict';
import { tmWorld } from './helpers/tm-world.js';
import { createTestAuthoring } from '../src/usecases/testAuthoring.js';
import { createTestExecution } from '../src/usecases/testExecution.js';
import { runContent, contentDigest } from '../src/testmgmt/content.js';

const actor = (w, accountId) => { w.viewer = accountId; return { accountId }; };
async function fixture() {
  const w = tmWorld();
  const parent = { id: '10', key: 'VAT-10' };
  w.addIssue('11', 'VAT-11', '1', { parent });
  w.addIssue('12', 'VAT-12', '2', { parent });
  w.grants.push({ accountId: 'approver', role: 'APPROVER' }, { accountId: 'reviewer', role: 'TESTER' }, { accountId: 'qa', role: 'QA' });
  const authoring = createTestAuthoring(w.deps), exec = createTestExecution(w.deps);
  let v = await authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0, draft: { steps: [{ id: 's1', action: 'Act', expected: 'Expected' }] } }, actor(w, 'author'));
  v = await authoring.publish({ issueKey: 'VAT-11', expectedRevision: v.draft.revision }, actor(w, 'author'));
  await authoring.signVersion({ versionId: v.versions[0].versionId, contentHash: v.versions[0].digest, code: '123456' }, actor(w, 'approver'));
  const added = await exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(w, 'reviewer'));
  const run = w.runs.get(added.runs[0].runId);
  Object.assign(run, { evidenceSchema: 2, attemptSequence: 1, classification: { level: 'SYSTEM', method: 'TEST' }, reportedBuild: { id: 'candidate-1' }, provenance: { kind: 'MACHINE', tokenId: 'token1' }, intakeReceiptId: 'receipt1' });
  run.steps = run.steps.map(s => ({ ...s, status: 'PASSED', recordedBy: 'machine:token1' }));
  run.result = 'PASSED';
  w.deps.assertIntakeReady = async () => true;
  return { w, exec, run };
}

test('a human reviews machine results without becoming their executor', async () => {
  const { w, exec, run } = await fixture();
  const before = await exec.view('VAT-12', actor(w, 'reviewer'));
  await exec.signRun({ runId: run.runId, code: '123456', contentHash: before.runs[0].contentHash }, actor(w, 'reviewer'));
  const signature = w.signatures.find(s => s.subjectId === run.runId || s.subject_id === run.runId);
  assert.equal(signature.meaning, 'I reviewed these machine-recorded results and their evidence.');
  assert.equal(w.runs.get(run.runId).steps[0].recordedBy, 'machine:token1');
});

test('unresolved intake blocks signing and human correction before any signature or write', async () => {
  const { w, exec, run } = await fixture();
  w.deps.assertIntakeReady = async () => { throw Object.assign(new Error('pending'), { reason: 'INTAKE_PENDING' }); };
  const before = await exec.view('VAT-12', actor(w, 'reviewer'));
  assert.equal(before.runs[0].canSign, false);
  await assert.rejects(exec.signRun({ runId: run.runId, code: '123456', contentHash: before.runs[0].contentHash }, actor(w, 'reviewer')), { reason: 'INTAKE_PENDING' });
  await assert.rejects(exec.recordStep({ runId: run.runId, expectedRevision: run.revision, stepId: 's1', status: 'FAILED', reason: 'Correction' }, actor(w, 'reviewer')), { reason: 'INTAKE_PENDING' });
  assert.equal(w.runs.get(run.runId).steps[0].status, 'PASSED');
  assert.equal(w.signatures.some(s => s.subjectId === run.runId), false);
});

test('new signed content binds classification build identity sequence and provenance', () => {
  const run = { runId: 'r', executionIssueId: '12', testIssueId: '11', testVersionId: 'v', testDigest: 'd', chainDigest: 'c', evidenceSchema: 2,
    attemptSequence: 2, classification: { level: 'SYSTEM', method: 'TEST' }, reportedBuild: { id: 'a' }, provenance: { kind: 'MACHINE', tokenId: 't' }, intakeReceiptId: 'i' };
  const original = contentDigest(runContent(run, [], 'PASSED'));
  assert.equal(runContent(run, [], 'PASSED').schema, 2);
  for (const [field, value] of Object.entries({ attemptSequence: 3, classification: { level: 'UNIT', method: 'TEST' }, reportedBuild: { id: 'b' }, provenance: { kind: 'HUMAN' }, intakeReceiptId: 'j' })) {
    assert.notEqual(contentDigest(runContent({ ...run, [field]: value }, [], 'PASSED')), original, field);
  }
});

test('legacy content keeps its exact schema-1 shape when metadata is absent', () => {
  const run = { runId: 'r', executionIssueId: '12', testIssueId: '11', testVersionId: 'v', testDigest: 'd', chainDigest: 'c' };
  assert.deepEqual(runContent(run, [], 'PASSED'), { kind: 'TEST_RUN', schema: 1, runId: 'r', executionIssueId: '12', testIssueId: '11', testVersionId: 'v', testDigest: 'd', environment: '', configuration: '', release: null, chainDigest: 'c', retestOf: null, steps: [], result: 'PASSED' });
});

test('new human runs include declared metadata and server human provenance', async () => {
  const { w, exec } = await fixture();
  const v = await exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11', classification: { level: 'SYSTEM', method: 'TEST' }, reportedBuild: { id: 'candidate-2' }, provenance: { kind: 'MACHINE' } }, actor(w, 'reviewer'));
  const r = v.runs.find(r => r.provenance?.kind === 'HUMAN');
  assert.ok(r);
  assert.deepEqual(r.classification, { level: 'SYSTEM', method: 'TEST' });
  assert.deepEqual(r.reportedBuild, { id: 'candidate-2' });
  assert.equal(r.provenance.accountId, 'reviewer');
  assert.equal(r.evidenceSchema, 2);
});

test('machine proof rejects a missing review meaning and an unresolved receipt', async () => {
  const { verifyRunProof } = await import('../src/testmgmt/proof.js');
  const { w, exec, run } = await fixture();
  let view = await exec.view('VAT-12', actor(w, 'reviewer'));
  view = await exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, actor(w, 'reviewer'));
  await exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, actor(w, 'qa'));
  const version = await w.deps.readVersion(run.testVersionId);
  const signed = () => w.deps.readRun(run.runId);
  assert.equal((await verifyRunProof(await signed(), version, w.deps)).ok, true);
  w.deps.assertIntakeReady = async () => { throw Object.assign(new Error('pending'), { reason: 'INTAKE_PENDING' }); };
  assert.equal((await verifyRunProof(await signed(), version, w.deps)).ok, false);
  w.deps.assertIntakeReady = async () => true;
  const signature = w.signatures.find(s => s.subjectId === run.runId && s.step_index === 0);
  signature.meaning = 'I executed this test.';
  assert.equal((await verifyRunProof(await signed(), version, w.deps)).ok, false);
});

test('run proof rejects a stored outcome inconsistent with the signed steps', async () => {
  const { verifyRunProof } = await import('../src/testmgmt/proof.js');
  const { w, exec, run } = await fixture();
  let view = await exec.view('VAT-12', actor(w, 'reviewer'));
  view = await exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, actor(w, 'reviewer'));
  await exec.signRun({ runId: run.runId, code: '123456', contentHash: view.runs[0].contentHash }, actor(w, 'qa'));
  const stored = await w.deps.readRun(run.runId);
  stored.result = 'FAILED';
  assert.equal((await verifyRunProof(stored, await w.deps.readVersion(run.testVersionId), w.deps)).ok, false);
});

test('a different human-declared candidate requires another execution', async () => {
  const { w, exec } = await fixture();
  await exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11', reportedBuild: { id: 'A' } }, actor(w, 'reviewer'));
  await assert.rejects(exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11', reportedBuild: { id: 'B' } }, actor(w, 'reviewer')), { reason: 'EXECUTION_CANDIDATE_MISMATCH' });
});
