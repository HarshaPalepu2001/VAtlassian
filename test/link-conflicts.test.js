import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { findLinkConflicts } from '../src/lib/restore/linkConflicts.js';

// AN ISSUE LINK IS ONE OBJECT WITH TWO OWNERS.
//
// Found live on 2026-09-25: the VAT-12 ↔ VAT-15 link was removed; VAT-15's
// drift was approved on its own (its baseline: no link) while VAT-12's still
// held the link. Rejecting VAT-10 then re-created VAT-12's link — which also
// put it back on VAT-15, against VAT-15's approval — and the retry restored
// VAT-15 by deleting it again. Each restore was right about its own item and
// wrong about the other. A restore must never change a link in a way the other
// end's approved state contradicts.

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'test:forge-api', shortCircuit: true };
    if (specifier.endsWith('/db/restoreStore.js')) return { url: 'test:restore-store', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:forge-api') return { format: 'module', shortCircuit: true,
      source: 'export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??""),"");' };
    if (url === 'test:restore-store') return { format: 'module', shortCircuit: true,
      source: 'export async function declareWrite() {}' };
    return next(url, context);
  }
});
const { createRestoreAdapters } = await import('../src/lib/tree/restoreAdapters.js');
const { isSystemicFailure } = await import('../src/lib/tree/restoreExecutor.js');
const { explainRefusals } = await import('../src/lib/tree/restoreVerifier.js');
const { executeRestore } = await import('../src/lib/restore/executor.js');
hooks.deregister();

const VAT12 = { id: '43927', key: 'VAT-12' };
const VAT15 = { id: '43930', key: 'VAT-15' };
const VAT11 = { id: '43926', key: 'VAT-11' };
const relates = { id: '10003', name: 'Relates' };
// "VAT-15 relates to VAT-12": inward VAT-15, outward VAT-12. Each issue lists
// the link by naming the OTHER end.
const onVat12 = { id: '15491', type: relates, inwardIssue: VAT15 };
const onVat15 = { id: '15491', type: relates, outwardIssue: VAT12 };
const blocksOn12 = { id: '15488', type: { id: '10000', name: 'Blocks' }, inwardIssue: VAT11 };

const approved = map => async issueId => (Object.hasOwn(map, String(issueId)) ? map[String(issueId)] : null);

test('re-adding a link the other end approved removing is a conflict', async () => {
  const conflicts = await findLinkConflicts({ selfIssueId: VAT12.id, additions: [onVat12], removals: [],
    approvedLinksOf: approved({ [VAT15.id]: [] }) });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].change, 'add');
  assert.equal(conflicts[0].otherIssueKey, 'VAT-15');
});

test('removing a link the other end approved keeping is a conflict', async () => {
  const conflicts = await findLinkConflicts({ selfIssueId: VAT15.id, additions: [], removals: [onVat15],
    approvedLinksOf: approved({ [VAT12.id]: [onVat12, blocksOn12] }) });
  assert.deepEqual(conflicts.map(c => [c.change, c.otherIssueKey]), [['remove', 'VAT-12']]);
});

test('when both ends agree, or the other end is not governed, nothing conflicts', async () => {
  assert.deepEqual(await findLinkConflicts({ selfIssueId: VAT12.id, additions: [onVat12], removals: [],
    approvedLinksOf: approved({ [VAT15.id]: [onVat15] }) }), []);
  assert.deepEqual(await findLinkConflicts({ selfIssueId: VAT12.id, additions: [onVat12], removals: [],
    approvedLinksOf: approved({}) }), []);
});

// ─── The tree restore adapter ───────────────────────────────────────────────

const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const route = (s, ...v) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '');
function apiFixture(current) {
  const calls = [];
  const client = { requestJira: async (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) };
    calls.push(call);
    return call.method === 'GET' ? response(200, { id: current.id, key: current.key, fields: { issuelinks: current.links } })
      : response(call.method === 'POST' ? 201 : 204);
  } };
  return { calls, api: { asApp: () => client, asUser: () => client } };
}

test('the tree adapter leaves a conflicting link alone, restores the rest, and refuses with the reason', async () => {
  const f = apiFixture({ ...VAT12, links: [] });
  const adapters = createRestoreAdapters({ api: f.api, route, approvedLinksOf: approved({ [VAT15.id]: [], [VAT11.id]: null }) });
  await assert.rejects(() => adapters.restoreLinks('VAT-12', [onVat12, blocksOn12]), error => {
    assert.equal(error.code, 'LINK_CONFLICT');
    assert.equal(isSystemicFailure(error), false, 'a conflict settles the step; it must not stop and retry the restore');
    assert.match(error.detail, /VAT-15/);
    assert.match(error.detail, /approved/);
    return true;
  });
  const posts = f.calls.filter(c => c.method === 'POST').map(c => c.body);
  assert.deepEqual(posts, [{ type: { id: '10000' }, inwardIssue: { id: VAT11.id }, outwardIssue: { key: 'VAT-12' } }],
    'the non-conflicting link is restored; the conflicting one is not touched');
});

test('a restore report says the app kept the link, not that Jira refused it', () => {
  const [entry] = explainRefusals(
    [{ logicalNodeId: 'n12', kind: 'FIELD_CHANGED', fieldId: 'issuelinks', reason: 'Jira accepted the restore but …' }],
    [{ logicalNodeId: 'n12', error: { code: 'LINK_CONFLICT', detail: 'Left the link to VAT-15 as it is: VAT-15 approved removing it.' } }]);
  assert.equal(entry.reason, 'Left the link to VAT-15 as it is: VAT-15 approved removing it.');
});

// ─── The single-item restore ────────────────────────────────────────────────

test('a single-item restore leaves a conflicting link alone and says why', async () => {
  const f = apiFixture({ ...VAT15, links: [onVat15] });
  const result = await executeRestore({ api: f.api, issueKey: 'VAT-15', issueId: VAT15.id,
    approvedLinksOf: approved({ [VAT12.id]: [onVat12] }),
    plan: { fieldWrites: {}, steps: [{ fieldId: 'issuelinks', strategy: 'links', targetValue: [] }] } });
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0, 'VAT-12 approved the link, so VAT-15 must not delete it');
  assert.equal(result.detail[0].outcome, 'failed');
  assert.match(result.detail[0].reason, /VAT-12/);
});

// ─── Where the other end's approved links come from ─────────────────────────

const { approvedLinksResolver } = await import('../src/db/approvedLinks.js');
const digests = ids => JSON.stringify(Object.fromEntries(ids.map(id => [id, 'd'])));
const noDb = { activeBaseline: async () => assert.fail('no read expected'), readAllValues: async () => assert.fail(),
  readBaselineTree: async () => assert.fail(), activeRootsForNode: async () => assert.fail() };

test('an end inside the tree being restored answers with what this restore returns it to', async () => {
  const baselineTree = { nodes: [{ logicalNodeId: 'n15', currentIssueId: 43930 }], values: { n15: { issuelinks: [] } } };
  const of = approvedLinksResolver({ baselineTree }, noDb);
  assert.deepEqual(await of('43930'), []);
});

test('an end with its own baseline answers with its retained links; one that tracks no links has no say', async () => {
  const deps = { ...noDb,
    activeBaseline: async id => (id === 43927 ? { version: 2, field_digests: digests(['summary', 'issuelinks']) }
      : { version: 1, field_digests: digests(['summary']) }),
    readAllValues: async (id, version) => { assert.deepEqual([id, version], [43927, 2]); return { issuelinks: [onVat12] }; } };
  const of = approvedLinksResolver({}, deps);
  assert.deepEqual(await of('43927'), [onVat12]);
  assert.equal(await of('99'), null);
});

test('an end covered only by another tree answers with that tree\'s node', async () => {
  const deps = { ...noDb, activeBaseline: async () => null,
    activeRootsForNode: async () => [{ baselineId: Buffer.from('b'), rootIssueId: 1, capturedAt: 5 }],
    readBaselineTree: async () => ({ nodes: [{ logicalNodeId: 'x', currentIssueId: 77, fieldDigests: digests(['issuelinks']) }],
      values: { x: { issuelinks: [onVat15] } } }) };
  assert.deepEqual(await approvedLinksResolver({}, deps)('77'), [onVat15]);
});

test('an approved end whose links were not retained refuses rather than guessing', async () => {
  const deps = { ...noDb, activeBaseline: async () => ({ version: 1, field_digests: digests(['issuelinks']) }),
    readAllValues: async () => ({}) };
  await assert.rejects(() => approvedLinksResolver({}, deps)('5'), error => error.code === 'LINK_CONFLICT' && error.status === 409);
});
