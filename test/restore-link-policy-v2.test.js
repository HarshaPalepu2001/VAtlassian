import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { project } from '../src/lib/content.js';
import { findLinkConflicts } from '../src/lib/restore/linkConflicts.js';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';
import { serialiseLinkPolicy } from '../src/lib/linkPolicy.js';
import { treeLinkPolicyResolver } from '../src/lib/linkPolicy.js';
import { logicalNodeId } from '../src/lib/tree/model.js';
import { approvedLinksResolver } from '../src/db/approvedLinks.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'test:policy-forge', shortCircuit: true };
    if (specifier.endsWith('/db/restoreStore.js')) return { url: 'test:policy-restore-store', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:policy-forge') return { format: 'module', shortCircuit: true,
      source: 'export const route=(s,...v)=>s.reduce((a,b,i)=>a+b+(v[i]??""),"");' };
    if (url === 'test:policy-restore-store') return { format: 'module', shortCircuit: true, source: 'export async function declareWrite(){}' };
    return next(url, context);
  }
});
const { createRestoreAdapters } = await import('../src/lib/tree/restoreAdapters.js');
const { executeRestore } = await import('../src/lib/restore/executor.js');
const { verifyRestore } = await import('../src/lib/restore/verifier.js');
hooks.deregister();

const policy = { version: 2, verifiesTypeId: '90', testTypes: [{ projectId: 1, issueTypeId: '20' }], internalTypeIds: ['91'] };
const fields = [{ field_id: 'issuelinks', field_name: 'Links', field_kind: 'LINKS', store_values: true }];
const source = { id: '10', key: 'P-10', fields: { project: { id: '1' }, issuetype: { id: '30' }, parent: null } };
const testIssue = { id: '11', key: 'P-11', fields: { project: { id: '1' }, issuetype: { id: '20' }, parent: null } };
const verifiesOnSource = { id: '100', type: { id: '90' }, inwardIssue: testIssue };
const verifiesOnTest = { id: '100', type: { id: '90' }, outwardIssue: source };
const response = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const route = (s, ...v) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '');
function jira(issue, links) {
  const writes = [], reads = [];
  const requestJira = async (path, options = {}) => {
    if (options.method) { writes.push({ path: String(path), ...options }); return response(204); }
    reads.push(String(path));
    if (String(path).includes('/issue/11?')) return response(200, testIssue);
    if (String(path).includes('/issue/10?')) return response(200, { ...source, fields: { ...source.fields, issuelinks: links } });
    return response(200, { ...issue, fields: { ...issue.fields, issuelinks: links } });
  };
  return { api: { asApp: () => ({ requestJira }) }, writes, reads };
}

test('source restore leaves both present and absent excluded relationships untouched', async () => {
  for (const [current, desired] of [[[verifiesOnSource], []], [[], [verifiesOnSource]]]) {
    const world = jira(source, current);
    const adapters = createRestoreAdapters({ api: world.api, route, linkPolicy: policy });
    await adapters.restoreLinks(source.id, desired);
    assert.deepEqual(world.writes, []);
  }
});

test('legacy source restore still restores all links and v2 hydrates omitted Test metadata', async () => {
  const legacy = jira(source, [verifiesOnSource]);
  await createRestoreAdapters({ api: legacy.api, route }).restoreLinks(source.id, []);
  assert.equal(legacy.writes.length, 1);
  const current = { ...verifiesOnSource, inwardIssue: { id: testIssue.id } };
  const modern = jira(source, [current]);
  await createRestoreAdapters({ api: modern.api, route, linkPolicy: policy }).restoreLinks(source.id, []);
  assert.deepEqual(modern.writes, []);
  assert.equal(modern.reads.filter(path => path.includes('/issue/11?')).length, 1);
});

test('flat restore preserves excluded links using the same stored policy', async () => {
  const world = jira(source, [verifiesOnSource]);
  const result = await executeRestore({ api: world.api, issueKey: source.key, issueId: 10, issue: source,
    controlledFields: fields, linkPolicy: policy, plan: { fieldWrites: {}, steps: [
      { strategy: 'links', fieldId: 'issuelinks', fieldName: 'Links', targetValue: [] }
    ] } });
  assert.deepEqual(world.writes, []);
  assert.equal(result.detail[0].outcome, 'succeeded');
});

test('an excluded other endpoint is no opinion, including when its link values were not retained', async () => {
  const resolve = approvedLinksResolver({}, {
    activeBaseline: async () => ({ issue_id: 10, project_id: 1, issue_type_id: '30', version: 1,
      field_digests: JSON.stringify({ issuelinks: 'digest' }), link_policy: serialiseLinkPolicy(policy) }),
    readAllValues: async () => ({}), activeRootsForNode: async () => []
  });
  assert.deepEqual(await findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
    additions: [verifiesOnTest], approvedLinksOf: resolve }), []);
  assert.deepEqual(await findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
    removals: [verifiesOnTest], approvedLinksOf: resolve }), []);
});

test('an included link whose approved values are unavailable still fails closed', async () => {
  const descriptor = { links: null, issue: source, linkPolicy: policy };
  await assert.rejects(findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
    additions: [{ ...verifiesOnTest, type: { id: '92' } }], approvedLinksOf: async () => descriptor }), { code: 'LINK_CONFLICT' });
});

test('a v2 in-tree node that does not track links has no opinion on an ordinary relationship', async () => {
  for (const values of [{}, { issuelinks: [] }]) {
    const resolve = approvedLinksResolver({ baselineTree: {
      nodes: [{ logicalNodeId: 'source', currentIssueId: 10, projectId: 1, issueTypeId: '30',
        fieldDigests: JSON.stringify({ summary: 'digest' }), linkPolicy: policy }],
      values: { source: values }
    } });
    assert.equal(await resolve(source.id), null);
    assert.deepEqual(await findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
      additions: [{ ...verifiesOnTest, type: { id: '92' } }], approvedLinksOf: resolve }), []);
  }
});

test('a tracked v2 in-tree node without retained links excludes Verifies but refuses an ordinary relationship', async () => {
  const resolve = approvedLinksResolver({ baselineTree: {
    nodes: [{ logicalNodeId: 'source', currentIssueId: 10, projectId: 1, issueTypeId: '30',
      fieldDigests: JSON.stringify({ issuelinks: 'digest' }), linkPolicy: policy }],
    values: { source: {} }
  } });
  assert.deepEqual(await findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
    additions: [verifiesOnTest], approvedLinksOf: resolve }), []);
  await assert.rejects(findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
    additions: [{ ...verifiesOnTest, type: { id: '92' } }], approvedLinksOf: resolve }), { code: 'LINK_CONFLICT' });
});

test('tree verification honors frozen per-node policy and detects manual Test link changes', async () => {
  const baselineNode = issue => ({ logicalNodeId: logicalNodeId(issue.id), originalIssueId: Number(issue.id), currentIssueId: Number(issue.id),
    issueKey: issue.key, parentLogicalNodeId: null, parentLogicalId: null, projectId: 1, issueTypeId: issue.fields.issuetype.id,
    linkPolicy: policy, digests: project({ ...issue.fields, issuelinks: [] }, fields, { issue, linkPolicy: policy }).digests });
  for (const [issue, links, matches] of [[source, [verifiesOnSource], true], [testIssue, [verifiesOnTest], false]]) {
    const live = { ...issue, fields: { ...issue.fields, issuelinks: links } };
    const verified = await verifyTreeRestore({ rootIssueKey: issue.key, controlledFields: fields,
      baselineTree: { nodes: [baselineNode(issue)] }, readTree: async () => {}, readStableTree: async () => ({ tree: { nodes: [live] } }) });
    assert.equal(verified.matches, matches);
  }
});

test('a replacement child restores its own stored v1 links rather than inheriting the v2 root policy', async () => {
  const world = jira(source, [verifiesOnSource]);
  const policyFor = treeLinkPolicyResolver({ linkPolicy: policy, nodes: [
    { logicalNodeId: 'old-child', originalIssueId: 99, linkPolicy: { version: 1 } }
  ] });
  const adapters = createRestoreAdapters({ api: world.api, route,
    policyForIssue: (issue, context) => policyFor({ ...issue, logicalNodeId: context?.logicalNodeId }) });
  await adapters.restoreLinks(source.id, [], { logicalNodeId: 'old-child' });
  assert.equal(world.writes.length, 1);
  assert.equal(world.writes[0].method, 'DELETE');
});

test('v2 verification requests authoritative endpoint scope and fails closed if it cannot read link metadata', async () => {
  let requested;
  const node = { logicalNodeId: 'source', originalIssueId: 10, issueKey: source.key, parentLogicalId: null,
    linkPolicy: policy, digests: project({ ...source.fields, issuelinks: [] }, fields, { issue: source, linkPolicy: policy }).digests };
  const result = await verifyTreeRestore({ rootIssueKey: source.key, controlledFields: fields,
    baselineTree: { nodes: [node] }, readTree: async () => {}, readStableTree: async args => {
      requested = args.fieldIds;
      return { tree: { nodes: [{ ...source, fields: { ...source.fields, issuelinks: [
        { ...verifiesOnSource, inwardIssue: { id: '11' } }
      ] } }] } };
    }, readIssue: async () => { throw new Error('unavailable'); } });
  assert.equal(result.matches, false);
  assert.equal(result.unmatched[0].kind, 'READ_FAILED');
  assert.equal(requested.includes('project'), true);
  assert.equal(requested.includes('issuetype'), true);
});

test('flat verification compares the same stored policy as execution and keeps Test-owned links governed', async () => {
  for (const [issue, links, unmatched] of [[source, [verifiesOnSource], 0], [testIssue, [verifiesOnTest], 1]]) {
    const world = jira(issue, links);
    const baselineDigests = project({ ...issue.fields, issuelinks: [] }, fields, { issue, linkPolicy: policy }).digests;
    const result = await verifyRestore({ api: world.api, issueKey: issue.key, controlledFields: fields,
      baselineDigests, linkPolicy: policy, detail: [], readIdentity: async () => null });
    assert.equal(result.unmatched.length, unmatched);
  }
});

test('v2 Test endpoint and v1 source endpoint still enforce their signed link lists', async () => {
  const toTest = await findLinkConflicts({ selfIssueId: source.id, selfIssue: source,
    additions: [verifiesOnSource], approvedLinksOf: async () => ({ links: [], issue: testIssue, linkPolicy: policy }) });
  assert.equal(toTest.length, 1);
  const toLegacy = await findLinkConflicts({ selfIssueId: testIssue.id, selfIssue: testIssue,
    additions: [verifiesOnTest], approvedLinksOf: async () => [] });
  assert.equal(toLegacy.length, 1);
});

test('unreadable linked endpoint metadata refuses a v2 restore before any Jira mutation', async () => {
  const writes = [];
  const api = { asApp: () => ({ requestJira: async (path, options = {}) => {
    if (options.method) { writes.push(options); return response(204); }
    return String(path).includes('/issue/10?')
      ? response(200, { ...source, fields: { ...source.fields, issuelinks: [{ ...verifiesOnSource, inwardIssue: { id: '11' } }] } })
      : response(403);
  } }) };
  await assert.rejects(createRestoreAdapters({ api, route, linkPolicy: policy }).restoreLinks(source.id, []));
  assert.deepEqual(writes, []);
});
