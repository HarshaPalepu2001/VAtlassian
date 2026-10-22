import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestSources } from '../src/testmgmt/sources.js';
import { contentDigest } from '../src/testmgmt/content.js';
const runtimeModule = await import('../src/testmgmt/sourceRuntime.js');
const actor = { accountId: 'viewer' };
const H = 'a'.repeat(64), B = 'b'.repeat(32);
const policy = { version: 2, verifiesTypeId: '10', testTypes: [{ projectId: 100, issueTypeId: '1' }], internalTypeIds: [] };
const issue = (id = '21', type = '7') => ({ id, key: `VAT-${id}`, fields: { project: { id: '100' }, issuetype: { id: type },
  summary: 'Supply accepts operating voltage', description: '12 to 24 V', updated: '2026-10-21T10:00:00Z', lastViewed: '2026-10-21T10:01:00Z', issuelinks: [] } });
const verifies = (id = '11', direction = 'inwardIssue') => ({ id: `link-${id}`, type: { id: '10', name: 'Verifies' }, [direction]: { id, key: `VAT-${id}`, fields: { summary: 'Test or manual source' } } });
function reader(extra = {}) {
  assert.equal(typeof runtimeModule.createSourceStateReader, 'function', 'production source-state reader is directly testable');
  const reads = [];
  const deps = { activeBaseline: async () => null, getReview: async () => null, resolveLinkPolicy: async () => policy,
    readPolicyEndpoint: async (id, viewer) => { reads.push({ id, viewer }); return issue(id, id === '11' ? '1' : '7'); },
    fieldScope: async () => ({ fields: [] }), baselineDrift: async () => ({ contentHash: H, changed: [], diagnostics: { baselineReadable: true } }),
    ...extra };
  return { get: runtimeModule.createSourceStateReader(deps), reads, deps };
}

test('production unbaselined source fallback ignores a mirrored Test Verifies link and transport timestamps', async () => {
  const f = reader(); const source = issue();
  const before = await f.get(source, { viewer: actor });
  const mirrored = structuredClone(source); mirrored.fields.issuelinks = [verifies()];
  mirrored.fields.updated = '2026-10-21T11:00:00Z'; mirrored.fields.lastViewed = '2026-10-21T11:02:00Z';
  const after = await f.get(mirrored, { viewer: actor });
  assert.equal(after.sourceDigest, before.sourceDigest); assert.equal(after.complete, true); assert.equal(after.baseline, null);
  assert.equal(after.governedReady, false); assert.equal(after.drifted, false);
  assert.deepEqual(f.reads, [{ id: '11', viewer: actor }], 'endpoint classification follows viewer-authorized read');
  assert.equal(mirrored.fields.issuelinks[0].inwardIssue.fields.project, undefined, 'readback is not mutated');
});

test('unbaselined fallback still detects source content and unrelated manual relationship changes', async () => {
  const f = reader(); const original = issue(); const before = await f.get(original, { viewer: actor });
  for (const change of [
    source => { source.fields.description = 'New acceptance criterion'; },
    source => { source.fields.issuelinks.push({ id: 'manual', type: { id: '20', name: 'Relates' }, outwardIssue: { id: '99' } }); },
    source => { source.fields.issuelinks.push(verifies('99')); }
  ]) {
    const current = structuredClone(original); change(current);
    assert.notEqual((await f.get(current, { viewer: actor })).sourceDigest, before.sourceDigest);
  }
});

test('a Test retains ownership of its outgoing Verifies even without a native baseline', async () => {
  const f = reader(); const testIssue = issue('11', '1');
  const before = await f.get(testIssue, { viewer: actor });
  testIssue.fields.issuelinks = [verifies('21', 'outwardIssue')];
  assert.notEqual((await f.get(testIssue, { viewer: actor })).sourceDigest, before.sourceDigest);
  assert.equal(f.reads.length, 0, 'a Test owns Verifies without hydrating away the other endpoint');
});

test('baselined sources retain their stored policy and never resolve today\'s fallback policy', async () => {
  const baseline = { baseline_id: B, version: 1, content_hash: H, link_policy: null };
  let compared;
  const f = reader({ activeBaseline: async () => baseline,
    getReview: async () => ({ baseline_id: B, baseline_version: 1, project_id: '100', state: 'BASELINED' }),
    resolveLinkPolicy: async () => { assert.fail('current configuration cannot reinterpret a stored baseline'); },
    baselineDrift: async input => { compared = input; return { contentHash: H, changed: [], diagnostics: { baselineReadable: true } }; } });
  const source = issue(); source.fields.issuelinks = [verifies()];
  const current = await f.get(source, { viewer: actor });
  assert.equal(compared.baseline, baseline); assert.equal(compared.issueFields, source.fields);
  assert.equal(current.sourceDigest, H); assert.equal(current.governedReady, true); assert.equal(f.reads.length, 0);
});

test('missing or invalid typed-link configuration blocks new source publication while legacy viewing stays readable', async () => {
  let configured = null; let sourceReads = 0;
  const sources = createTestSources({ siteIdentity: async () => 'site', readProject: async () => ({ sourceLinkTypeId: configured }),
    readIssueAsUser: async id => { sourceReads++; return issue(id); },
    getSourceState: async () => ({ complete: true, sourceDigest: H, baseline: null, drifted: false, governedReady: false }) });
  for (const bad of [null, '', 'Verifies', '0']) {
    configured = bad;
    await assert.rejects(sources.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: actor, requireTypedLinks: true }), { reason: 'SOURCE_LINK_TYPE_REQUIRED' });
  }
  assert.equal(sourceReads, 0, 'missing configuration fails before any selected-source metadata is read');
  configured = null;
  assert.equal((await sources.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: actor }))[0].linkTypeId, null);
  assert.deepEqual(await sources.resolveTestSources([], { projectId: '100', viewer: actor, requireTypedLinks: true }), []);
  configured = '10';
  const pinned = await sources.resolveTestSources([{ issueId: '21' }], { projectId: '100', viewer: actor, requireTypedLinks: true });
  assert.equal(pinned[0].linkTypeId, '10');
  configured = '20';
  await assert.rejects(sources.validateTestSources(pinned, { projectId: '100', viewer: actor }), { reason: 'SOURCE_CHANGED' });
});
