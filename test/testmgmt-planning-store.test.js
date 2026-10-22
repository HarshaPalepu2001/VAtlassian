import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/testmgmt/planningStore.js').catch(() => ({}));
const migrations = await import('../src/testmgmt/planningMigrations.js').catch(() => ({}));
function setup() {
  assert.equal(typeof module.createPlanningStore, 'function', 'planning SQL storage exists');
  const calls = []; let result = { result: true, data: [] };
  const store = module.createPlanningStore(async (sql, params) => { calls.push({ sql, params }); return result; });
  return { store, calls, answer: value => { result = value; } };
}
test('collection store reports bounded lists as incomplete and refuses corrupt snapshots', async () => {
  const w = setup();
  const record = { revision_id: 'a'.repeat(32), issue_id: 21, project_id: 100, role: 'PLAN', revision_no: 1, draft_revision: 2,
    content: '{"members":[]}', digest: 'f'.repeat(64), chain: '{"steps":[]}', chain_digest: 'f'.repeat(64), state: 'SIGNED', published_by: 'author', published_at: 1, signed_at: 2 };
  w.answer({ result: true, data: Array.from({ length: 101 }, () => ({ ...record })) });
  const list = await w.store.listCollectionRevisions('21');
  assert.equal(list.complete, false); assert.equal(list.items.length, 100); assert.equal(list.items[0].issueId, '21');
  w.answer({ result: true, data: [{ ...record, content: 'broken-json' }] });
  await assert.rejects(w.store.readCollectionRevision('a'.repeat(32)), { reason: 'RECORDS_INCOMPLETE' });
});
test('planning store refuses failed queries and stale writes', async () => {
  const w = setup(); w.answer({ result: false, error: { message: 'down' } });
  await assert.rejects(w.store.readCollectionDraft('21'), { reason: 'SERVICE_UNAVAILABLE' });
  w.answer({ result: true, data: { affectedRows: 0 } });
  assert.equal(await w.store.saveCollectionDraft({ issueId: '21', projectId: '100', role: 'PLAN', expectedRevision: 2, content: {}, now: 1, actor: 'a' }), null);
  assert.equal(await w.store.setCollectionRevisionState('a'.repeat(32), { from: 'PUBLISHED', to: 'SIGNED', now: 1 }), false);
  await assert.rejects(w.store.setCollectionRevisionState('a'.repeat(32), { from: 'SIGNED', to: 'PUBLISHED', now: 1 }), { reason: 'INVALID_INPUT' });
});
test('a collection publish insertion is conditioned on the exact canonical draft revision', async () => {
  const w = setup(); w.answer({ result: true, data: { affectedRows: 0 } });
  assert.equal(await w.store.insertCollectionRevision({ revisionId: 'a'.repeat(32), issueId: '21', projectId: '100', role: 'PLAN',
    revisionNo: 1, draftRevision: 2, content: {}, digest: 'b'.repeat(64), chain: {}, chainDigest: 'c'.repeat(64), publishedBy: 'author', publishedAt: 1 }), false);
  assert.match(w.calls[0].sql, /SELECT[\s\S]*FROM tm_collection_draft[\s\S]*revision = \?/);
  assert.deepEqual(w.calls[0].params.slice(-4), [21, 100, 'PLAN', 2]);
});
test('planning migrations create canonical revision uniqueness and actual Jira mapped role columns', () => {
  assert.ok(Array.isArray(migrations.PLANNING_MIGRATIONS), 'standalone migration list exists');
  assert.ok(migrations.PLANNING_MIGRATIONS.every(m => m.id.startsWith('tm-planning')));
  const sql = migrations.PLANNING_MIGRATIONS.map(m => m.sql).join('\n');
  assert.match(sql, /UNIQUE KEY[^\n]*\(issue_id, revision_no\)/);
  assert.match(sql, /set_type_id/); assert.match(sql, /precondition_type_id/);
});
