import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/content.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { serialiseLinkPolicy } from '../src/lib/linkPolicy.js';
import { linkDecisionJobs, deriveFlatRecord, deriveTreeRecord } from '../src/lib/approval/linkPropagation.js';
import { runLinkWorker } from '../src/jobs/linkWorker.js';

const LINKS = { field_id: 'issuelinks', field_kind: 'LINKS', store_values: true };
const SUMMARY = { field_id: 'summary', field_kind: 'TEXT', store_values: true };
const policy = { version: 2, verifiesTypeId: '90', testTypes: [{ projectId: 1, issueTypeId: '20' }], internalTypeIds: ['91'] };
const source = { id: '10', key: 'P-10', fields: { project: { id: '1' }, issuetype: { id: '30' } } };
const testIssue = { id: '11', key: 'P-11', fields: { project: { id: '1' }, issuetype: { id: '20' } } };
const onSource = { id: '100', type: { id: '90', name: 'Verifies' }, inwardIssue: testIssue };
const onTest = { id: '100', type: { id: '90', name: 'Verifies' }, outwardIssue: source };
const approval = { approvalId: 'YXBwcm92YWw=', accountId: 'reviewer', displayName: 'Reviewer', assuranceLevel: 'ESIGNATURE' };
const projectLinks = (links, issue = source, linkPolicy = policy) => project({ summary: 'Approved', issuelinks: links }, [LINKS, SUMMARY], { issue, linkPolicy });
function workerFixture({ own = source, receivingPolicy = policy, links = [], tree = null } = {}) {
  const values = { summary: 'Approved', issuelinks: links };
  const baseline = { baseline_id: Buffer.alloc(16, 1), issue_id: Number(own.id), project_id: Number(own.fields.project.id),
    issue_type_id: own.fields.issuetype.id, version: 1, content_hash: projectLinks(links, own, receivingPolicy).contentHash,
    field_digests: JSON.stringify(projectLinks(links, own, receivingPolicy).digests),
    link_policy: serialiseLinkPolicy(receivingPolicy), tree_hash: tree?.treeHash ?? null };
  const writes = [], reads = [], audits = [], cleared = [];
  const deps = { activeBaseline: async () => baseline, readAllValues: async () => values, readBaselineTree: async () => tree,
    readIssue: async id => { reads.push(String(id)); return String(id) === source.id ? source : testIssue; },
    getReview: async () => ({ version: 1, state: 'BASELINED', issue_key: own.key }), acquire: async () => ({ acquired: true }),
    release: async () => {}, writeDerivedFlat: async args => { writes.push(args); return { baselineId: Buffer.alloc(16, 2), version: 2 }; },
    writeDerivedTree: async args => { writes.push(args); return { baselineId: Buffer.alloc(16, 2), version: 2 }; },
    upsertBaselined: async () => {}, tryAppend: async event => { audits.push(event); }, recollect: async () => {},
    clearPending: async value => { cleared.push(value); }, now: () => 2 };
  return { baseline, deps, writes, reads, audits, cleared };
}
const job = (changes, decided = testIssue, receiving = source) => ({ issueId: Number(decided.id), issueKey: decided.key,
  otherIssueId: Number(receiving.id), changes, approvalId: approval.approvalId, approvedBy: approval.accountId,
  approvedName: approval.displayName, assuranceLevel: approval.assuranceLevel });

test('excluded deciding links express no opinion and queue no propagation job', () => {
  for (const [before, after] of [[[], [onSource]], [[onSource], []]]) {
    assert.deepEqual(linkDecisionJobs({ issue: source, tracksLinks: true, before, after, approval, linkPolicy: policy }), []);
  }
  assert.equal(linkDecisionJobs({ issue: source, tracksLinks: true, before: [], after: [onSource], approval }).length, 1, 'v1 owns its original links');
  assert.equal(linkDecisionJobs({ issue: testIssue, tracksLinks: true, before: [], after: [onTest], approval, linkPolicy: policy }).length, 1, 'the Test still owns Verifies');
});

test('only exact frozen internal type IDs are excluded; a generic Relates link remains governed', () => {
  const internal = { ...onSource, type: { id: '91', name: 'Plan membership' } };
  const generic = { ...onSource, type: { id: '7', name: 'Relates' } };
  assert.deepEqual(linkDecisionJobs({ issue: source, tracksLinks: true, before: [], after: [internal], approval, linkPolicy: policy }), []);
  assert.equal(linkDecisionJobs({ issue: source, tracksLinks: true, before: [], after: [generic], approval, linkPolicy: policy }).length, 1);
});

test('receiving v2 source ignores Test-owned Verifies addition and removal without a new baseline', async () => {
  for (const change of ['add', 'remove']) {
    const w = workerFixture();
    const result = await runLinkWorker(job([{ change, link: onTest }]), w.deps);
    assert.equal(result.outcome, 'EXCLUDED'); assert.equal(w.writes.length, 0); assert.equal(w.cleared.length, 1);
  }
});

test('a legacy receiving source still records Verifies under its unchanged v1 policy', async () => {
  const w = workerFixture({ receivingPolicy: null });
  const result = await runLinkWorker(job([{ change: 'add', link: onTest }]), w.deps);
  assert.equal(result.outcome, 'RECORDED'); assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].digests.issuelinks, projectLinks([onSource], source, null).digests.issuelinks);
  assert.equal(w.writes[0].source.link_policy, null);
});

test('the worker hydrates deciding endpoint metadata for v2 and fails closed on unreadable metadata', async () => {
  const w = workerFixture();
  await runLinkWorker(job([{ change: 'add', link: { ...onTest, outwardIssue: { id: source.id, key: source.key } } }]), w.deps);
  assert.deepEqual(w.reads, ['11']); assert.equal(w.writes.length, 0);
  w.deps.readIssue = async () => { throw new Error('unreadable endpoint'); };
  await assert.rejects(() => runLinkWorker(job([{ change: 'add', link: onTest }]), w.deps));
  assert.equal(w.writes.length, 0);
});

test('mixed receiving changes derive only governed links with the stored v2 digest basis', async () => {
  const w = workerFixture();
  const genericOnTest = { ...onTest, id: '101', type: { id: '7', name: 'Relates' } };
  const result = await runLinkWorker(job([{ change: 'add', link: onTest }, { change: 'add', link: genericOnTest }]), w.deps);
  assert.equal(result.outcome, 'RECORDED');
  assert.deepEqual(w.writes[0].values.issuelinks.map(link => link.type.id), ['7']);
  const expected = projectLinks([{ ...genericOnTest, inwardIssue: testIssue, outwardIssue: undefined }]);
  assert.equal(w.writes[0].contentHash, expected.contentHash);
});

test('flat derivation keeps the frozen v2 link digest and drops excluded restore values', () => {
  const base = projectLinks([]);
  const derived = deriveFlatRecord({ values: base.raw, digests: base.digests, links: [onSource], issue: source, linkPolicy: policy });
  assert.equal(derived.contentHash, base.contentHash); assert.deepEqual(derived.values.issuelinks, []);
});

function treeFixture() {
  const plan = planTreeCapture({ rootIssueId: source.id, nodes: [
    { ...source, fields: { ...source.fields, summary: 'Root', issuelinks: [] } },
    { id: '12', key: 'P-12', fields: { project: { id: '1' }, issuetype: { id: '30' }, parent: { id: source.id }, summary: 'Child', issuelinks: [] } }
  ], controlledFields: [LINKS, SUMMARY], policyFor: node => node.id === source.id ? policy : { version: 1 } });
  plan.nodes[0].linkPolicy = policy; plan.nodes[1].linkPolicy = { version: 1 };
  return { nodes: plan.nodes, values: plan.values, treeHash: plan.treeHash, linkPolicy: policy };
}

test('tree derivation replays root policy and preserves child v1 policy and hashes', () => {
  const tree = treeFixture();
  const derived = deriveTreeRecord({ tree, links: [onSource], linkPolicy: policy });
  assert.equal(derived.treeHash, tree.treeHash);
  assert.deepEqual(derived.nodes[1], tree.nodes[1]); assert.deepEqual(derived.nodes[1].linkPolicy, { version: 1 });
  assert.deepEqual(derived.values[tree.nodes[0].logicalNodeId].issuelinks, []);
});

test('tree worker uses the root node policy even when covering baseline has a different policy', async () => {
  const tree = treeFixture();
  const w = workerFixture({ receivingPolicy: null, tree });
  const result = await runLinkWorker(job([{ change: 'add', link: onTest }]), w.deps);
  assert.equal(result.outcome, 'EXCLUDED'); assert.equal(w.writes.length, 0);
});

test('a receiving baseline replaced while waiting for its lock cannot replay the old policy', async () => {
  const w = workerFixture({ receivingPolicy: null });
  const old = w.baseline, changed = { ...old, baseline_id: Buffer.alloc(16, 3), version: 2, link_policy: serialiseLinkPolicy(policy) };
  let reads = 0, released = 0;
  w.deps.activeBaseline = async () => ++reads === 1 ? old : changed;
  w.deps.release = async () => { released++; };
  const result = await runLinkWorker({ body: job([{ change: 'add', link: onTest }]), retryContext: { retryCount: 0 } }, w.deps);
  assert.equal(result?._retry, true); assert.equal(w.writes.length, 0); assert.equal(released, 1);
  assert.equal(w.cleared.length, 0);
});

test('an explicit v1 root keeps its policy when the tree fallback is v2', () => {
  const tree = treeFixture();
  const root = tree.nodes[0]; root.linkPolicy = { version: 1 };
  const original = project({ summary: 'Root', issuelinks: [] }, [LINKS, SUMMARY]);
  root.fieldDigests = JSON.stringify(original.digests); root.contentHash = original.contentHash;
  const derived = deriveTreeRecord({ tree, links: [onSource], linkPolicy: policy });
  assert.equal(JSON.parse(derived.nodes[0].fieldDigests).issuelinks,
    project({ issuelinks: [onSource] }, [LINKS]).digests.issuelinks);
  assert.deepEqual(derived.nodes[0].linkPolicy, { version: 1 });
});
