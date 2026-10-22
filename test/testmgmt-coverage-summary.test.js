import test from 'node:test';
import assert from 'node:assert/strict';
import { contentDigest } from '../src/testmgmt/content.js';

const sourcesModule = await import('../src/testmgmt/sources.js').catch(() => ({}));
const coverageModule = await import('../src/usecases/testCoverage.js').catch(() => ({}));
const summaryModule = await import('../src/usecases/testSummary.js').catch(() => ({}));
const actor = { accountId: 'qa-1' };
const H = 'a'.repeat(64), B = 'b'.repeat(32);
const clone = value => structuredClone(value);
const source = { issueId: '21', issueKey: 'VAT-21', projectId: '100', siteId: 'site-1', sourceDigest: H,
  baseline: { id: B, version: 1, hash: H }, governedReady: true, drifted: false };
function needFactory(module, name) { assert.equal(typeof module[name], 'function', `${name} must exist`); return module[name]; }
function fixture() {
  const version = { versionId: '1'.repeat(32), testIssueId: '11', projectId: '100', state: 'SIGNED', versionNo: 1,
    signedAt: 1, content: { objective: 'Verify pressure', preconditions: '', steps: [{ id: 's1', action: 'Read', data: '', expected: '10' }],
      verifies: [clone(source)] } };
  version.digest = contentDigest(version.content);
  const run = { runId: '2'.repeat(32), testIssueId: '11', executionIssueId: '12', projectId: '100',
    testVersionId: version.versionId, testDigest: version.digest, state: 'SIGNED', result: 'PASSED',
    configuration: 'ECU B', environment: 'bench', release: { id: '7', name: '1.0' }, createdAt: 1, updatedAt: 2,
    steps: [{ id: 's1', status: 'PASSED', evidence: [{ attachmentId: '5', sha256: H, size: 2, retainedKey: 'vault/5' }] }] };
  const state = { version, runs: [run], source: clone(source), evidence: true, proof: true, complete: true, hidden: new Set(),
    bug: { ok: true, blocking: false }, planning: { ok: true }, frozen: [] };
  const issue = id => ({ id, key: `VAT-${id}`, fields: { summary: id === '11' ? 'Pressure test' : 'Execution',
    project: { id: '100' }, issuetype: { id: id === '11' ? '1' : '2' } } });
  const deps = {
    now: () => 123, newHexId: () => 'f'.repeat(32),
    readIssueAsUser: async id => { if (state.hidden.has(String(id))) throw Object.assign(new Error('hidden'), { reason: 'NOT_FOUND' }); return issue(String(id).replace('VAT-', '')); },
    readProject: async () => ({ enabled: true, projectId: '100', testTypeId: '1', executionTypeId: '2', partlyPassedCounts: false }),
    testManagementRole: async item => ({ role: item.fields.issuetype.id === '1' ? 'TEST' : 'EXECUTION', project: { enabled: true, projectId: '100' } }),
    latestSignedVersion: async () => clone(state.version), readVersion: async id => id === state.version.versionId ? clone(state.version) : null,
    readDraft: async () => null,
    readRunsForTestComplete: async () => ({ records: clone(state.runs), complete: state.complete }),
    readRunsForExecutionComplete: async () => ({ records: clone(state.runs), complete: state.complete }),
    resolveTestSources: async () => { if (state.hidden.has('21')) throw Object.assign(new Error('hidden'), { reason: 'SOURCE_UNAVAILABLE' }); return [clone(state.source)]; },
    verifyEvidence: async () => ({ ok: state.evidence }), verifyRunProof: async () => ({ ok: state.proof }),
    readBlockingDefects: async () => state.bug,
    verifySourceLinkProjection: async () => ({ ok: true }),
    validateRunPlanningSnapshot: async () => state.planning,
    readSourcesForTest: async () => ({ records: [clone(source)], complete: true }),
    readTestsForSource: async () => ({ records: [{ testIssueId: '11' }], complete: true }),
    insertExecutionSummary: async summary => { state.frozen.push(clone(summary)); return true; },
    readExecutionSummary: async () => clone(state.frozen[0]), audit: async () => {}
  };
  return { state, deps, run };
}

test('source selection refuses hidden, cross-project, and foreign-site references without metadata', async () => {
  const create = needFactory(sourcesModule, 'createTestSources');
  const deps = { siteIdentity: async () => 'site-1', readIssueAsUser: async id => {
    if (id === '22') throw new Error('restricted-title');
    return { id, key: 'RESTRICTED-TITLE', fields: { project: { id: id === '23' ? '200' : '100' } } };
  }, getSourceState: async () => ({ sourceDigest: H, baseline: null, complete: true, drifted: false }) };
  const uc = create(deps);
  for (const refs of [[{ issueId: '22' }], [{ issueId: '23' }], [{ issueId: '21', siteId: 'foreign-site' }]]) {
    await assert.rejects(() => uc.resolveTestSources(refs, { projectId: '100', viewer: actor }), error => error.reason === 'SOURCE_UNAVAILABLE' && !error.message.includes('RESTRICTED'));
  }
  const [resolved] = await uc.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: actor });
  assert.equal(resolved.sourceDigest, H); assert.equal(resolved.governedReady, false); assert.equal(resolved.siteId, 'site-1');
});

test('source validation re-reads exact digest and approved baseline identity', async () => {
  const create = needFactory(sourcesModule, 'createTestSources');
  let current = clone(source);
  const uc = create({ siteIdentity: async () => 'site-1', readIssueAsUser: async () => ({ id: '21', key: 'VAT-21', fields: { project: { id: '100' } } }),
    getSourceState: async () => ({ ...current, complete: true }) });
  assert.equal((await uc.validateTestSources([source], { projectId: '100', viewer: actor })).length, 1);
  current.baseline.id = 'c'.repeat(32);
  await assert.rejects(() => uc.validateTestSources([source], { projectId: '100', viewer: actor }), { reason: 'SOURCE_CHANGED' });
});

test('coverage counts a fully proved pass for operational and governed coverage', async () => {
  const { deps } = fixture(); const uc = needFactory(coverageModule, 'createTestCoverage')(deps);
  const model = await uc.forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.complete, true); assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].operational, 'VERIFIED'); assert.equal(model.rows[0].governed, 'VERIFIED');
  assert.equal(model.rows[0].source.issueKey, 'VAT-21'); assert.equal(model.rows[0].runId, '2'.repeat(32));
});

test('SQL source associations alone cannot establish governed coverage without complete Jira link proof', async () => {
  const { deps } = fixture(); delete deps.verifySourceLinkProjection;
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].governed, 'UNKNOWN');
  assert.equal(model.rows[0].operational, 'VERIFIED');
  assert.ok(model.rows[0].reasons.includes('SOURCE_LINK_PROOF_UNAVAILABLE'));
});

for (const terminal of ['REJECTED', 'NOT_EXECUTED']) test(`newer ${terminal} never falls back to an older passed run`, async () => {
  const { deps, state, run } = fixture(); state.runs.push({ ...run, runId: '3'.repeat(32), state: terminal, createdAt: 3, updatedAt: 4 });
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].operational, 'NOT_VERIFIED'); assert.equal(model.rows[0].governed, 'NOT_VERIFIED');
  assert.equal(model.rows[0].runId, '3'.repeat(32));
});

test('coverage partitions the latest terminal result by environment as well as test configuration and release', async () => {
  const { deps, state, run } = fixture(); state.runs.push({ ...run, runId: '3'.repeat(32), environment: 'vehicle', state: 'REJECTED', createdAt: 3 });
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows.length, 2); assert.equal(model.rows.filter(row => row.operational === 'VERIFIED').length, 1);
});

for (const failure of ['hidden source', 'changed source', 'source drift', 'changed test', 'plan changed', 'dataset changed', 'blocking defect', 'missing evidence', 'incomplete signatures', 'truncated runs']) {
  test(`coverage refuses green with ${failure}`, async () => {
    const { deps, state } = fixture();
    if (failure === 'hidden source') state.hidden.add('21');
    if (failure === 'changed source') state.source.sourceDigest = 'd'.repeat(64);
    if (failure === 'source drift') state.source.drifted = true;
    if (failure === 'changed test') { state.version.versionId = '4'.repeat(32); state.version.versionNo = 2; state.version.content.objective = 'New intent'; state.version.digest = contentDigest(state.version.content); }
    if (failure === 'plan changed') state.planning = { ok: true, current: false, reason: 'PLAN_CHANGED' };
    if (failure === 'dataset changed') state.planning = { ok: false, reason: 'DATASET_CHANGED' };
    if (failure === 'blocking defect') state.bug = { ok: true, blocking: true };
    if (failure === 'missing evidence') state.evidence = false;
    if (failure === 'incomplete signatures') state.proof = false;
    if (failure === 'truncated runs') state.complete = false;
    const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
    assert.ok(model.rows.every(row => row.operational !== 'VERIFIED' && row.governed !== 'VERIFIED'));
    if (failure === 'hidden source') assert.ok(!JSON.stringify(model).includes('VAT-21'));
  });
}

test('operational coverage does not require a baseline but governed coverage does', async () => {
  const { deps, state } = fixture(); state.source.baseline = null; state.source.governedReady = false;
  state.version.content.verifies = [clone(state.source)]; state.version.digest = contentDigest(state.version.content);
  state.runs[0].testDigest = state.version.digest;
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].operational, 'VERIFIED'); assert.equal(model.rows[0].governed, 'UNKNOWN');
});

test('source coverage hides inaccessible tests and marks incomplete', async () => {
  const { deps, state } = fixture(); state.hidden.add('11');
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forSource({ issueKey: 'VAT-21' }, actor);
  assert.equal(model.complete, false); assert.deepEqual(model.rows, []);
  assert.ok(!JSON.stringify(model).includes('Pressure test'));
});

test('execution summary freezes server-read content and supplies digest-bound human and JSON downloads', async () => {
  const { deps, state } = fixture(); const uc = needFactory(summaryModule, 'createTestSummary')(deps);
  const result = await uc.generate({ issueKey: 'VAT-12', runs: [{ result: 'invented' }] }, actor);
  assert.equal(result.completeness, 'COMPLETE'); assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.snapshot.runs[0].result, 'PASSED');
  assert.equal(JSON.parse(result.downloads.json.content).digest, result.digest);
  assert.match(result.downloads.human.content, /Pressure test/); assert.match(result.downloads.human.content, /PASSED/);
  state.runs[0].result = 'FAILED';
  assert.equal(state.frozen[0].snapshot.runs[0].result, 'PASSED');
  assert.equal(contentDigest(result.snapshot), result.digest);
});

for (const failure of ['hidden test', 'evidence failure', 'truncation', 'unsigned terminal']) test(`summary marks ${failure} INCOMPLETE`, async () => {
  const { deps, state } = fixture();
  if (failure === 'hidden test') state.hidden.add('11');
  if (failure === 'evidence failure') state.evidence = false;
  if (failure === 'truncation') state.complete = false;
  if (failure === 'unsigned terminal') state.proof = false;
  const model = await needFactory(summaryModule, 'createTestSummary')(deps).generate({ issueKey: 'VAT-12' }, actor);
  assert.equal(model.completeness, 'INCOMPLETE'); assert.ok(model.snapshot.problems.length > 0);
  if (failure === 'hidden test') assert.ok(!JSON.stringify(model).includes('Pressure test'));
});

test('a source change marks the definition Suspect before any run exists', async () => {
  const { deps, state } = fixture(); state.runs = []; state.source.sourceDigest = 'd'.repeat(64);
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows.length, 1); assert.equal(model.rows[0].suspect, true);
  assert.equal(model.rows[0].governed, 'UNKNOWN'); assert.equal(model.rows[0].runId, null);
});

test('missing defect authorization cannot become a verified pass', async () => {
  const { deps } = fixture(); delete deps.readBlockingDefects;
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].operational, 'UNKNOWN'); assert.ok(model.rows[0].reasons.includes('DEFECT_STATUS_UNAVAILABLE'));
});

test('a frozen summary cannot be downloaded after a contained test becomes hidden', async () => {
  const { deps, state } = fixture(); const uc = needFactory(summaryModule, 'createTestSummary')(deps);
  const result = await uc.generate({ issueKey: 'VAT-12' }, actor); state.hidden.add('11');
  await assert.rejects(() => uc.read({ summaryId: result.summaryId }, actor), { reason: 'NOT_FOUND' });
});

const storeModule = await import('../src/testmgmt/reportStore.js').catch(() => ({}));
test('complete report reads use one extra row and explicitly mark truncation', async () => {
  const create = needFactory(storeModule, 'createReportStore');
  let queried = '';
  const store = create({ query: async sql => { queried = sql; return { result: true, data: [{ run_id: '1'.repeat(32), steps: '[]' }, { run_id: '2'.repeat(32), steps: '[]' }, { run_id: '3'.repeat(32), steps: '[]' }] }; }, maxRecords: 2 });
  const rows = await store.readRunsForTestComplete('11');
  assert.equal(rows.complete, false); assert.equal(rows.records.length, 2); assert.match(queried, /LIMIT 3/);
});

test('source projection refuses a previously signed version with a missing association', async () => {
  const create = needFactory(storeModule, 'createReportStore');
  const store = create({ query: async sql => ({ result: true, data: sql.includes('SELECT v.version_id') ? [{ version_id: '1'.repeat(32) }] : [] }) });
  const result = await store.readTestsForSource('21', { projectId: '100' });
  assert.equal(result.complete, false);
});

test('report SQL failures throw rather than pretend a list was complete', async () => {
  const create = needFactory(storeModule, 'createReportStore');
  const store = create({ query: async () => ({ result: false, error: new Error('down') }) });
  await assert.rejects(() => store.readRunsForExecutionComplete('12'), { reason: 'SERVICE_UNAVAILABLE' });
});

test('signed source projection is complete only after every pinned source is retained', async () => {
  const create = needFactory(sourcesModule, 'createTestSources'); const { state } = fixture();
  const events = [];
  const deps = { verifyVersionProof: async () => ({ ok: true }), beginSignedSourceProjection: async () => events.push('begin'),
    insertSignedSourceAssociation: async row => { events.push(row.source.issueId); throw new Error('write interrupted'); },
    finishSignedSourceProjection: async () => events.push('complete') };
  await assert.rejects(() => create(deps).recordSignedSources(state.version), /write interrupted/);
  assert.deepEqual(events, ['begin', '21']);
});

test('signed source projection cannot accept an unconfirmed version', async () => {
  const create = needFactory(sourcesModule, 'createTestSources'); const { state } = fixture();
  const uc = create({ insertSignedSourceAssociation: async () => { throw new Error('must not write'); } });
  await assert.rejects(() => uc.recordSignedSources(state.version), { reason: 'SOURCE_CHANGED' });
});

test('report writes preserve idempotent zero-change successes', async () => {
  const create = needFactory(storeModule, 'createReportStore');
  const store = create({ query: async () => ({ result: true, data: { affectedRows: 0 } }) });
  const { state } = fixture();
  await store.beginSignedSourceProjection({ ...state.version, signedAt: 1 });
});

test('dataset metadata does not hide expanded step evidence from integrity verification', () => {
  assert.equal(typeof coverageModule.createTestCoverage, 'function');
  const { run } = fixture(); run.iterations = [{ id: 'i1', values: { pressure: '10' }, stepIds: ['s1'] }];
  // The root execution model stores results in steps; iteration metadata has no steps property.
  return import('../src/testmgmt/coverage.js').then(module => assert.equal(module.flattenedEvidence(run).length, 1));
});

test('summary retains expanded dataset steps and the exact planning snapshot', async () => {
  const { deps, state } = fixture();
  state.runs[0].resolvedSteps = [{ id: 'i1-s1', action: 'Read 10 bar', expected: '10' }];
  state.runs[0].planningSnapshot = { plan: { planRevisionId: '7'.repeat(32), digest: H }, preconditions: [{ key: 'safety', text: 'Power isolated' }], datasetDigest: H };
  const model = await needFactory(summaryModule, 'createTestSummary')(deps).generate({ issueKey: 'VAT-12' }, actor);
  assert.deepEqual(model.snapshot.runs[0].resolvedSteps, state.runs[0].resolvedSteps);
  assert.deepEqual(model.snapshot.runs[0].planningSnapshot, state.runs[0].planningSnapshot);
});

test('governed source readback cannot green a tree when only root fields were checked', () => {
  const derive = needFactory(sourcesModule, 'sourceStateFromReadback');
  const result = derive({ issue: { id: '21', fields: { project: { id: '100' } } },
    baseline: { baseline_id: B, version: 1, content_hash: H, tree_hash: H },
    review: { baseline_id: B, baseline_version: 1, project_id: '100', state: 'BASELINED' },
    comparison: { changed: [], contentHash: H, diagnostics: { baselineReadable: true } } });
  assert.equal(result.governedReady, false); assert.equal(result.drifted, true);
});

test('governed source uses a complete fresh tree hash and flags descendant change', () => {
  const derive = needFactory(sourcesModule, 'sourceStateFromReadback');
  const input = { issue: { id: '21', fields: { project: { id: '100' } } },
    baseline: { baseline_id: B, version: 1, content_hash: H, tree_hash: H },
    review: { baseline_id: B, baseline_version: 1, project_id: '100', state: 'BASELINED' },
    comparison: { changed: [], contentHash: H, diagnostics: { baselineReadable: true } },
    tree: { complete: true, baselineId: B, contentHash: H, driftCount: 0 } };
  assert.equal(derive(input).governedReady, true);
  input.tree.contentHash = 'd'.repeat(64); input.tree.driftCount = 1;
  assert.equal(derive(input).sourceDigest, 'd'.repeat(64)); assert.equal(derive(input).drifted, true);
});

test('unchanged editable source identity does not drift against signed server-derived source metadata', async () => {
  const { deps, state } = fixture(); deps.readDraft = async () => ({ content: { objective: state.version.content.objective,
    preconditions: '', steps: state.version.content.steps, verifies: [{ issueId: '21', issueKey: 'VAT-21' }], dataset: null } });
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].operational, 'VERIFIED');
});

test('a closed prior defect still requires passing retest provenance', async () => {
  const { deps, state } = fixture(); state.bug = { ok: true, blocking: false, retestValid: false };
  const model = await needFactory(coverageModule, 'createTestCoverage')(deps).forTest({ issueKey: 'VAT-11' }, actor);
  assert.equal(model.rows[0].operational, 'UNKNOWN'); assert.ok(model.rows[0].reasons.includes('PASSING_RETEST_REQUIRED'));
});

test('projection readback requires completed header and every expected source row including zero-reference versions', async () => {
  const create = needFactory(storeModule, 'createReportStore');
  let complete = 0, actualCount = 0, expectedCount = 0;
  const store = create({ query: async () => ({ result: true, data: [{ complete, expected_count: expectedCount, actual_count: actualCount }] }) });
  assert.equal(await store.sourceProjectionComplete('1'.repeat(32)), false);
  complete = 1; assert.equal(await store.sourceProjectionComplete('1'.repeat(32)), true);
  expectedCount = 2; actualCount = 1; assert.equal(await store.sourceProjectionComplete('1'.repeat(32)), false);
});
