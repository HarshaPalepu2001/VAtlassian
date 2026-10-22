import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/content.js';
import { canonical, sha256Hex } from '../src/lib/hash.js';
import { driftedFields } from '../src/lib/interception.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { planCapture } from '../src/lib/baseline.js';
import { baselineDrift } from '../src/lib/liveDrift.js';
import { hydrateLinkPolicyIssue, nativeMirrorAllowed, serialiseLinkPolicy, resolveNewLinkPolicy } from '../src/lib/linkPolicy.js';
import { makeApproval, validEvidence } from '../src/lib/approval/record.js';
import { trackedLinks } from '../src/lib/evidence/versionEvidence.js';

const LINKS = [{ field_id: 'issuelinks', field_kind: 'LINKS', store_values: true }];
const policy = { version: 2, verifiesTypeId: '90', testTypes: [{ projectId: 1, issueTypeId: '20' }], internalTypeIds: ['91'] };
const source = { id: '10', key: 'P-10', fields: { project: { id: '1' }, issuetype: { id: '30' } } };
const testIssue = { id: '11', key: 'P-11', fields: { project: { id: '1' }, issuetype: { id: '20' } } };
const onSource = { id: '100', type: { id: '90' }, inwardIssue: testIssue };
const onTest = { id: '100', type: { id: '90' }, outwardIssue: source };
const context = issue => ({ linkPolicy: policy, issue });

test('v1 absent and explicit policies retain the exact historical link hash bytes', () => {
  const fields = { issuelinks: [onSource] };
  const digest = sha256Hex(canonical({ f: 'issuelinks', k: 'LINKS', v: [{ type: '90', inward: '11', outward: null }] }));
  for (const linkPolicy of [undefined, null, { version: 1 }]) {
    const result = project(fields, LINKS, { issue: source, linkPolicy });
    assert.equal(result.digests.issuelinks, digest);
    assert.equal(result.contentHash, sha256Hex(canonical({ issuelinks: digest })));
    assert.deepEqual(result.raw.issuelinks, [onSource]);
  }
});

test('v2 source excludes Test-owned Verifies from both signed digest and retained restore values', () => {
  const before = project({ issuelinks: [] }, LINKS, context(source));
  const after = project({ issuelinks: [onSource] }, LINKS, context(source));
  assert.equal(after.contentHash, before.contentHash);
  assert.deepEqual(after.raw.issuelinks, []);
  assert.deepEqual(trackedLinks(LINKS, { issuelinks: [onSource] }, context(source)), [], 'historical link evidence uses the same policy');
  assert.notEqual(after.contentHash, project({ issuelinks: [] }, LINKS).contentHash, 'v2 policy is itself signed');
});

test('the Test owns Verifies and detects manual link changes', () => {
  const before = project({ issuelinks: [] }, LINKS, context(testIssue));
  const after = project({ issuelinks: [onTest] }, LINKS, context(testIssue));
  assert.notEqual(before.contentHash, after.contentHash);
  assert.deepEqual(after.raw.issuelinks, [onTest]);
  assert.deepEqual(driftedFields({ baselineDigests: before.digests, issueFields: { issuelinks: [onTest] },
    controlledFields: LINKS, ...context(testIssue) }).changed, ['issuelinks']);
});

test('v2 excludes internal types at both ends while unrelated types remain governed', () => {
  for (const [issue, other] of [[source, testIssue], [testIssue, source]]) {
    const base = project({ issuelinks: [] }, LINKS, context(issue));
    const internal = { type: { id: '91' }, outwardIssue: other };
    assert.equal(project({ issuelinks: [internal] }, LINKS, context(issue)).contentHash, base.contentHash);
    assert.notEqual(project({ issuelinks: [{ ...internal, type: { id: '92' } }] }, LINKS, context(issue)).contentHash, base.contentHash);
  }
});

test('v2 refuses unknown policy or unresolved Verifies endpoint identity', () => {
  assert.throws(() => project({ issuelinks: [] }, LINKS, { linkPolicy: { version: 3 }, issue: source }), { reason: 'LINK_POLICY_UNREADABLE' });
  assert.throws(() => project({ issuelinks: [{ type: { id: '90' }, inwardIssue: { id: '11' } }] }, LINKS, context(source)), { reason: 'LINK_POLICY_UNREADABLE' });
});

test('stored policy governs drift and tree capture independently from later configuration', () => {
  const baseline = project({ issuelinks: [] }, LINKS, context(source));
  assert.deepEqual(driftedFields({ baselineDigests: baseline.digests, issueFields: { issuelinks: [onSource] },
    controlledFields: LINKS, ...context(source) }).changed, []);
  const node = { ...source, fields: { ...source.fields, issuelinks: [onSource] } };
  const a = planTreeCapture({ rootIssueId: source.id, nodes: [node], controlledFields: LINKS, linkPolicy: policy });
  const b = planTreeCapture({ rootIssueId: source.id, nodes: [{ ...node, fields: { ...node.fields, issuelinks: [] } }], controlledFields: LINKS, linkPolicy: policy });
  assert.equal(a.treeHash, b.treeHash);
  assert.deepEqual(a.values[a.nodes[0].logicalNodeId].issuelinks, []);
});

test('new capture records its signed policy and live comparison replays that snapshot', async () => {
  const base = planCapture({ issueId: 10, projectId: 1, issueTypeId: '30', version: 1,
    controlledFields: LINKS, issueFields: { ...source.fields, issuelinks: [] }, linkPolicy: policy });
  assert.equal(base.baseline.link_policy, serialiseLinkPolicy(policy));
  const comparison = await baselineDrift({ baseline: base.baseline, issueId: 10,
    issueFields: { ...source.fields, issuelinks: [onSource] }, declared: LINKS });
  assert.deepEqual(comparison.changed, []);
});

test('a captured approval freezes policy and detects policy substitution without invalidating v1 proofs', () => {
  const binding = { accountId: 'a', issueId: 10, contentHash: 'a'.repeat(64), decision: 'APPROVE' };
  const input = { ...binding, now: 100, proof: { ok: true, level: 'ESIGNATURE', providerId: 'totp', evidence: { binding } } };
  const legacy = makeApproval(input);
  assert.equal(validEvidence(legacy), true);
  const frozen = makeApproval({ ...input, linkPolicy: policy });
  assert.equal(frozen.link_policy, serialiseLinkPolicy(policy));
  assert.equal(validEvidence(frozen), true);
  assert.equal(validEvidence({ ...frozen, link_policy: serialiseLinkPolicy({ ...policy, internalTypeIds: ['92'] }) }), false);
  assert.equal(validEvidence(legacy), true);
});

test('missing linked endpoint scope is hydrated once and native mirror cannot override a Test baseline', async () => {
  let reads = 0;
  const hydrated = await hydrateLinkPolicyIssue({ ...source, fields: { ...source.fields, issuelinks: [
    { ...onSource, inwardIssue: { id: '11' } }, { ...onSource, id: '101', inwardIssue: { id: '11' } }
  ] } }, policy, async () => { reads++; return testIssue; });
  assert.equal(reads, 1);
  assert.deepEqual(project(hydrated.fields, LINKS, context(hydrated)).raw.issuelinks, []);
  assert.equal(nativeMirrorAllowed({ baseline: null, issue: testIssue, link: onTest }), true);
  assert.equal(nativeMirrorAllowed({ baseline: {}, issue: source, link: onSource }), false);
  assert.equal(nativeMirrorAllowed({ baseline: { link_policy: serialiseLinkPolicy(policy) }, issue: source, link: onSource }), true);
  assert.equal(nativeMirrorAllowed({ baseline: { link_policy: serialiseLinkPolicy(policy) }, issue: testIssue, link: onTest }), false);
  assert.deepEqual(await resolveNewLinkPolicy(source, async () => null), { version: 1 });
});
