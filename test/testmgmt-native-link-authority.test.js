import test from 'node:test';
import assert from 'node:assert/strict';
const authority = await import('../src/testmgmt/nativeLinkAuthority.js').catch(() => ({}));
const H = 'a'.repeat(64), ID = Buffer.alloc(16, 1), ROOT = Buffer.alloc(16, 2);
const policy = { version: 2, verifiesTypeId: '90', testTypes: [{ projectId: 1, issueTypeId: '20' }], internalTypeIds: ['91'] };
const source = { id: '10', key: 'P-10', fields: { project: { id: '1' }, issuetype: { id: '30' } } };
const testIssue = { id: '11', key: 'P-11', fields: { project: { id: '1' }, issuetype: { id: '20' } } };
const onSource = { type: { id: '90' }, inwardIssue: testIssue };
const onTest = { type: { id: '90' }, outwardIssue: source };
const node = (own = source, extra = {}) => ({ logicalNodeId: `jira:${own.id}`, currentIssueId: Number(own.id), originalIssueId: Number(own.id),
  projectId: 1, issueTypeId: own.fields.issuetype.id, fieldDigests: JSON.stringify({ issuelinks: H }), ...extra });
function deps({ own = null, roots = [], trees = new Map(), baselines = new Map() } = {}) {
  return { activeBaseline: async () => own, activeRootsForNode: async () => roots,
    readBaselineTree: async id => trees.get(Buffer.isBuffer(id) ? id.toString('hex') : id) ?? null,
    baselineById: async id => baselines.get(Buffer.isBuffer(id) ? id.toString('hex') : id) ?? null };
}
function check(issue, link, injected) { assert.equal(typeof authority.endpointAllowsMirror, 'function', 'endpointAllowsMirror must exist'); return authority.endpointAllowsMirror({ issue, link }, injected); }
const root = id => ({ baselineId: id, rootIssueId: 1 });
const ownFlat = extra => ({ baseline_id: ID, issue_id: 10, project_id: 1, issue_type_id: '30', field_digests: JSON.stringify({ issuelinks: H }), ...extra });
const treeDeps = (nodes, linkPolicy = undefined, extra = {}) => deps({ roots: [root(ROOT)],
  trees: new Map([[ROOT.toString('hex'), { nodes, ...(linkPolicy ? { linkPolicy } : {}) }]]), ...extra });

test('an endpoint without its own or covering native baseline permits mirroring', async () => {
  assert.equal(await check(source, onSource, deps()), true);
});

test('a native legacy flat baseline that tracks links cannot be overridden by a SQL Test signature', async () => {
  assert.equal(await check(source, onSource, deps({ own: ownFlat() })), false);
});

test('legacy covering tree protects a child with no baseline of its own', async () => {
  assert.equal(await check(source, onSource, treeDeps([node()])), false);
});

test('a stored v2 source node exclusion permits the Test-owned Verifies mirror', async () => {
  assert.equal(await check(source, onSource, treeDeps([node(source, { linkPolicy: policy })])), true);
});

test('the native Test node still owns Verifies even under stored v2 policy', async () => {
  assert.equal(await check(testIssue, onTest, treeDeps([node(testIssue, { linkPolicy: policy })])), false);
});

test('an explicitly untracked links field is no opinion for a flat baseline or tree node', async () => {
  assert.equal(await check(source, onSource, deps({ own: ownFlat({ field_digests: JSON.stringify({ summary: H }) }) })), true);
  assert.equal(await check(source, onSource, treeDeps([node(source, { fieldDigests: JSON.stringify({ summary: H }) })])), true);
});

test('every covering tree must permit the link, not just the newest or first one', async () => {
  const d = deps({ roots: [root(ROOT), root(ID)], trees: new Map([
    [ROOT.toString('hex'), { nodes: [node(source, { linkPolicy: policy })] }], [ID.toString('hex'), { nodes: [node()] }]
  ]) });
  assert.equal(await check(source, onSource, d), false);
});

for (const failure of ['missing tree', 'unreadable tree', 'missing node', 'ambiguous node', 'malformed digest', 'missing digest', 'malformed policy', 'incomplete roots']) test(`protected ${failure} refuses the mutation`, async () => {
  const n = node(source, { linkPolicy: policy }); const d = treeDeps([n]);
  if (failure === 'missing tree') d.readBaselineTree = async () => null;
  if (failure === 'unreadable tree') d.readBaselineTree = async () => { throw new Error('storage down'); };
  if (failure === 'missing node') d.readBaselineTree = async () => ({ nodes: [node(testIssue, { linkPolicy: policy })] });
  if (failure === 'ambiguous node') d.readBaselineTree = async () => ({ nodes: [n, n] });
  if (failure === 'malformed digest') n.fieldDigests = '{broken';
  if (failure === 'missing digest') delete n.fieldDigests;
  if (failure === 'malformed policy') n.linkPolicy = { version: 7 };
  if (failure === 'incomplete roots') d.activeRootsForNode = async () => null;
  assert.equal(await check(source, onSource, d), false);
});

test('an own tree baseline must inspect its node rather than accepting the empty baseline digest map', async () => {
  const d = deps({ own: ownFlat({ tree_hash: H, field_digests: '{}' }),
    trees: new Map([[ID.toString('hex'), { nodes: [node()] }]]) });
  assert.equal(await check(source, onSource, d), false);
});

test('root baseline policy is read when no stored node or tree policy is available', async () => {
  let lookedUp = 0;
  const d = treeDeps([node()]);
  d.baselineById = async id => { lookedUp++; assert.deepEqual(id, ROOT); return ownFlat({ baseline_id: ROOT, issue_id: 1, link_policy: policy, state: 'ACTIVE' }); };
  assert.equal(await check(source, onSource, d), true); assert.equal(lookedUp, 1);
});

test('a stored v1 node override remains authoritative under a v2 covering tree', async () => {
  assert.equal(await check(source, onSource, treeDeps([node(source, { linkPolicy: { version: 1 } })], policy)), false);
});

test('a legacy node without current identity may match its original ID', async () => {
  assert.equal(await check(source, onSource, treeDeps([node(source, { currentIssueId: null, linkPolicy: policy })])), true);
});

test('a different current identity cannot authorize mutation on the replaced original issue', async () => {
  assert.equal(await check(source, onSource, treeDeps([node(source, { currentIssueId: 99, linkPolicy: policy })])), false);
});

test('generic Relates stays native governed while a frozen dedicated internal type is excluded', async () => {
  const d = treeDeps([node(source, { linkPolicy: policy })]);
  assert.equal(await check(source, { ...onSource, type: { id: '7', name: 'Relates' } }, d), false);
  assert.equal(await check(source, { ...onSource, type: { id: '91', name: 'Plan membership' } }, d), true);
});
