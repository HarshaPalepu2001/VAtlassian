import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, fixtureGateValidator } from './admin-fixture.js';
import { saveTestManagementConfig } from '../src/usecases/testManagementAdmin.js';
import { DEFAULT_RUN_CHAIN, DEFAULT_VERSION_CHAIN } from '../src/testmgmt/chain.js';

// Project 100: Test '1', Test Execution '2', Story '7', Bug '3'. The Execution
// workflow: Start (to In Progress, '20') and Close and Reopen-close (to Done, '30').
const transition = (id, name, to, validators = [], type = 'DIRECTED') =>
  ({ id, name, type, toStatusReference: to, links: [{ fromStatusReference: '10' }], validators });
const gated = () => [fixtureGateValidator()];

function world({ existing = null, transitions, parented = {}, statuses } = {}) {
  const deps = fixture({
    readWorkflowForPair: async () => ({ id: 'wf', name: 'Execution workflow',
      transitions: transitions ?? [transition('1', 'Create', '10', [], 'INITIAL'), transition('11', 'Start', '20'),
        transition('12', 'Close', '30', gated()), transition('13', 'Reopen-close', '30', gated(), 'GLOBAL')] })
  });
  deps.lookupStatuses = async () => statuses ?? new Map([['10', { category: 'new' }], ['20', { category: 'indeterminate' }],
    ['30', { category: 'done' }]]);
  const saved = [];
  deps.tm = {
    projectIssueTypes: async () => ({ style: 'classic', issueTypes: [{ id: '1', name: 'Test' }, { id: '2', name: 'Test Execution' },
      { id: '3', name: 'Bug' }, { id: '7', name: 'Story' }] }),
    readProject: async () => existing,
    linkTypes: async () => [{ name: 'Relates' }],
    createScreenFields: async () => new Set(['summary', 'labels', 'parent']),
    issuesOfTypeWithParent: async (_p, typeId) => parented[typeId] ?? { ids: [], complete: true },
    saveProject: async (next) => { saved.push(next); return true; }
  };
  return { deps, saved };
}

const payload = (extra = {}) => ({ projectId: '100', enabled: true, testTypeId: '1', executionTypeId: '2', defectTypeId: '3',
  linkTypeName: 'Relates', runChain: DEFAULT_RUN_CHAIN, versionChain: DEFAULT_VERSION_CHAIN, ...extra });
const enabledConfig = { projectId: '100', enabled: true, testTypeId: '1', executionTypeId: '2', planTypeId: null,
  defectTypeId: '3', revision: 3 };

test('test management is enabled only when va-gate guards every transition of the execution workflow into Done', async () => {
  const { deps, saved } = world();
  const ok = await saveTestManagementConfig(request(payload()), deps);
  assert.equal(ok.success, true, ok.error);
  assert.equal(saved.length, 1);

  const missing = world({ transitions: [transition('12', 'Close', '30', gated()), transition('14', 'Quick close', '30'),
    transition('15', 'Close (old)', '30', [fixtureGateValidator({ disabled: 'true' })], 'GLOBAL')] });
  const refused = await saveTestManagementConfig(request(payload()), missing.deps);
  assert.equal(refused.success, false);
  assert.match(refused.error, /Missing on: Quick close, Close \(old\)\./);
  assert.equal(missing.saved.length, 0, 'a refused save changes nothing');
});

test('an execution workflow or status that cannot be read refuses enablement, never passes it', async () => {
  const unreadable = world();
  unreadable.deps.readWorkflowForPair = async () => null;
  assert.match((await saveTestManagementConfig(request(payload()), unreadable.deps)).error, /could not be read/);
  // lookupStatuses answers an empty map when Jira cannot be read.
  const noStatuses = world({ statuses: new Map() });
  assert.match((await saveTestManagementConfig(request(payload()), noStatuses.deps)).error, /could not be read/);
  assert.equal(unreadable.saved.length + noStatuses.saved.length, 0);
});

test('each chain role must be held in the project for its work type before enabling, as on controlled transitions', async () => {
  // Held: Approver on Test ('1'); Tester and QA Lead on Test Execution ('2'); all in project 100.
  const held = new Set(['Approver|1|100', 'Tester|2|100', 'QA Lead|2|100']);
  const chains = (version, run) => ({
    versionChain: { steps: [{ label: 'Approved by', role: version, meaning: 'I approve it.' }], distinctSigners: true },
    runChain: { steps: run.map(role => ({ label: role, role, meaning: 'I sign it.' })), distinctSigners: true }
  });
  const attempt = async (extra) => {
    const { deps, saved } = world();
    const original = deps.executeQuery;
    deps.executeQuery = async (sql, params) => sql.includes('FROM va_eligibility')
      ? { result: true, data: held.has(params.join('|')) ? [{ ok: 1 }] : [] } : original(sql, params);
    return { result: await saveTestManagementConfig(request(payload(extra)), deps), saved };
  };

  const ok = await attempt(chains('Approver', ['Tester', 'QA Lead']));
  assert.equal(ok.result.success, true, ok.result.error);
  assert.deepEqual(ok.saved[0].runChain.steps.map(s => s.role), ['Tester', 'QA Lead']);

  const versionOnExecutionRole = await attempt(chains('Tester', ['Tester', 'QA Lead']));
  assert.equal(versionOnExecutionRole.result.error,
    'No one currently holds the "Tester" role for this scope. Grant it before requiring it.', 'a test version is signed on the Test type');
  const runOnTestRole = await attempt(chains('Approver', ['Tester', 'Approver']));
  assert.match(runOnTestRole.result.error, /"Approver" role for this scope/, 'a run is signed on the Test Execution type');
  assert.equal(versionOnExecutionRole.saved.length + runOnTestRole.saved.length, 0, 'a refused save changes nothing');

  const off = await attempt({ ...chains('Nobody', ['Nobody']), enabled: false });
  assert.equal(off.result.success, true, 'turning off never waits on a grant');
});

test('Verifies uses a stable existing type distinct from generic bug links', async () => {
  for (const [sourceLinkTypeId, expected] of [['10', true], ['20', false], ['999', false]]) {
    const { deps, saved } = world();
    deps.tm.linkTypes = async () => [{ id: '10', name: 'Verifies' }, { id: '20', name: 'Relates' }];
    const result = await saveTestManagementConfig(request(payload({ sourceLinkTypeId })), deps);
    assert.equal(result.success, expected, result.error);
    assert.equal(saved.length, expected ? 1 : 0);
    if (expected) assert.equal(saved[0].sourceLinkTypeId, '10');
  }
});

test('signed source history prevents changing or clearing the native Verifies type', async () => {
  for (const sourceLinkTypeId of ['11', null]) {
    const { deps, saved } = world({ existing: { ...enabledConfig, sourceLinkTypeId: '10' } });
    deps.tm.linkTypes = async () => [{ id: '10', name: 'Verifies' }, { id: '11', name: 'Other verifies' }, { id: '20', name: 'Relates' }];
    const original = deps.executeQuery;
    deps.executeQuery = async (sql, params) => sql.includes('FROM tm_source_association')
      ? { result: true, data: [{ version_id: 'a'.repeat(32) }] } : original(sql, params);
    const result = await saveTestManagementConfig(request(payload({ sourceLinkTypeId, expectedRevision: 3 })), deps);
    assert.equal(result.success, false);
    assert.match(result.error, /preserve their native Jira relationship identity/);
    assert.equal(saved.length, 0);
  }
});

test('test management is not switched off, nor a type unmapped, while that type\'s work items sit under a parent', async () => {
  const off = world({ existing: enabledConfig, parented: { 1: { ids: ['11', '12'], complete: true } } });
  const refused = await saveTestManagementConfig(request(payload({ enabled: false, expectedRevision: 3 })), off.deps);
  assert.equal(refused.success, false);
  assert.match(refused.error, /^2 Test work items in this project sit under a parent/);
  assert.equal(off.saved.length, 0);

  const remap = world({ existing: enabledConfig, parented: { 2: { ids: [], complete: false } } });
  const remapped = await saveTestManagementConfig(request(payload({ executionTypeId: '7', expectedRevision: 3 })), remap.deps);
  assert.match(remapped.error, /^more than 500 Test Execution work items/, 'an incomplete search is never taken as none');

  const free = world({ existing: enabledConfig });
  const ok = await saveTestManagementConfig(request(payload({ enabled: false, expectedRevision: 3 })), free.deps);
  assert.equal(ok.success, true, ok.error);
  assert.equal(free.saved[0].enabled, false);
});

test('the author rule is saved only when switched on explicitly, and is part of the audited configuration', async () => {
  const off = world();
  assert.equal((await saveTestManagementConfig(request(payload()), off.deps)).success, true);
  assert.equal(off.saved[0].authorSeparation, false, 'absent means off, never a guess');
  const on = world();
  assert.equal((await saveTestManagementConfig(request(payload({ authorSeparation: true })), on.deps)).success, true);
  assert.equal(on.saved[0].authorSeparation, true);
  const truthy = world();
  await saveTestManagementConfig(request(payload({ authorSeparation: 'yes' })), truthy.deps);
  assert.equal(truthy.saved[0].authorSeparation, false, 'only a real true switches it on');
});
