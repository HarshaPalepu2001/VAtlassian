import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/content.js';
import { canonical, sha256Hex } from '../src/lib/hash.js';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { ownsItsContent } from '../src/lib/tree/childBaselines.js';
import {
  linkChanges, linkDecisionJobs, applyLinkChanges, deriveFlatRecord, deriveTreeRecord, treeHashOf
} from '../src/lib/approval/linkPropagation.js';
import { runLinkWorker } from '../src/jobs/linkWorker.js';

// ONE LINK CHANGE, ONE DECISION (decided 2026-09-28).
//
// Found live: on 2026-09-26 "VAT-30 deploys VAT-3" was added while both were
// baselined, so both drifted. It was approved on VAT-30 alone. VAT-30's record
// then had the link and VAT-3's did not, and no decision on VAT-3 could ever
// agree with both. A Jira link is one object: approving it on either end must
// record it on both.

const VAT3 = { id: '43903', key: 'VAT-3' };
const VAT30 = { id: '43979', key: 'VAT-30' };
const VAT12 = { id: '43927', key: 'VAT-12' };
const deploys = { id: '10022', name: 'Deployments' };
const blocks = { id: '10000', name: 'Blocks' };
// "VAT-30 deploys VAT-3", as each end lists it.
const onVat30 = { id: '15539', type: deploys, outwardIssue: VAT3 };
const onVat3 = { id: '15539', type: deploys, inwardIssue: VAT30 };
const vat30BlockedBy12 = { id: '15534', type: blocks, inwardIssue: VAT12 };

const LINKS = { field_id: 'issuelinks', field_kind: 'LINKS', store_values: true };
const SUMMARY = { field_id: 'summary', field_kind: 'TEXT', store_values: true };
const linkDigest = links => project({ issuelinks: links }, [LINKS]).digests.issuelinks;
const approval = { approvalId: 'YXBwcm92YWwtb24tdmF0MzA=', accountId: 'acc-1', displayName: 'Harsha', assuranceLevel: 'TOTP' };

// ─── What an approval changed about its links ───────────────────────────────

test('an approval that accepts a new link reports it as added; one that accepts a removal, as removed', () => {
  assert.deepEqual(linkChanges([vat30BlockedBy12], [vat30BlockedBy12, onVat30]).map(c => [c.change, c.link.id]), [['add', '15539']]);
  assert.deepEqual(linkChanges([vat30BlockedBy12, onVat30], [vat30BlockedBy12]).map(c => [c.change, c.link.id]), [['remove', '15539']]);
  assert.deepEqual(linkChanges([onVat30], [{ ...onVat30, id: '99999' }]), [], 'a re-created link is the same relationship');
});

test('an approval queues one job per other issue whose link it decided', () => {
  const jobs = linkDecisionJobs({
    issue: { id: VAT30.id, key: VAT30.key }, tracksLinks: true,
    before: [vat30BlockedBy12], after: [onVat30], approval
  });
  assert.deepEqual(jobs.map(j => [j.otherIssueId, j.changes.map(c => c.change)]).sort((a, b) => a[0] - b[0]),
    [[Number(VAT3.id), ['add']], [Number(VAT12.id), ['remove']]]);
  assert.equal(jobs[0].issueKey, 'VAT-30');
  assert.equal(jobs[0].approvalId, approval.approvalId);
});

test('an approval that does not track links, or changed none, queues nothing', () => {
  assert.deepEqual(linkDecisionJobs({ issue: VAT30, tracksLinks: false, before: [], after: [onVat30], approval }), []);
  assert.deepEqual(linkDecisionJobs({ issue: VAT30, tracksLinks: true, before: [onVat30], after: [onVat30], approval }), []);
  assert.deepEqual(linkDecisionJobs({ issue: VAT30, tracksLinks: true, before: null, after: [onVat30], approval }), [],
    'an unreadable earlier record decides nothing about the other end');
});

test('a first approval (no earlier record) decides every link it signed', () => {
  const jobs = linkDecisionJobs({ issue: VAT30, tracksLinks: true, before: [], after: [onVat30], approval });
  assert.deepEqual(jobs.map(j => j.otherIssueId), [Number(VAT3.id)]);
});

// ─── The other end's record ─────────────────────────────────────────────────

test('the other end records the link as IT lists it, and only when its record disagrees', () => {
  const added = applyLinkChanges({ links: [], selfIssue: VAT3, decidedOn: VAT30, changes: [{ change: 'add', link: onVat30 }] });
  assert.equal(linkDigest(added), linkDigest([onVat3]), 'VAT-3 now records "is deployed by VAT-30"');
  assert.equal(applyLinkChanges({ links: [onVat3], selfIssue: VAT3, decidedOn: VAT30,
    changes: [{ change: 'add', link: onVat30 }] }), null, 'already agrees: nothing to record');
  assert.deepEqual(applyLinkChanges({ links: [onVat3], selfIssue: VAT3, decidedOn: VAT30,
    changes: [{ change: 'remove', link: onVat30 }] }), []);
  assert.equal(applyLinkChanges({ links: [], selfIssue: VAT3, decidedOn: VAT30,
    changes: [{ change: 'remove', link: onVat30 }] }), null);
});

test('a flat record changes the link and nothing else, and its hash follows', () => {
  const values = { summary: 'Reporting improvements', issuelinks: [] };
  const digests = project(values, [LINKS, SUMMARY]).digests;
  const derived = deriveFlatRecord({ values, digests, links: [onVat3] });
  assert.equal(derived.values.summary, 'Reporting improvements');
  assert.deepEqual(derived.values.issuelinks, [onVat3]);
  assert.equal(derived.digests.summary, digests.summary, 'other fields keep their approved digests');
  assert.equal(derived.digests.issuelinks, linkDigest([onVat3]));
  assert.equal(derived.contentHash, sha256Hex(canonical(derived.digests)));
  assert.equal(derived.contentHash, project({ ...values, issuelinks: [onVat3] }, [LINKS, SUMMARY]).contentHash,
    'exactly what a capture of that content would record');
});

// A tree as capture writes it and readBaselineTree returns it.
function storedTree(rootFields, childFields) {
  const nodes = [
    { id: VAT3.id, key: VAT3.key, fields: { project: { id: '11851' }, issuetype: { id: '10000' }, ...rootFields } },
    { id: '43950', key: 'VAT-40', fields: { project: { id: '11851' }, issuetype: { id: '10007' }, parent: { id: VAT3.id }, ...childFields } }
  ];
  const plan = planTreeCapture({ rootIssueId: VAT3.id, nodes, controlledFields: [LINKS, SUMMARY] });
  return { plan, tree: { nodes: plan.nodes.map(n => ({ ...n })), values: plan.values } };
}

test('the stored tree hashes back to the tree hash its capture signed', () => {
  const { plan, tree } = storedTree({ summary: 'Epic', issuelinks: [] }, { summary: 'Story', issuelinks: [] });
  assert.equal(treeHashOf(tree.nodes), plan.treeHash);
});

test('a tree record changes only its root link; children and structure are untouched', () => {
  const { tree } = storedTree({ summary: 'Epic', issuelinks: [] }, { summary: 'Story', issuelinks: [] });
  const derived = deriveTreeRecord({ tree, links: [onVat3] });
  const expected = storedTree({ summary: 'Epic', issuelinks: [onVat3] }, { summary: 'Story', issuelinks: [] });
  assert.equal(derived.treeHash, expected.plan.treeHash, 'the same record a capture of that content would sign');
  const child = derived.nodes.find(n => n.parentLogicalNodeId != null);
  assert.deepEqual(child, tree.nodes.find(n => n.parentLogicalNodeId != null));
  assert.deepEqual(derived.values[child.logicalNodeId], tree.values[child.logicalNodeId]);
});

test('a derived parent version leaves its children owning their own content', () => {
  const parentV3 = { baseline_id: Buffer.from('parent-v3'), captured_at: 1000 };
  const childBaseline = { captured_by_baseline_id: Buffer.from('parent-v3'), captured_at: 1000 };
  const derivedV4 = { baseline_id: Buffer.from('parent-v4'), captured_at: 5000, nodes_captured_at: 1000 };
  assert.equal(ownsItsContent(childBaseline, parentV3), true);
  assert.equal(ownsItsContent(childBaseline, derivedV4), true,
    'v4 re-recorded only a link on the parent; its children were captured at v3');
  assert.equal(ownsItsContent({ captured_at: 900 }, derivedV4), false, 'a child older than the nodes still is not');
});

// ─── The worker ─────────────────────────────────────────────────────────────

function world({ baseline, values = {}, tree = null, review = { version: 7, state: 'DRIFTED', summary: 'x' }, acquired = true }) {
  const calls = { flat: [], tree: [], released: [], upserts: [], ledger: [], recollected: [] };
  const deps = {
    activeBaseline: async () => baseline,
    readAllValues: async () => values,
    readBaselineTree: async () => tree,
    getReview: async () => review,
    acquire: async () => ({ acquired }),
    release: async args => { calls.released.push(args); },
    writeDerivedFlat: async args => { calls.flat.push(args); return { baselineId: Buffer.from('new-flat'), version: 9 }; },
    writeDerivedTree: async args => { calls.tree.push(args); return { baselineId: Buffer.from('new-tree'), version: 9 }; },
    upsertBaselined: async args => { calls.upserts.push(args); },
    recollect: async args => { calls.recollected.push(args); },
    tryAppend: async entry => { calls.ledger.push(entry); },
    clearPending: async args => { calls.cleared = [...(calls.cleared ?? []), args]; },
    now: () => 42
  };
  return { deps, calls };
}
const jobFor = changes => ({ issueId: Number(VAT30.id), issueKey: VAT30.key, otherIssueId: Number(VAT3.id), changes,
  approvalId: approval.approvalId, approvedBy: approval.accountId, approvedName: approval.displayName,
  assuranceLevel: approval.assuranceLevel });
const flatRow = digests => ({ baseline_id: Buffer.from('vat3-v5'), issue_id: 43903, version: 5, tree_hash: null,
  field_digests: JSON.stringify(digests), project_id: 11851, issue_type_id: '10000', required_role: 'reviewer',
  required_assurance: 'TOTP', controlled_fields_hash: 'h', transition_id: '3', from_status_id: '10000', to_status_id: '10005' });

test('VAT-3: an approval on VAT-30 records the link on VAT-3 too, as a new version signed by that approval', async () => {
  const values = { summary: 'Reporting improvements', issuelinks: [] };
  const w = world({ baseline: flatRow(project(values, [LINKS, SUMMARY]).digests), values });
  const result = await runLinkWorker(jobFor([{ change: 'add', link: onVat30 }]), w.deps);
  assert.equal(result.outcome, 'RECORDED');
  const [write] = w.calls.flat;
  assert.deepEqual(write.values.issuelinks, [onVat3]);
  assert.equal(write.source.version, 5);
  assert.equal(write.approval.approvalId.toString('base64'), approval.approvalId);
  assert.equal(write.approval.accountId, 'acc-1');
  assert.equal(w.calls.upserts[0].baselineVersion, 9);
  assert.deepEqual(w.calls.recollected, [{ issueId: 43903, issueKey: null, tree: false }], 'VAT-3 re-measured: its other drift stays');
  const ledger = w.calls.ledger.find(e => e.eventType === 'BASELINE_CAPTURED');
  assert.equal(ledger.issueId, 43903);
  assert.equal(ledger.payload.linkDecision.decidedOn, 'VAT-30');
});

test('a tree-rooted other end gets a derived tree version', async () => {
  const { plan, tree } = storedTree({ summary: 'Epic', issuelinks: [] }, { summary: 'Story', issuelinks: [] });
  const baseline = { ...flatRow({}), tree_hash: plan.treeHash, field_digests: '{}', captured_at: 1000 };
  const w = world({ baseline, tree });
  assert.equal((await runLinkWorker(jobFor([{ change: 'add', link: onVat30 }]), w.deps)).outcome, 'RECORDED');
  const [write] = w.calls.tree;
  assert.equal(write.derived.treeHash, storedTree({ summary: 'Epic', issuelinks: [onVat3] }, { summary: 'Story', issuelinks: [] }).plan.treeHash);
  assert.equal(write.source.captured_at, 1000);
  assert.equal(w.calls.recollected[0].tree, true);
});

test('an other end that already agrees, is not governed, or does not track links is left alone', async () => {
  const agreeing = { summary: 'x', issuelinks: [onVat3] };
  let w = world({ baseline: flatRow(project(agreeing, [LINKS, SUMMARY]).digests), values: agreeing });
  assert.equal((await runLinkWorker(jobFor([{ change: 'add', link: onVat30 }]), w.deps)).outcome, 'AGREES');
  w = world({ baseline: null });
  assert.equal((await runLinkWorker(jobFor([{ change: 'add', link: onVat30 }]), w.deps)).outcome, 'NOT_GOVERNED');
  w = world({ baseline: flatRow(project({ summary: 'x' }, [SUMMARY]).digests), values: { summary: 'x' } });
  assert.equal((await runLinkWorker(jobFor([{ change: 'add', link: onVat30 }]), w.deps)).outcome, 'NOT_TRACKED');
  assert.equal(w.calls.flat.length + w.calls.tree.length, 0);
});

test('an other end in the middle of its own decision is retried, not overwritten', async () => {
  const values = { summary: 'x', issuelinks: [] };
  const w = world({ baseline: flatRow(project(values, [LINKS, SUMMARY]).digests), values, acquired: false });
  const result = await runLinkWorker({ body: jobFor([{ change: 'add', link: onVat30 }]), retryContext: { retryCount: 0 } }, w.deps);
  assert.equal(result?._retry, true, 'Forge redelivers it later');
  assert.equal(w.calls.flat.length, 0);
});

test('a failed write hands the lock back as it was', async () => {
  const values = { summary: 'x', issuelinks: [] };
  const w = world({ baseline: flatRow(project(values, [LINKS, SUMMARY]).digests), values });
  w.deps.writeDerivedFlat = async () => { throw new Error('boom'); };
  await assert.rejects(() => runLinkWorker(jobFor([{ change: 'add', link: onVat30 }]), w.deps), /boom/);
  assert.equal(w.calls.released[0].state, 'DRIFTED');
});
