/**
 * End-to-end link decisions.
 *
 * Two separately baselined work items share one Jira link object. The tests
 * run the validator and panel through test/helpers/validator-world.js and
 * use the link worker. As in usecases/drift.js, approval captures the item's
 * own baseline before queueing a link decision for the other end. The
 * worker records that decision.
 *
 * The suite reproduces VAT-3 / VAT-30 on 2026-09-26. Both were baselined,
 * "VAT-30 deploys VAT-3" was added, and VAT-30 alone was approved. VAT-3
 * remained held with a record no decision could reconcile.
 */
import { world, DRIFT, TRACKED } from './helpers/validator-world.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { linkDecisionJobs } from '../src/lib/approval/linkPropagation.js';
import { runLinkWorker } from '../src/jobs/linkWorker.js';

const LINKS = { field_id: 'issuelinks', field_kind: 'LINKS', store_values: true, materiality: 'MAJOR' };
const deploys = { id: '10022', name: 'Deployments' };

function linkedPair() {
  const w = world({ tracked: [...TRACKED, LINKS] });
  w.createIssue({ key: 'VAT-30', id: '43979', status: '4' });
  w.createIssue({ key: 'VAT-3', id: '43903', status: '4' });
  w.baseline('VAT-30');
  w.baseline('VAT-3');
  return w;
}
// Jira: creating the link shows it on both issues, each naming the other.
const link = w => {
  w.edit('VAT-30', { issuelinks: [{ id: '15539', type: deploys, outwardIssue: { id: '43903', key: 'VAT-3' } }] });
  w.edit('VAT-3', { issuelinks: [{ id: '15539', type: deploys, inwardIssue: { id: '43979', key: 'VAT-30' } }] });
};
const unlink = w => { w.edit('VAT-30', { issuelinks: [] }); w.edit('VAT-3', { issuelinks: [] }); };

function workerDeps(w) {
  const byId = id => w.baselines.find(b => b.issue_id === Number(id) && b.state === 'ACTIVE') ?? null;
  return {
    activeBaseline: async id => byId(id),
    readAllValues: async (id, version) => w.baselines.find(b => b.issue_id === Number(id) && b.version === Number(version)).values,
    readBaselineTree: async () => assert.fail('these items have single-issue records'),
    getReview: async id => ({ ...w.itemState.get(Number(id)),
      issue_key: [...w.issues.values()].find(i => Number(i.id) === Number(id)).key }),
    acquire: async () => ({ acquired: true }),
    release: async () => {},
    writeDerivedFlat: async ({ source, values, digests, contentHash, approval, now }) => {
      for (const b of w.baselines) if (b.issue_id === source.issue_id && b.state === 'ACTIVE') b.state = 'SUPERSEDED';
      const version = w.baselines.filter(b => b.issue_id === source.issue_id).length + 1;
      const baselineId = randomBytes(16);
      w.baselines.push({ ...source, baseline_id: baselineId, version, state: 'ACTIVE', content_hash: contentHash,
        field_digests: JSON.stringify(digests), values, approved_by: approval.accountId,
        approval_id: approval.approvalId, captured_at: now });
      return { baselineId, version };
    },
    upsertBaselined: async () => {},
    recollect: async () => {},
    tryAppend: async entry => { w.audit.push(entry); },
    clearPending: async ({ issueId, decidedOnIssueId }) => {
      w.linkPending = w.linkPending.filter(p => !(p.issue_id === Number(issueId) && p.decided_on_issue_id === Number(decidedOnIssueId)));
    },
    now: () => w.now
  };
}

/** APPROVE on `key` as usecases/drift.js applies it, up to the queue: the jobs, each marked pending. */
function approveQueued(w, key) {
  const before = w.activeBaseline(key).values.issuelinks;
  w.approveDrift(key);
  const issue = w.issue(key);
  const jobs = linkDecisionJobs({ issue: { id: issue.id, key }, tracksLinks: true, before,
    after: issue.fields.issuelinks, approval: { approvalId: randomBytes(16).toString('base64'),
      accountId: 'reviewer', displayName: 'Reviewer', assuranceLevel: 'ESIGNATURE' } });
  for (const job of jobs) w.linkPending.push({ issue_id: job.otherIssueId, decided_on_issue_id: job.issueId,
    decided_on_key: job.issueKey, queued_at: w.now });
  return jobs;
}

/** APPROVE on `key`, as usecases/drift.js applies it, then the queued worker. */
async function approve(w, key) {
  const jobs = approveQueued(w, key);
  const outcomes = [];
  for (const job of jobs) outcomes.push((await runLinkWorker(job, workerDeps(w))).outcome);
  return outcomes;
}

const held = async (w, key) => {
  const r = await w.transition(key, '41', { dry: true });
  return r.result === false && DRIFT.test(r.errorMessage ?? '');
};
const drift = async (w, key) => (await w.panel(key)).drift.count;

test('L1 linking two baselined items holds both, and both panels can decide it', async () => {
  const w = linkedPair();
  link(w);
  assert.equal(await held(w, 'VAT-30'), true);
  assert.equal(await held(w, 'VAT-3'), true);
  assert.ok(await drift(w, 'VAT-30') > 0);
  assert.ok(await drift(w, 'VAT-3') > 0);
});

test('L2 approving on VAT-30 settles VAT-3 as well: both released, both records agree', async () => {
  const w = linkedPair();
  link(w);
  assert.deepEqual(await approve(w, 'VAT-30'), ['RECORDED']);
  assert.equal(await held(w, 'VAT-30'), false);
  assert.equal(await held(w, 'VAT-3'), false, 'VAT-3 is no longer held: the link is on its record too');
  assert.equal(await drift(w, 'VAT-3'), 0);
  const vat3 = w.activeBaseline('VAT-3');
  assert.equal(vat3.version, 2, 'a new version; version 1 stays as it was signed');
  assert.equal(w.baselines.find(b => b.issue_id === 43903 && b.version === 1).state, 'SUPERSEDED');
  const entry = w.audit.find(e => e.eventType === 'BASELINE_CAPTURED' && e.issueId === 43903);
  assert.equal(entry.payload.linkDecision.decidedOn, 'VAT-30');
});

test('L3 approving on either end works the same way', async () => {
  const w = linkedPair();
  link(w);
  assert.deepEqual(await approve(w, 'VAT-3'), ['RECORDED']);
  assert.equal(await held(w, 'VAT-30'), false);
  assert.equal(await held(w, 'VAT-3'), false);
});

test('L4 the second end has nothing left to decide, and a redelivered job writes nothing', async () => {
  const w = linkedPair();
  link(w);
  await approve(w, 'VAT-30');
  const versions = w.baselines.length;
  assert.deepEqual(await approve(w, 'VAT-3'), [], 'VAT-3\'s record already has the link: no link decision to make');
  assert.equal(w.baselines.length, versions + 1, 'only VAT-3\'s own approval capture');
  // Forge delivers at least once: the same job again finds VAT-3 agreeing.
  const job = linkDecisionJobs({ issue: { id: '43979', key: 'VAT-30' }, tracksLinks: true, before: [],
    after: w.issue('VAT-30').fields.issuelinks, approval: { approvalId: 'AA==', accountId: 'reviewer' } })[0];
  assert.equal((await runLinkWorker(job, workerDeps(w))).outcome, 'AGREES');
});

test('L5 rejecting on either end: the link goes back once and both are released, no records written', async () => {
  const w = linkedPair();
  link(w);
  unlink(w); // the restore: one Jira delete, seen by both
  assert.equal(await held(w, 'VAT-30'), false);
  assert.equal(await held(w, 'VAT-3'), false);
  assert.equal(w.baselines.length, 2);
});

test('L6 unlinking after both approved it: approving the removal on one end settles the other', async () => {
  const w = linkedPair();
  link(w);
  await approve(w, 'VAT-30');
  unlink(w);
  assert.equal(await held(w, 'VAT-3'), true);
  assert.deepEqual(await approve(w, 'VAT-3'), ['RECORDED']);
  assert.equal(await held(w, 'VAT-30'), false);
  assert.deepEqual(w.activeBaseline('VAT-30').values.issuelinks, []);
});

test('L7 the other end keeps its own undecided changes: only the link is settled for it', async () => {
  const w = linkedPair();
  link(w);
  w.edit('VAT-3', { summary: 'edited on VAT-3' });
  await approve(w, 'VAT-30');
  assert.equal(await held(w, 'VAT-3'), true, 'VAT-3\'s summary change still needs VAT-3\'s own decision');
  const panel = await w.panel('VAT-3');
  assert.equal(panel.drift.count, 1);
});

// ─── Between the approval and the record: the other end says what it is waiting for ───

const PENDING = /still being recorded/i;

test('L8 before the job lands, VAT-3 is held with the reason, and its panel shows the decision on its way', async () => {
  const w = linkedPair();
  link(w);
  const [job] = approveQueued(w, 'VAT-30');
  const r = await w.transition('VAT-3', '41', { dry: true });
  assert.equal(r.result, false);
  assert.match(r.errorMessage, DRIFT, 'still a drift hold');
  assert.match(r.errorMessage, PENDING, 'and it says a decision is on its way');
  assert.deepEqual((await w.panel('VAT-3')).drift.linkPending.map(p => p.decidedOnKey), ['VAT-30']);

  assert.equal((await runLinkWorker(job, workerDeps(w))).outcome, 'RECORDED');
  assert.equal(await held(w, 'VAT-3'), false);
  assert.deepEqual((await w.panel('VAT-3')).drift.linkPending, [], 'the marker is gone once recorded');
});

test('L9 a marker the worker never cleared stops explaining the hold after two minutes', async () => {
  const w = linkedPair();
  link(w);
  approveQueued(w, 'VAT-30');
  w.now += 121_000;
  const r = await w.transition('VAT-3', '41', { dry: true });
  assert.match(r.errorMessage, DRIFT);
  assert.doesNotMatch(r.errorMessage, PENDING);
  assert.deepEqual((await w.panel('VAT-3')).drift.linkPending, []);
});

test('L10 an issue with no link drift never mentions a pending link, and reads no markers', async () => {
  const w = linkedPair();
  w.edit('VAT-3', { summary: 'edited' });
  w.linkPending.push({ issue_id: 43903, decided_on_issue_id: 43979, decided_on_key: 'VAT-30', queued_at: w.now });
  const r = await w.transition('VAT-3', '41', { dry: true });
  assert.doesNotMatch(r.errorMessage, PENDING, 'the hold is for the summary, not a link');
});

test('L11 whatever the worker concludes, the marker is cleared; a retry keeps it', async () => {
  const w = linkedPair();
  link(w);
  const [job] = approveQueued(w, 'VAT-30');
  const deps = workerDeps(w);
  deps.acquire = async () => ({ acquired: false });
  const retry = await runLinkWorker({ body: job, retryContext: { retryCount: 0 } }, deps);
  assert.equal(retry._retry, true);
  assert.equal(w.linkPending.length, 1, 'still on its way');
  await runLinkWorker(job, workerDeps(w));
  assert.equal(w.linkPending.length, 0);
  // Already agreeing: nothing written, marker still cleared.
  w.linkPending.push({ issue_id: 43903, decided_on_issue_id: 43979, decided_on_key: 'VAT-30', queued_at: w.now });
  assert.equal((await runLinkWorker(job, workerDeps(w))).outcome, 'AGREES');
  assert.equal(w.linkPending.length, 0);
});
