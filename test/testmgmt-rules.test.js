import test from 'node:test';
import assert from 'node:assert/strict';
import { iterationResult, runResult, signabilityProblem } from '../src/testmgmt/results.js';
import { validateChain, chainPreflight, chainPosition, chainDigest, DEFAULT_RUN_CHAIN } from '../src/testmgmt/chain.js';
import { ensureBug, SETTLE_MS, IN_FLIGHT_MS } from '../src/testmgmt/bug.js';
import { openItems, executionGuard } from '../src/testmgmt/executionGuard.js';
import { createTreeReader } from '../src/lib/tree/jira.js';
import { driftedAncestor } from '../src/lib/ancestorHold.js';
import { holdersFrom } from '../src/testmgmt/signing.js';
import { testManagementExclusion } from '../src/testmgmt/treeExclusion.js';
import { tmWorld } from './helpers/tm-world.js';

// ── result rules (spec, "Result rules") ────────────────────────────────────
test('an iteration follows the fixed precedence: failed, blocked, not run, N/A, partly passed, passed', () => {
  assert.equal(iterationResult(['PASSED', 'FAILED', 'BLOCKED']), 'FAILED');
  assert.equal(iterationResult(['PASSED', 'BLOCKED', 'NOT_RUN']), 'BLOCKED');
  assert.equal(iterationResult(['PASSED', 'NOT_RUN']), 'IN_PROGRESS');
  assert.equal(iterationResult(['NOT_RUN', 'NOT_RUN']), 'NOT_RUN');
  assert.equal(iterationResult(['NOT_APPLICABLE', 'NOT_APPLICABLE']), 'NOT_APPLICABLE');
  assert.equal(iterationResult(['PASSED', 'NOT_APPLICABLE']), 'PARTLY_PASSED');
  assert.equal(iterationResult(['PASSED', 'PASSED']), 'PASSED');
  assert.equal(iterationResult([]), 'NOT_RUN');
  assert.equal(iterationResult(['PASSED', 'nonsense']), 'IN_PROGRESS', 'an unknown status is never a pass');
});

test('a run: any failed iteration fails it, and a skipped iteration is never a pass', () => {
  assert.equal(runResult([{ steps: ['PASSED'] }, { steps: ['FAILED'] }]), 'FAILED');
  assert.equal(runResult([{ steps: ['PASSED'] }, { skipped: true }]), 'PARTLY_PASSED');
  assert.equal(runResult([{ skipped: true }]), 'NOT_RUN');
  assert.equal(runResult([{ steps: ['PASSED'] }, { steps: ['NOT_APPLICABLE'] }]), 'PARTLY_PASSED');
  assert.equal(runResult([{ steps: ['PASSED'] }, { steps: ['PASSED'] }]), 'PASSED');
});

test('a run is signable only when every step has a result, N/A has a reason, and nothing is blocked', () => {
  assert.equal(signabilityProblem([]), 'NO_STEPS');
  assert.equal(signabilityProblem([{ status: 'PASSED' }, { status: 'NOT_RUN' }]), 'STEPS_NOT_RUN');
  assert.equal(signabilityProblem([{ status: 'NOT_APPLICABLE', comment: '' }]), 'NA_REASON_REQUIRED');
  assert.equal(signabilityProblem([{ status: 'NOT_APPLICABLE', comment: 'Variant has no CAN' }]), null);
  assert.equal(signabilityProblem([{ status: 'PASSED' }, { status: 'BLOCKED' }]), 'RUN_BLOCKED');
  assert.equal(signabilityProblem([{ status: 'FAILED' }, { status: 'BLOCKED' }]), null, 'a failure is final, so a failed run can be signed');
});

// ── sign-off chains ─────────────────────────────────────────────────────────
test('a chain step names a role from Approver roles exactly, as a controlled transition does', () => {
  assert.equal(validateChain({ steps: [{ label: 'X', role: 'QA Lead', meaning: 'm' }] }).chain.steps[0].role, 'QA Lead');
  assert.equal(validateChain({ steps: [{ label: 'X', role: 'tester', meaning: 'm' }] }).chain.steps[0].role, 'tester', 'never rewritten');
});

test('a chain is refused, never coerced, when a step has no usable role or no meaning', () => {
  assert.equal(validateChain({ steps: [] }).error, 'CHAIN_EMPTY');
  for (const role of ['', ' QA', 'QA ', 'x'.repeat(33), undefined, 7]) {
    assert.equal(validateChain({ steps: [{ label: 'X', role, meaning: 'm' }] }).error, 'CHAIN_ROLE_INVALID', JSON.stringify(role));
  }
  assert.equal(validateChain({ steps: [{ label: 'X', role: 'TESTER', meaning: ' ' }] }).error, 'CHAIN_MEANING_INVALID');
  assert.deepEqual(validateChain(DEFAULT_RUN_CHAIN).chain.steps.map(s => s.role), ['TESTER', 'QA']);
});

test('preflight needs a holder per step and enough distinct people when signers must differ', () => {
  const chain = { steps: [{ role: 'TESTER' }, { role: 'QA' }], distinctSigners: true };
  assert.equal(chainPreflight(chain, { TESTER: ['a'], QA: [] }).reason, 'NO_ELIGIBLE_SIGNER');
  assert.equal(chainPreflight(chain, { TESTER: ['a'], QA: ['a'] }).reason, 'NOT_ENOUGH_DISTINCT_SIGNERS');
  assert.equal(chainPreflight(chain, { TESTER: ['a', 'b'], QA: ['a'] }).ok, true, 'b tests, a reviews');
  assert.equal(chainPreflight(chain, { TESTER: ['a', 'b'], QA: ['a'] }, { mustInclude: 'a' }).reason, 'NOT_ENOUGH_DISTINCT_SIGNERS');
  assert.equal(chainPreflight({ ...chain, distinctSigners: false }, { TESTER: ['a'], QA: ['a'] }).ok, true);
});

test('chain position reports the next step, completion, rejection, and a gap as corrupt', () => {
  const chain = { steps: [{ role: 'TESTER' }, { role: 'QA' }] };
  assert.equal(chainPosition(chain, []).next, 0);
  assert.equal(chainPosition(chain, [{ step_index: 0, decision: 'SIGN' }]).next, 1);
  assert.equal(chainPosition(chain, [{ step_index: 0, decision: 'SIGN' }, { step_index: 1, decision: 'SIGN' }]).complete, true);
  assert.equal(chainPosition(chain, [{ step_index: 0, decision: 'SIGN' }, { step_index: 1, decision: 'REJECT' }]).rejected, true);
  assert.equal(chainPosition(chain, [{ step_index: 1, decision: 'SIGN' }]).corrupt, true);
});

// ── the automatic bug ───────────────────────────────────────────────────────
const RUN = { runId: 'f'.repeat(32), projectId: '100' };
const bugDeps = (w) => ({ insertBugIntent: w.deps.insertBugIntent, readBug: w.deps.readBug, updateBug: w.deps.updateBug,
  createIssue: w.deps.createIssueAsApp, searchByLabel: w.deps.searchByLabelAsApp, readMarker: w.deps.readBugMarkerAsApp,
  linkIssue: w.deps.linkIssueAsApp, now: w.deps.now });
const args = { run: RUN, parentIssueId: '10', fields: { project: { id: '100' }, summary: 'x', labels: [] },
  links: [{ typeName: 'Relates', outwardId: '11' }] };

test('a create whose answer was lost is found by its marker once search has caught up, not created twice', async () => {
  const w = tmWorld();
  w.searchLagMs = 30_000;
  w.createFails.push('lost-after-create');
  let bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'INTENT', 'a lost answer is not judged straight away');
  assert.equal(bug.lastError, 'CREATE_ANSWER_LOST');
  bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'INTENT', 'nor on a retry before search can have indexed the bug');
  assert.equal(w.created.length, 1);
  w.advance(SETTLE_MS);
  bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'CREATED');
  assert.equal(bug.issueKey, 'BUG-1');
  assert.equal(w.created.length, 1, 'never a second bug');
});

test('an empty search after a lost create requires repair instead of another automatic create', async () => {
  const w = tmWorld();
  w.createFails.push(503, 503);
  assert.equal((await ensureBug(args, bugDeps(w))).state, 'INTENT');
  w.advance(SETTLE_MS);
  assert.equal((await ensureBug(args, bugDeps(w))).attempts, 1, 'search pagination cannot prove a lost create made nothing');
  w.advance(SETTLE_MS);
  const bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'NEEDS_REPAIR');
  assert.equal(bug.lastError, 'CREATE_ABSENCE_UNPROVEN');
  assert.equal(w.created.length, 0);
});

test('the marker label on an issue that is not this run\'s bug is never taken for it', async () => {
  const w = tmWorld();
  w.createFails.push(503);
  await ensureBug(args, bugDeps(w));
  // Someone puts the marker label on another issue, with no property naming the run.
  await w.deps.createIssueAsApp({ project: { id: '100' }, labels: [`va-run-${RUN.runId}`] });
  w.advance(SETTLE_MS);
  const bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'NEEDS_REPAIR');
  assert.equal(bug.lastError, 'MARKER_NOT_CONFIRMED');
  assert.equal(bug.issueId, null);
  assert.equal(w.created.length, 1, 'and no bug of ours is created next to it');
});

test('two callers past a stale intent claim the create once between them', async () => {
  const w = tmWorld();
  await w.deps.insertBugIntent({ runId: RUN.runId, projectId: '100', parentIssueId: '10', marker: 'm', now: w.deps.now() });
  w.advance(IN_FLIGHT_MS);
  const [a, b] = await Promise.all([ensureBug(args, bugDeps(w)), ensureBug(args, bugDeps(w))]);
  assert.equal(w.created.length, 1);
  assert.ok([a.state, b.state].includes('CREATED'));
});

test('a bug that cannot be built is recorded as needing repair, not left pending', async () => {
  const w = tmWorld();
  const bug = await ensureBug({ ...args, parentIssueId: null, unbuildable: 'TEST_UNREADABLE' }, bugDeps(w));
  assert.equal(bug.state, 'NEEDS_REPAIR');
  assert.equal(bug.lastError, 'TEST_UNREADABLE');
});

test('Jira refusing the create is NEEDS_REPAIR at once; no second payload is tried', async () => {
  const w = tmWorld();
  w.createFails.push(400);
  const bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'NEEDS_REPAIR');
  assert.equal(bug.lastError, 'JIRA_REFUSED_400');
  assert.equal(w.created.length, 0);
});

test('a test with no parent gets no bug: the run shows Bug needs repair', async () => {
  const w = tmWorld();
  const bug = await ensureBug({ ...args, parentIssueId: null }, bugDeps(w));
  assert.equal(bug.state, 'NEEDS_REPAIR');
  assert.equal(bug.lastError, 'TEST_HAS_NO_PARENT');
});

test('a second caller under a fresh intent leaves it to its owner', async () => {
  const w = tmWorld();
  await w.deps.insertBugIntent({ runId: RUN.runId, projectId: '100', parentIssueId: '10', marker: 'm', now: w.deps.now() });
  const bug = await ensureBug(args, bugDeps(w));
  assert.equal(bug.state, 'INTENT');
  assert.equal(w.created.length, 0);
});

// ── the execution guard ─────────────────────────────────────────────────────
test('an execution is held from Done by an open run or a failed run waiting for its bug', async () => {
  const runs = [{ runId: 'a', state: 'SIGNED', result: 'PASSED' }, { runId: 'b', state: 'SIGNING' },
    { runId: 'c', state: 'SIGNED', result: 'FAILED' }, { runId: 'd', state: 'SIGNED', result: 'FAILED' }];
  const open = openItems(runs, [{ runId: 'c', state: 'CREATED' }, { runId: 'd', state: 'NEEDS_REPAIR' }]);
  assert.deepEqual(open.map(o => [o.runId, o.reason]), [['b', 'RUN_NOT_TERMINAL'], ['d', 'BUG_NEEDS_REPAIR']]);
  const guard = await executionGuard({ issue: { id: '12' }, readStatusCategory: async () => 'done' }, {
    testManagementRole: async () => ({ role: 'EXECUTION' }),
    listOpenRunsForExecution: async () => runs.filter(r => r.state !== 'SIGNED' || r.result === 'FAILED') });
  assert.equal(guard.open.length, 3);
  let read = false;
  assert.equal(await executionGuard({ issue: {}, readStatusCategory: async () => { read = true; } },
    { testManagementRole: async () => null }), null);
  assert.equal(read, false, 'a non-execution never pays for the status read');
});

test('the guard sees an open run however many runs the execution has', async () => {
  const w = tmWorld();
  for (let i = 0; i < 600; i++) {
    const runId = i.toString(16).padStart(32, '0');
    const chain = { steps: [{ role: 'TESTER' }], distinctSigners: true };
    w.runs.set(runId, { runId, executionIssueId: '12', state: i === 550 ? 'SIGNING' : 'SIGNED', result: 'PASSED',
      chain, chainDigest: chainDigest(chain), frozenDigest: 'a'.repeat(64) });
    if (i !== 550) w.signatures.push({ subject_kind: 'RUN', subjectId: runId, step_index: 0, role: 'TESTER', account_id: 'tester',
      decision: 'SIGN', state: 'ACTIVE', auditSeq: i + 1, auditHash: 'b'.repeat(64), contentHash: 'a'.repeat(64) });
  }
  const guard = await executionGuard({ issue: { id: '12' }, readStatusCategory: async () => 'done' }, {
    testManagementRole: async () => ({ role: 'EXECUTION' }), listOpenRunsForExecution: w.deps.listOpenRunsForExecution });
  assert.deepEqual(guard.open.map(o => o.reason), ['RUN_NOT_TERMINAL']);
});

// ── role holders follow the signing predicate ──────────────────────────────
test('preflight counts a grant only where signing accepts it: the subject\'s work type or every type', () => {
  const rows = [
    { account_id: 'story-only', role: 'TESTER', issue_type_id: '7', project_id: '100', state: 'ACTIVE' },
    { account_id: 'exec-type', role: 'TESTER', issue_type_id: '2', project_id: '100', state: 'ACTIVE' },
    { account_id: 'everywhere', role: 'TESTER', issue_type_id: '*', project_id: null, state: 'ACTIVE' },
    { account_id: 'other-project', role: 'TESTER', issue_type_id: '*', project_id: '200', state: 'ACTIVE' }
  ];
  assert.deepEqual(holdersFrom(rows, { projectId: '100', issueTypeId: '2', roles: ['TESTER'] }), { TESTER: ['exec-type', 'everywhere'] });
});

// ── decision 11: test-management issues are outside the Epic's tree ────────
test('a test-management bug stays out of the tree when test management is off or the bug type changes', async () => {
  const child = (id, typeId) => ({ id, fields: { project: { id: '100' }, issuetype: { id: typeId } } });
  const config = { projectId: '100', testTypeId: '1', executionTypeId: '2', planTypeId: null, defectTypeId: '9' };
  const deps = (enabled) => ({ listProjects: async () => [{ ...config, enabled }],
    bugIssueIdsAmong: async (ids) => new Set(ids.map(String).filter(id => id === '5001')) });
  const children = [child('5001', '3'), child('5002', '3'), child('11', '1'), child('12', '7')];
  assert.deepEqual([...await testManagementExclusion(children, deps(true))].sort(), ['11', '5001'],
    'enabled: the mapped test type, and the bug by its tm_bug row although its type is no longer the bug type');
  assert.deepEqual([...await testManagementExclusion(children, deps(false))], ['5001'],
    'switched off: the bug is still out; the test type is back in, which setup allows only when none has a parent');
  assert.deepEqual([...await testManagementExclusion([child('5001', '3')], { listProjects: async () => [],
    bugIssueIdsAmong: async () => { throw new Error('a project without test management pays no SQL read'); } })], []);
});

test('the tree reader leaves out excluded children and everything under them', async () => {
  const issues = {
    'EPIC-1': { id: '1', key: 'EPIC-1', fields: { summary: 'e', project: { id: '100' }, issuetype: { id: '9' }, status: {}, parent: null } }
  };
  const children = { 'EPIC-1': [
    { id: '2', key: 'S-2', fields: { summary: 's', project: { id: '100' }, issuetype: { id: '7' }, status: {}, parent: { id: '1' } } },
    { id: '3', key: 'T-3', fields: { summary: 't', project: { id: '100' }, issuetype: { id: '1' }, status: {}, parent: { id: '1' } } }
  ], 'S-2': [], 'T-3': [{ id: '4', key: 'SUB-4', fields: { summary: 'u', project: { id: '100' }, issuetype: { id: '8' }, status: {}, parent: { id: '3' } } }] };
  const api = { asApp: () => ({ requestJira: async (path, req) => {
    if (!req) return { status: 200, json: async () => structuredClone(issues['EPIC-1']) };
    const key = JSON.parse(req.body).jql.match(/"(.+)"/)[1];
    return { status: 200, json: async () => ({ issues: structuredClone(children[key] ?? []) }) };
  } }) };
  const route = (s, ...v) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '');
  const tree = await createTreeReader({ api, route, canonicalise: async () => {},
    exclude: async (list) => new Set(list.filter(c => c.fields.issuetype.id === '1').map(c => c.id)) }).read('EPIC-1', ['summary']);
  assert.deepEqual(tree.nodes.map(n => n.key), ['EPIC-1', 'S-2']);
});

test('a test-management issue is not held by its drifted parent', async () => {
  const deps = { exempt: async () => true, readIssue: async () => { throw new Error('must not read the parent'); } };
  assert.equal(await driftedAncestor({ id: '3', fields: { parent: { key: 'EPIC-1' } } }, deps), null);
});
