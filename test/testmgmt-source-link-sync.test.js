import test from 'node:test';
import assert from 'node:assert/strict';
import { contentDigest } from '../src/testmgmt/content.js';
const module = await import('../src/testmgmt/sourceLinkSync.js').catch(() => ({}));
function world() {
  const ref = { issueId: '42', issueKey: 'VAT-42', projectId: '100', siteId: 'site', linkTypeId: '10' };
  const v = { versionId: 'a'.repeat(32), testIssueId: '11', projectId: '100', versionNo: 1, state: 'SIGNED',
    content: { parentIssueId: '1', verifies: [ref] } }; v.digest = contentDigest(v.content);
  const w = { version: v, versions: new Map(), rows: new Map(), links: [], writes: [], blocked: new Set(), claim: false, audits: 0, hidden: false };
  const issue = id => ({ id, key: `VAT-${id}`, fields: { project: { id: '100' }, issuetype: { id: id === '11' ? '1' : '7' }, parent: { id: '1' } } });
  const deps = { now: () => 1000, newHexId: () => 'f'.repeat(32), readVersion: async id => structuredClone(w.versions.get(id) ?? w.version),
    latestSignedVersion: async () => structuredClone(w.version), verifyVersionProof: async () => ({ ok: true }),
    readProject: async () => ({ enabled: true, projectId: '100', testTypeId: '1', sourceLinkTypeId: '10' }),
    readIssueAsApp: async id => issue(String(id)), readIssueAsUser: async id => { if (w.hidden) throw new Error('hidden'); return issue(String(id)); },
    insertSourceLinkIntent: async row => { if (!w.rows.has(row.versionId)) w.rows.set(row.versionId, structuredClone(row)); },
    readSourceLinkIntent: async id => structuredClone(w.rows.get(id) ?? null),
    latestCommittedSourceLinks: async () => null,
    latestSourceLinkIntent: async (_id, { beforeVersionNo }) => structuredClone([...w.rows.values()].filter(r => r.versionNo < beforeVersionNo).sort((a,b) => b.versionNo-a.versionNo)[0] ?? null),
    setSourceLinkIntentState: async (id, state, problem = null, proof = null) => { Object.assign(w.rows.get(id), { state, problem, proof }); return true; },
    claimSourceLinkLease: async () => { if (w.claim) return false; w.claim = true; return true; },
    ownsSourceLinkLease: async () => w.claim, releaseSourceLinkLease: async () => { w.claim = false; },
    readSourceLinksAsApp: async () => ({ complete: true, links: structuredClone(w.links) }),
    readSourceLinksAsUser: async () => { if (w.hidden) throw new Error('hidden'); return { complete: true, links: structuredClone(w.links) }; },
    sourceLinkMutationAllowed: async ({ sourceIssueId }) => !w.blocked.has(sourceIssueId),
    createSourceLink: async args => { w.writes.push(args); w.links.push({ id: String(w.links.length + 1), typeId: args.typeId, sourceIssueId: args.sourceIssueId, direction: 'OUTWARD' }); },
    deleteSourceLink: async id => { w.writes.push({ delete: id }); w.links = w.links.filter(link => link.id !== id); },
    auditSourceLinkCommit: async () => { w.audits++; return { seq: w.audits, entryHash: 'c'.repeat(64) }; }
  };
  assert.equal(typeof module.createSourceLinkSync, 'function', 'native signed-link outbox must exist');
  return { w, deps, uc: module.createSourceLinkSync(deps) };
}
test('only an audit-proved signed version can enqueue native links; drafts never mirror', async () => {
  const { w, uc } = world();
  w.version.state = 'PUBLISHED';
  await assert.rejects(uc.enqueue(w.version), { reason: 'VERSION_PROOF_INVALID' });
  assert.equal(w.rows.size, 0); assert.equal(w.writes.length, 0);
});
test('native projection is durable, idempotent and proof comes from exact Jira readback', async () => {
  const { w, uc } = world(); await uc.enqueue(w.version);
  await uc.sync(w.version.versionId); await uc.sync(w.version.versionId);
  assert.equal(w.writes.length, 1); assert.equal(w.rows.get(w.version.versionId).state, 'COMMITTED');
  assert.equal((await uc.verify(w.version, { accountId: 'viewer' })).ok, true);
  w.links = [];
  assert.equal((await uc.verify(w.version, { accountId: 'viewer' })).ok, false, 'external deletion invalidates governed coverage');
  await uc.sync(w.version.versionId);
  assert.equal(w.writes.length, 1, 'committed history is never silently restored over an external edit');
});
test('any incompatible endpoint baseline blocks the entire mirror before Jira changes', async () => {
  const { w, uc } = world(); w.blocked.add('42');
  await uc.enqueue(w.version); await uc.sync(w.version.versionId);
  assert.equal(w.rows.get(w.version.versionId).state, 'BLOCKED'); assert.equal(w.writes.length, 0);
});
test('external extra or reversed Verifies links are never deleted or treated as matching signed scope', async () => {
  const { w, uc } = world();
  w.links.push({ id: 'x', typeId: '10', sourceIssueId: '99', direction: 'OUTWARD' });
  await uc.enqueue(w.version); await uc.sync(w.version.versionId);
  assert.equal(w.rows.get(w.version.versionId).state, 'BLOCKED'); assert.equal(w.writes.length, 0);
});
test('viewer visibility is rechecked before any projection metadata can prove coverage', async () => {
  const { w, uc } = world(); await uc.enqueue(w.version); await uc.sync(w.version.versionId); w.hidden = true;
  assert.equal((await uc.verify(w.version, { accountId: 'viewer' })).ok, false);
});
test('incomplete Jira link reads and a busy writer never turn into committed proof', async () => {
  const { w, uc, deps } = world(); await uc.enqueue(w.version); w.claim = true;
  await uc.sync(w.version.versionId); assert.equal(w.writes.length, 0);
  w.claim = false; deps.readSourceLinksAsApp = async () => ({ complete: false, links: [] });
  await uc.sync(w.version.versionId); assert.notEqual(w.rows.get(w.version.versionId).state, 'COMMITTED');
});

test('a corrupted outbox cannot replace the signed relationship scope or delete unrelated Jira links', async () => {
  const { w, uc } = world(); await uc.enqueue(w.version);
  w.rows.get(w.version.versionId).desired = ['99'];
  await assert.rejects(uc.sync(w.version.versionId), { reason: 'CONTENT_CHANGED' });
  assert.equal(w.writes.length, 0);
  assert.equal((await uc.verify(w.version, { accountId: 'viewer' })).ok, false);
});

test('a new signed version can clean a partially projected earlier signed scope', async () => {
  const { w, uc } = world();
  w.version.content.verifies.push({ ...w.version.content.verifies[0], issueId: '43' });
  w.version.digest = contentDigest(w.version.content);
  await uc.enqueue(w.version);
  await uc.sync(w.version.versionId, { maxWrites: 1 });
  assert.equal(w.rows.get(w.version.versionId).state, 'PENDING');
  assert.equal(w.links.length, 1);
  w.versions.set(w.version.versionId, structuredClone(w.version));
  w.version = { ...w.version, versionId: 'b'.repeat(32), versionNo: 2,
    content: { ...w.version.content, verifies: [{ ...w.version.content.verifies[0], issueId: '44' }] } };
  w.version.digest = contentDigest(w.version.content);
  await uc.enqueue(w.version); await uc.sync(w.version.versionId);
  assert.equal(w.rows.get(w.version.versionId).state, 'COMMITTED');
  assert.deepEqual(w.links.map(l => l.sourceIssueId), ['44']);
});

test('a stale waiter rechecks committed state after obtaining the lease', async () => {
  const { w, uc, deps } = world(); await uc.enqueue(w.version);
  deps.claimSourceLinkLease = async () => { w.claim = true; w.rows.get(w.version.versionId).state = 'COMMITTED'; return true; };
  await uc.sync(w.version.versionId);
  assert.equal(w.writes.length, 0);
  assert.equal(w.audits, 0);
});

test('deadline expiry or a newer signed version stops writes and keeps resumable state', async () => {
  const { w, uc, deps } = world(); await uc.enqueue(w.version);
  await uc.sync(w.version.versionId, { deadline: 999 });
  assert.equal(w.writes.length, 0);
  assert.equal(w.rows.get(w.version.versionId).state, 'PENDING');
  let reads = 0;
  deps.latestSignedVersion = async () => ++reads === 1 ? w.version : { ...w.version, versionId: 'b'.repeat(32) };
  await uc.sync(w.version.versionId);
  assert.equal(w.writes.length, 0);
});

test('endpoint policy is rechecked at the write boundary after complete preflight', async () => {
  const { w, uc, deps } = world(); let checks = 0;
  deps.sourceLinkMutationAllowed = async () => ++checks === 1;
  await uc.enqueue(w.version); await uc.sync(w.version.versionId);
  assert.equal(w.writes.length, 0);
  assert.equal(w.rows.get(w.version.versionId).problem, 'SOURCE_LINK_POLICY_BLOCKED');
});

test('an empty signed history may adopt its first configured Verifies type', async () => {
  for (const firstType of [null, '9']) {
    const { w, uc, deps } = world(); let typeId = firstType;
    deps.readProject = async () => ({ enabled: true, projectId: '100', testTypeId: '1', sourceLinkTypeId: typeId });
    const ref = w.version.content.verifies[0];
    w.version.content.verifies = []; w.version.digest = contentDigest(w.version.content);
    await uc.enqueue(w.version); await uc.sync(w.version.versionId);
    assert.equal(w.rows.get(w.version.versionId).state, 'COMMITTED');
    w.versions.set(w.version.versionId, structuredClone(w.version)); typeId = '10';
    w.version = { ...w.version, versionId: 'b'.repeat(32), versionNo: 2, content: { ...w.version.content, verifies: [ref] } };
    w.version.digest = contentDigest(w.version.content);
    await uc.enqueue(w.version); await uc.sync(w.version.versionId);
    assert.equal(w.rows.get(w.version.versionId).state, 'COMMITTED');
    assert.deepEqual(w.links.map(link => link.sourceIssueId), ['42']);
  }
});
