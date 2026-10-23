import test from 'node:test';
import assert from 'node:assert/strict';
import { tmWorld } from './helpers/tm-world.js';
import { createTestAuthoring } from '../src/usecases/testAuthoring.js';
import { createTestExecution } from '../src/usecases/testExecution.js';
import { createTestSources } from '../src/testmgmt/sources.js';
import { createTestPlanning } from '../src/usecases/testPlanning.js';
import { createTestPlanExecution } from '../src/usecases/testPlanExecution.js';
import { createTestSummary } from '../src/usecases/testSummary.js';
import { planningWorld } from './helpers/tm-planning-world.js';
import { verifyRunProof, verifyVersionProof } from '../src/testmgmt/proof.js';

const actor = (w, accountId) => { w.viewer = accountId; return { accountId }; };
function setup() {
  const w = tmWorld(), parent = { id: '10', key: 'VAT-10' };
  w.addIssue('11', 'VAT-11', '1', { parent });
  w.addIssue('12', 'VAT-12', '2', { parent });
  w.addIssue('42', 'VAT-42', '7', { parent });
  w.grants.push({ accountId: 'approver', role: 'APPROVER' }, { accountId: 'tester', role: 'TESTER' }, { accountId: 'qa', role: 'QA' });
  return { w, authoring: createTestAuthoring(w.deps), exec: createTestExecution(w.deps) };
}
async function publish(c, draft) {
  let v = await c.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0, draft }, actor(c.w, 'author'));
  v = await c.authoring.publish({ issueKey: 'VAT-11', expectedRevision: v.draft.revision }, actor(c.w, 'author'));
  return v.versions[0];
}

test('a dataset version creates frozen resolved iterations and every iteration must be executed', async () => {
  const c = setup();
  const v = await publish(c, { steps: [{ id: 's1', action: 'Apply {{voltage}} V', data: '{{voltage}}', expected: 'Starts' }],
    dataset: { mode: 'ROWS', parameters: [{ name: 'voltage', type: 'TEXT' }], rows: [{ id: 'nominal', values: { voltage: '12' } }, { id: 'high', values: { voltage: '24' } }] } });
  assert.equal(v.content.dataset.rows.length, 2);
  await c.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, actor(c.w, 'approver'));
  let view = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(c.w, 'tester'));
  let r = view.runs[0];
  assert.deepEqual(r.steps.map(s => s.action), ['Apply 12 V', 'Apply 24 V']);
  assert.deepEqual(r.iterations.map(i => i.values.voltage), ['12', '24']);
  view = await c.exec.recordStep({ runId: r.runId, expectedRevision: r.revision, stepId: 'nominal__s1', status: 'PASSED' }, actor(c.w, 'tester'));
  r = view.runs[0];
  await assert.rejects(c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, actor(c.w, 'tester')), { reason: 'STEPS_NOT_RUN' });
  view = await c.exec.recordStep({ runId: r.runId, expectedRevision: r.revision, stepId: 'high__s1', status: 'PASSED' }, actor(c.w, 'tester'));
  r = view.runs[0];
  view = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: r.contentHash }, actor(c.w, 'tester'));
  view = await c.exec.signRun({ runId: r.runId, code: '123456', contentHash: view.runs[0].contentHash }, actor(c.w, 'qa'));
  assert.equal(view.runs[0].state, 'SIGNED');
  assert.equal(view.runs[0].result, 'PASSED');
  assert.equal(c.w.runs.get(r.runId).resolvedSteps[1].data, '24');
});

test('a published source reference is server-read and a changed source cannot be approved', async () => {
  const c = setup();
  c.w.deps.resolveTestSources = async () => [{ issueId: '42', issueKey: 'VAT-42', projectId: '100', siteId: 'site',
    sourceDigest: 'b'.repeat(64), baseline: { id: 'baseline-1', version: 1, hash: 'c'.repeat(64) }, governedReady: true, drifted: false }];
  c.w.deps.validateTestSources = async () => { throw Object.assign(new Error('Source changed'), { reason: 'CONTENT_CHANGED' }); };
  const v = await publish(c, { steps: [{ id: 's1', action: 'Read VIN', expected: 'Correct VIN' }], verifies: [{ issueId: '42' }] });
  assert.equal(v.content.verifies[0].sourceDigest, 'b'.repeat(64));
  await assert.rejects(c.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, actor(c.w, 'approver')), { reason: 'CONTENT_CHANGED' });
});

test('an official run refuses a version whose state says signed without confirmed approval proof', async () => {
  const c = setup();
  const v = await publish(c, { steps: [{ id: 's1', action: 'Act', expected: 'Expected' }] });
  c.w.versions.get(v.versionId).state = 'SIGNED';
  await assert.rejects(c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(c.w, 'tester')), { reason: 'VERSION_PROOF_INVALID' });
});

test('authoring and run creation pass the authenticated actor to the real source boundary', async () => {
  const c = setup();
  const source = { issueId: '42', issueKey: 'VAT-42', projectId: '100', siteId: 'site',
    sourceDigest: 'b'.repeat(64), baseline: null, governedReady: false, drifted: false, complete: true };
  const sources = createTestSources({ siteIdentity: async () => 'site',
    readProject: async () => ({ sourceLinkTypeId: '90' }),
    readIssueAsUser: async () => ({ id: '42', key: 'VAT-42', fields: { project: { id: '100' } } }),
    getSourceState: async () => source });
  Object.assign(c.w.deps, sources);
  const v = await publish(c, { steps: [{ id: 's1', action: 'Read', expected: 'OK' }], verifies: [{ issueId: '42' }] });
  await c.authoring.signVersion({ versionId: v.versionId, code: '123456', contentHash: v.digest }, actor(c.w, 'approver'));
  const view = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(c.w, 'tester'));
  assert.equal(view.runs[0].planningSnapshot.sourceReferences[0].issueId, '42');
});

test('a signed plan and dataset flow through real execution proof into a frozen complete summary', async () => {
  const c = setup(), pw = planningWorld();
  c.w.project.planTypeId = '4'; c.w.project.preconditionTypeId = '6';
  c.w.addIssue('21', 'VAT-21', '4', { parent: { id: '10', key: 'VAT-10' } });
  for (const name of ['readCollectionDraft', 'saveCollectionDraft', 'listCollectionRevisions', 'readCollectionRevision', 'insertCollectionRevision', 'setCollectionRevisionState']) c.w.deps[name] = pw.deps[name];
  const planning = createTestPlanning(c.w.deps);
  const validatePlanning = (r, _version, { viewer }) => planning.validateRunPlanningSnapshot(r, viewer);
  c.w.deps.validateRunPlanningSnapshot = validatePlanning;
  const v = await publish(c, { steps: [{ id: 's1', action: 'Apply {{v}}', expected: 'Ready' }],
    dataset: { parameters: [{ name: 'v', type: 'TEXT' }], rows: [{ id: 'low', values: { v: '12' } }, { id: 'high', values: { v: '24' } }] } });
  await c.authoring.signVersion({ versionId: v.versionId, contentHash: v.digest, code: '123456' }, actor(c.w, 'approver'));
  let plan = await planning.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueId: '11' }],
    environment: 'Bench', configurations: [{ id: 'a', name: 'A' }], releaseId: '900' } }, actor(c.w, 'author'));
  plan = await planning.publish({ issueKey: 'VAT-21', expectedRevision: plan.draft.revision }, actor(c.w, 'author'));
  let revision = plan.revisions[0];
  plan = await planning.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, actor(c.w, 'approver'));
  revision = plan.revisions[0];
  const start = createTestPlanExecution(c.w.deps), request = { revisionId: revision.revisionId, contentHash: revision.digest, executionKey: 'VAT-12', requestId: 'manual-journey-1' };
  await start.start(request, actor(c.w, 'tester')); await start.start(request, actor(c.w, 'tester'));
  assert.equal(c.w.runs.size, 1, 'a repeated plan request creates one immutable run');
  let view = await c.exec.view('VAT-12', actor(c.w, 'tester')), run = view.runs[0];
  for (const step of run.steps) {
    view = await c.exec.recordStep({ runId: run.runId, expectedRevision: view.runs[0].revision, stepId: step.id, status: 'PASSED' }, actor(c.w, 'tester'));
  }
  c.w.deps.validateRunPlanningSnapshot = async () => { throw Object.assign(new Error('Hidden plan'), { reason: 'NOT_FOUND' }); };
  const hiddenPlan = await c.exec.view('VAT-12', actor(c.w, 'tester'));
  assert.equal(hiddenPlan.runs[0].canSign, false); assert.equal(hiddenPlan.runs[0].planningSnapshot, null);
  await assert.rejects(c.exec.signRun({ runId: run.runId, contentHash: view.runs[0].contentHash, code: '123456' }, actor(c.w, 'tester')), { reason: 'NOT_FOUND' });
  c.w.deps.validateRunPlanningSnapshot = validatePlanning;
  view = await c.exec.signRun({ runId: run.runId, contentHash: view.runs[0].contentHash, code: '123456' }, actor(c.w, 'tester'));
  view = await c.exec.signRun({ runId: run.runId, contentHash: view.runs[0].contentHash, code: '123456' }, actor(c.w, 'qa'));
  Object.assign(c.w.deps, { verifyVersionProof: version => verifyVersionProof(version, c.w.deps),
    verifyRunProof: (r, version) => verifyRunProof(r, version, c.w.deps),
    validateRunPlanningSnapshot: (r, _version, { viewer }) => planning.validateRunPlanningSnapshot(r, viewer),
    readRunsForTestComplete: async id => ({ records: await c.w.deps.listRunsForTest(id), complete: true }),
    readRunsForExecutionComplete: async id => ({ records: await c.w.deps.listRunsForExecution(id), complete: true }),
    resolveTestSources: async () => [], readBlockingDefects: async () => ({ ok: true, blocking: false }),
    insertExecutionSummary: async record => { c.summary = structuredClone(record); return true; } });
  const summary = await createTestSummary(c.w.deps).generate({ issueKey: 'VAT-12' }, actor(c.w, 'qa'));
  assert.equal(summary.completeness, 'COMPLETE'); assert.equal(summary.snapshot.runs[0].iterations.length, 2);
  assert.equal(summary.snapshot.runs[0].planningSnapshot.plan.revisionId, revision.revisionId);
  assert.equal(summary.snapshot.runs[0].signatures.length, 2);
  c.w.addIssue('13', 'VAT-13', '2', { parent: { id: '10', key: 'VAT-10' } });
  c.w.deps.projectVersions = async () => [];
  const rerun = await c.exec.addRun({ issueKey: 'VAT-13', testKey: 'VAT-11', releaseId: '900', retestOf: run.runId }, actor(c.w, 'tester'));
  assert.deepEqual(rerun.runs[0].release, { id: '900', name: 'R1' }, 'reruns retain an archived original release from validated immutable proof');
});

test('a source key saved only in a draft is never returned to a viewer who cannot read the source', async () => {
  const c = setup(); let visible = true;
  c.w.deps.resolveTestSources = async () => { if (!visible) throw Object.assign(new Error('Unavailable source'), { reason: 'SOURCE_UNAVAILABLE' });
    return [{ issueId: '42', issueKey: 'VAT-42' }]; };
  await c.authoring.saveDraft({ issueKey: 'VAT-11', expectedRevision: 0, draft: { verifies: [{ issueId: '42' }] } }, actor(c.w, 'approver'));
  visible = false;
  await assert.rejects(c.authoring.view('VAT-11', actor(c.w, 'qa')), { reason: 'SOURCE_UNAVAILABLE' });
});

test('a frozen run with unavailable legacy evidence can be rejected but cannot be accepted', async () => {
  const c = setup(); const v = await publish(c, { steps: [{ id: 's1', action: 'Read', expected: 'OK' }] });
  await c.authoring.signVersion({ versionId: v.versionId, contentHash: v.digest, code: '123456' }, actor(c.w, 'approver'));
  let view = await c.exec.addRun({ issueKey: 'VAT-12', testKey: 'VAT-11' }, actor(c.w, 'tester'));
  const id = view.runs[0].runId;
  view = await c.exec.recordStep({ runId: id, expectedRevision: view.runs[0].revision, stepId: 's1', status: 'PASSED' }, actor(c.w, 'tester'));
  view = await c.exec.signRun({ runId: id, contentHash: view.runs[0].contentHash, code: '123456' }, actor(c.w, 'tester'));
  c.w.deps.verifyEvidence = async () => { throw Object.assign(new Error('No retained legacy evidence'), { reason: 'EVIDENCE_RETENTION_REQUIRED' }); };
  const args = { runId: id, contentHash: view.runs[0].contentHash, code: '123456' };
  await assert.rejects(c.exec.signRun(args, actor(c.w, 'qa')), { reason: 'EVIDENCE_RETENTION_REQUIRED' });
  view = await c.exec.signRun({ ...args, decision: 'REJECT', reason: 'Evidence cannot be retained; execute a new run.' }, actor(c.w, 'qa'));
  assert.equal(view.runs[0].state, 'REJECTED');
});
