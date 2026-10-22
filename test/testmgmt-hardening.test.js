import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBug, SETTLE_MS } from '../src/testmgmt/bug.js';
import { tmWorld } from './helpers/tm-world.js';
import { repairTestBug } from '../src/usecases/testManagementAdmin.js';
import { fixture, request } from './admin-fixture.js';
import { pairsToCheck } from '../src/jobs/gatecheck.js';
import * as gatecheck from '../src/jobs/gatecheck.js';
import { DEFAULT_RUN_CHAIN, DEFAULT_VERSION_CHAIN, chainDigest } from '../src/testmgmt/chain.js';
import { contentDigest, runContent } from '../src/testmgmt/content.js';

const run = { runId: '1'.repeat(32), projectId: '100', testIssueId: '11', executionIssueId: '12' };
function bugWorld() {
  const w = tmWorld();
  const deps = { ...w.deps, createIssue: w.deps.createIssueAsApp, searchByLabel: w.deps.searchByLabelAsApp,
    readMarker: w.deps.readBugMarkerAsApp, linkIssue: w.deps.linkIssueAsApp };
  const args = { run, parentIssueId: '10', fields: { project: { id: '100' } }, links: [] };
  return { w, deps, args };
}
test('an unknown successful create with a lagging index never sends a second create', async () => {
  const { w, deps, args } = bugWorld();
  w.createFails.push('lost-after-create'); w.searchLagMs = SETTLE_MS * 5;
  await ensureBug(args, deps); w.advance(SETTLE_MS + 1);
  const result = await ensureBug(args, deps);
  assert.equal(w.created.length, 1);
  assert.equal(result.state, 'NEEDS_REPAIR');
  assert.equal(result.lastError, 'CREATE_ABSENCE_UNPROVEN');
});
test('throttled creates retry with retry-after and do not spend ambiguous create attempts', async () => {
  const { w, deps, args } = bugWorld();
  let calls = 0;
  deps.createIssue = async (...p) => { if (++calls === 1) throw Object.assign(new Error('throttle'), { status: 429, retryAfterMs: 2_000 }); return w.deps.createIssueAsApp(...p); };
  const result = await ensureBug(args, deps);
  assert.equal(result.state, 'CREATED');
  assert.equal(calls, 2);
  assert.equal(result.attempts, 1);
});
test('required defect links must complete before the defect releases the guard', async () => {
  const { deps, args } = bugWorld();
  deps.linkIssue = async () => { throw new Error('link refused'); };
  const result = await ensureBug({ ...args, links: [{ typeName: 'Relates', outwardId: '11' }] }, deps);
  assert.equal(result.state, 'NEEDS_REPAIR');
  assert.match(result.lastError, /^LINK_MISSING/);
});
test('a defect issue claimed by another run cannot become CREATED', async () => {
  const { deps, args } = bugWorld(); deps.claimBugIssue = async () => false;
  const result = await ensureBug(args, deps);
  assert.equal(result.state, 'NEEDS_REPAIR');
  assert.equal(result.lastError, 'BUG_ALREADY_ASSIGNED');
  assert.ok(result.issueId);
});

function repairWorld({ type = '3', parent = '10', associated = null, governed = false, linkFailure = false } = {}) {
  const w = bugWorld().w;
  w.addIssue('10', 'VAT-10', '9'); w.addIssue('11', 'VAT-11', '1', { parent: { id: '10', key: 'VAT-10' } });
  w.addIssue('12', 'VAT-12', '2'); w.addIssue('50', 'VAT-50', type, { parent: { id: parent, key: `VAT-${parent}` } });
  w.bugs.set(run.runId, { ...run, state: 'NEEDS_REPAIR', parentIssueId: '10', attempts: 1 });
  const deps = fixture({ query: async sql => ({ result: true, data: sql.includes('FROM va_admin') ? [{ account_id: 'admin' }]
    : sql.includes('FROM va_baseline_node') && governed ? [{ current_issue_id: 50 }] : [] }) });
  const version = { versionId: 'a'.repeat(32), testIssueId: '11', projectId: '100', state: 'SIGNED',
    content: { steps: [{ id: 's1', action: 'Act', data: '', expected: 'Expected' }], objective: '', preconditions: '', verifies: [], dataset: null },
    chain: DEFAULT_VERSION_CHAIN, chainDigest: chainDigest(DEFAULT_VERSION_CHAIN) };
  version.digest = contentDigest(version.content);
  const signed = { ...run, state: 'SIGNED', result: 'FAILED', testVersionId: version.versionId, testDigest: version.digest,
    chain: DEFAULT_RUN_CHAIN, chainDigest: chainDigest(DEFAULT_RUN_CHAIN), steps: [{ id: 's1', status: 'FAILED', actual: '', comment: '', evidence: [], recordedBy: 'tester', recordedAt: null }] };
  signed.frozenDigest = contentDigest(runContent(signed, signed.steps, 'FAILED'));
  const signatures = (chain, hash) => chain.steps.map((step, i) => ({ step_index: i, account_id: i ? 'qa' : 'tester', role: step.role,
    state: 'ACTIVE', auditSeq: i + 1, auditHash: 'b'.repeat(64), decision: 'SIGN', contentHash: hash }));
  deps.tm = { ...w.deps, readRun: async () => structuredClone(signed), readVersion: async () => structuredClone(version),
    listSignatures: async kind => kind === 'TEST_VERSION' ? signatures(version.chain, version.digest) : kind === 'RUN' ? signatures(signed.chain, signed.frozenDigest) : [],
    readBugByIssue: async () => associated, claimBugIssue: async () => !associated,
    linkIssueAsApp: async l => { if (linkFailure) throw new Error('link refused'); w.links.push(l); } };
  return { w, deps };
}
for (const [label, options, expected] of [
  ['unrelated work type', { type: '7' }, /mapped Bug/],
  ['wrong parent', { parent: '99' }, /parent/],
  ['reused defect', { associated: { runId: '2'.repeat(32) } }, /another run/],
  ['governed tree member', { governed: true }, /baseline/],
  ['missing links', { linkFailure: true }, /links/]
]) test(`defect repair rejects ${label}`, async () => {
  const { w, deps } = repairWorld(options);
  const result = await repairTestBug(request({ runId: run.runId, bugKey: 'VAT-50', reason: 'Checked by admin' }), deps);
  assert.equal(result.success, false);
  assert.match(result.error, expected);
  assert.equal(w.bugs.get(run.runId).state, 'NEEDS_REPAIR');
});
test('valid repair creates both navigation links and audits before marking CREATED', async () => {
  const { w, deps } = repairWorld();
  const result = await repairTestBug(request({ runId: run.runId, bugKey: 'VAT-50', reason: 'Checked Jira history' }), deps);
  assert.equal(result.success, true, result.error);
  assert.deepEqual(w.links.map(l => l.outwardId).sort(), ['11', '12']);
  assert.equal(deps.events.at(-1).eventType, 'TM_BUG_REPAIRED');
  assert.equal(w.bugs.get(run.runId).state, 'CREATED');
});
test('an audit failure leaves repair open after its navigation links are fixed', async () => {
  const { w, deps } = repairWorld(); deps.append = async () => { throw new Error('Ledger down'); };
  const result = await repairTestBug(request({ runId: run.runId, bugKey: 'VAT-50', reason: 'Checked' }), deps);
  assert.equal(result.success, false);
  assert.equal(w.bugs.get(run.runId).state, 'NEEDS_REPAIR');
});
test('a legacy SIGNED label without audited signature proof cannot acquire a repaired bug exemption', async () => {
  const { w, deps } = repairWorld(); deps.tm.listSignatures = async () => [];
  const result = await repairTestBug(request({ runId: run.runId, bugKey: 'VAT-50', reason: 'Investigated' }), deps);
  assert.equal(result.success, false); assert.match(result.error, /proof/i);
  assert.equal(w.bugs.get(run.runId).state, 'NEEDS_REPAIR'); assert.equal(w.links.length, 0);
});
test('repair uses the verified idempotent link adapter when available', async () => {
  const { w, deps } = repairWorld(); deps.tm.linkIssueAsApp = async () => { throw new Error('raw link adapter must not run'); };
  deps.tm.ensureIssueLinkAsApp = async link => { w.links.push(link); };
  const result = await repairTestBug(request({ runId: run.runId, bugKey: 'VAT-50', reason: 'Investigated' }), deps);
  assert.equal(result.success, true, result.error); assert.equal(w.links.length, 2);
});
test('enabled execution workflows are watched without any controlled transition or baseline', () => {
  const pairs = pairsToCheck({ tmExecutionPairs: [{ project_id: '100', issue_type_id: '2' }] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].testManagementExecution, true);
});
test('execution health catches every unguarded Done route and refuses incomplete status reads', () => {
  assert.equal(typeof gatecheck.testManagementWorkflowFindings, 'function');
  const workflow = { id: 'wf', name: 'Execution', transitions: [
    { id: '1', name: 'Start', toStatusReference: '10', type: 'DIRECTED' },
    { id: '2', name: 'Quick close', toStatusReference: '30', type: 'GLOBAL' }
  ] };
  const input = { workflow, group: { project_id: '100', issue_type_id: '2' }, appId: 'fixture-app',
    statuses: new Map([['10', { category: 'new' }], ['30', { category: 'done' }]]) };
  const findings = gatecheck.testManagementWorkflowFindings(input);
  assert.equal(findings.length, 1); assert.equal(findings[0].transitionId, '2');
  assert.equal(findings[0].severity, 'CRITICAL');
  assert.throws(() => gatecheck.testManagementWorkflowFindings({ ...input, statuses: new Map() }), /status/i);
});
