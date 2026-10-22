import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/testmgmt/sourceLinkJob.js').catch(() => ({}));
const ids = ['a', 'b', 'c', 'd'].map(c => c.repeat(32));
async function run(options, deps) { assert.equal(typeof module.run, 'function', 'bounded source-link scheduled job exists'); return module.run(options, deps); }

function world({ pending = ids.slice(0, 2), fail = null } = {}) {
  let time = 1000; const seen = []; let loaded = 0;
  const runtime = async () => { loaded++; return {
    pendingSourceLinkIntents: async limit => { seen.push(['pending', limit]); return pending; },
    syncSourceLinks: async (versionId, options) => { seen.push(['sync', versionId, options]); if (versionId === fail) throw Object.assign(new Error('temporary unavailable'), { reason: 'SERVICE_UNAVAILABLE' });
      return { versionId, state: 'COMMITTED', proof: { seq: 1, entryHash: 'f'.repeat(64) } }; }
  }; };
  return { runtime, clock: () => time, seen, loaded: () => loaded, advance: ms => { time += ms; } };
}

test('scheduled source-link reconciliation processes at most two intents with one shared deadline and write bounds', async () => {
  const w = world({ pending: ids });
  const result = await run({ deadline: 46000, maxIntents: 100, maxWrites: 100 }, w);
  assert.deepEqual(w.seen[0], ['pending', 2]);
  assert.deepEqual(w.seen.filter(x => x[0] === 'sync').map(x => x[1]), ids.slice(0, 2));
  assert.ok(w.seen.filter(x => x[0] === 'sync').every(x => x[2].deadline === 46000 && x[2].maxWrites === 10));
  assert.equal(result.examined, 2); assert.equal(result.committed, 2); assert.equal(result.deferred, 2); assert.equal(result.ok, true);
});

test('an expired scheduler deadline loads no Forge/Jira dependencies and performs no queue read', async () => {
  const w = world(); const result = await run({ deadline: 1000 }, w);
  assert.equal(w.loaded(), 0); assert.equal(w.seen.length, 0); assert.equal(result.examined, 0); assert.equal(result.stopped, 'DEADLINE');
});

test('source-link job rechecks the deadline after dependency load and before each intent', async () => {
  const w = world();
  const original = w.runtime;
  const runtime = async () => { const deps = await original(); const sync = deps.syncSourceLinks;
    deps.syncSourceLinks = async (...args) => { const result = await sync(...args); w.advance(45000); return result; }; return deps; };
  const result = await run({ deadline: 46000 }, { ...w, runtime });
  assert.equal(result.examined, 1); assert.equal(result.committed, 1); assert.equal(result.deferred, 1); assert.equal(result.stopped, 'DEADLINE');
  const noRead = world();
  await run({ deadline: 1100 }, { ...noRead, runtime: async () => { const deps = await noRead.runtime(); noRead.advance(101); return deps; } });
  assert.equal(noRead.seen.length, 0, 'late runtime setup cannot trigger a fresh queue read');
});

test('one failed source projection does not prevent another bounded intent from recovering', async () => {
  const w = world({ fail: ids[0] }); const result = await run({}, w);
  assert.equal(result.ok, false); assert.equal(result.errors, 1); assert.equal(result.examined, 2); assert.equal(result.committed, 1);
  assert.deepEqual(result.failures, [{ versionId: ids[0], reason: 'SERVICE_UNAVAILABLE' }]);
});

test('pending, blocked and superseded source-link results are distinguished from committed receipts', async () => {
  const w = world();
  const runtime = async () => ({ pendingSourceLinkIntents: async () => ids.slice(0, 2), syncSourceLinks: async id => ({ state: id === ids[0] ? 'BLOCKED' : 'PENDING' }) });
  const result = await run({}, { ...w, runtime });
  assert.equal(result.committed, 0); assert.equal(result.blocked, 1); assert.equal(result.pending, 1);
  const superseded = await run({}, { ...w, runtime: async () => ({ pendingSourceLinkIntents: async () => [ids[0]], syncSourceLinks: async () => ({ state: 'SUPERSEDED' }) }) });
  assert.equal(superseded.superseded, 1); assert.equal(superseded.committed, 0);
});

test('queue and row read failures never become an empty successful recovery result', async () => {
  const w = world();
  await assert.rejects(run({}, { ...w, runtime: async () => ({ pendingSourceLinkIntents: async () => { throw Object.assign(new Error('DB down'), { reason: 'SERVICE_UNAVAILABLE' }); } }) }), { reason: 'SERVICE_UNAVAILABLE' });
  const missing = await run({}, { ...w, runtime: async () => ({ pendingSourceLinkIntents: async () => [ids[0]], syncSourceLinks: async () => null }) });
  assert.equal(missing.ok, false); assert.equal(missing.errors, 1); assert.equal(missing.committed, 0);
});

test('a returned COMMITTED state without its durable audit receipt never counts as recovered projection', async () => {
  const w = world();
  const result = await run({}, { ...w, runtime: async () => ({ pendingSourceLinkIntents: async () => [ids[0]],
    syncSourceLinks: async () => ({ versionId: ids[0], state: 'COMMITTED' }) }) });
  assert.equal(result.ok, false); assert.equal(result.committed, 0); assert.equal(result.errors, 1);
  assert.equal(result.failures[0].reason, 'SOURCE_LINK_PROOF_UNAVAILABLE');
});
