import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentDigest, runContent } from '../src/testmgmt/content.js';
import { chainDigest } from '../src/testmgmt/chain.js';
import { MACHINE_REVIEW_MEANING } from '../src/testmgmt/runReadiness.js';

// Replace invocation boundaries while retaining the real runtime composition
// and real version/run proof functions. No Forge host is needed for this test.
const stubs = {
  './store.js': 'export const listSignatures = async (kind) => globalThis.runtimeProofFixture.signatures[kind] ?? [];',
  './jira.js': '', './treeExclusion.js': 'export const testManagementRole = async () => null;',
  './signing.js': 'export const isEligibleFor = async () => true; export const roleHolders = async () => ({}); export const recordSignature = async () => ({});',
  '../lib/ledger.js': 'export const append = async () => ({});',
  '../db/store.js': 'export const auditStore = {}; export const newId = () => Buffer.alloc(16); export const tryAppend = async () => true;',
  '../lib/approval/totpVerification.js': 'export const verifyTotp = async () => ({ok:true});',
  './planningStore.js': '', './bugStore.js': '', './evidence.js': 'export const verifyEvidence = async () => true;',
  './sourceRuntime.js': 'export const sourceReportingRuntime = async deps => ({...deps, sourceProof: (run, version) => deps.verifyRunProof(run, version)});',
  '../usecases/testPlanning.js': 'export const createTestPlanning = () => ({validateRunPlanningSnapshot: async () => true});',
  './retestStore.js': '', './retestJira.js': '',
  './governedRuntime.js': 'export const governedTestRuntime = async deps => ({...deps, assertIntakeReady: async () => globalThis.runtimeProofFixture.ready()});'
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/src/testmgmt/runtime.js') && Object.hasOwn(stubs, specifier)) return { url: `proof-runtime:${encodeURIComponent(specifier)}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('proof-runtime:')) return { format: 'module', source: stubs[decodeURIComponent(url.slice('proof-runtime:'.length))], shortCircuit: true };
    return next(url, context);
  }
});

test('production runtime proof closures use the final intake dependencies', async () => {
  const chain = { steps: [{ label: 'Reviewer', role: 'QA', meaning: 'Approve' }], distinctSigners: true };
  const version = { versionId: 'v', state: 'SIGNED', content: { steps: [] }, chain, chainDigest: chainDigest(chain) };
  version.digest = contentDigest(version.content);
  const run = { runId: 'r', executionIssueId: '1', testIssueId: '2', testVersionId: 'v', testDigest: version.digest, chain, chainDigest: chainDigest(chain), state: 'SIGNED', result: 'PASSED',
    evidenceSchema: 2, attemptSequence: 1, provenance: { kind: 'MACHINE' }, intakeReceiptId: 'receipt', steps: [], resolvedSteps: [], iterations: [], planningSnapshot: {} };
  // Empty definitions produce NOT_RUN; use a concrete signed passed step.
  version.content.steps = [{ id: 's', action: 'Act', expected: 'Pass' }]; version.digest = contentDigest(version.content); run.testDigest = version.digest;
  run.resolvedSteps = version.content.steps; run.steps = [{ id: 's', status: 'PASSED', actual: '', comment: '', evidence: [], recordedBy: 'ci:token' }];
  const { runSteps } = await import('../src/testmgmt/content.js');
  run.frozenDigest = contentDigest(runContent(run, runSteps(run.resolvedSteps, run.steps), 'PASSED'));
  const signature = hash => ({ state: 'ACTIVE', step_index: 0, account_id: 'reviewer', role: 'QA', decision: 'SIGN', auditSeq: 1, auditHash: 'a'.repeat(64), contentHash: hash, meaning: MACHINE_REVIEW_MEANING });
  let readinessCalls = 0;
  globalThis.runtimeProofFixture = { signatures: { TEST_VERSION: [signature(version.digest)], RUN: [signature(run.frozenDigest)] }, ready: () => { readinessCalls++; return true; } };
  const { testManagementRuntime } = await import('../src/testmgmt/runtime.js');
  const deps = await testManagementRuntime();
  assert.deepEqual(await deps.verifyRunProof(run, version), { ok: true });
  assert.deepEqual(await deps.sourceProof(run, version), { ok: true });
  assert.equal(readinessCalls, 2);
  globalThis.runtimeProofFixture.ready = () => { throw new Error('receipt pending'); };
  assert.equal((await deps.verifyRunProof(run, version)).ok, false);
});
