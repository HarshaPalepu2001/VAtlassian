import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/jobs/vaultBackfill.js';

test('provisions every project with a baseline rule whose vault is not complete', async () => {
  const provisioned = [];
  const result = await run({
    projectsWantingLockdown: async () => [],
    projectsNeedingLockdown: async () => [],
    projectsNeedingVault: async ({ limit }) => { assert.equal(limit, 10); return [11851, 42]; },
    provisionVault: async (projectId) => { provisioned.push(projectId); return { errors: [] }; }
  });
  assert.deepEqual(provisioned, [11851, 42]);
  assert.deepEqual(result, { ok: true, checked: 2, provisioned: 2, failed: 0 });
});

test('a project that still fails is counted, and the others still run', async () => {
  const result = await run({
    projectsWantingLockdown: async () => [],
    projectsNeedingLockdown: async () => [],
    projectsNeedingVault: async () => [1, 2],
    provisionVault: async (projectId) => ({ errors: projectId === 1 ? [{ step: 'ensureAppDeleteGrant', error: '401' }] : [] })
  });
  assert.deepEqual(result, { ok: true, checked: 2, provisioned: 1, failed: 1 });
});

test('nothing to do costs nothing', async () => {
  let called = false;
  const result = await run({ projectsNeedingVault: async () => [], projectsWantingLockdown: async () => [],
    projectsNeedingLockdown: async () => { throw new Error('nobody opted in: must not query'); },
    provisionVault: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.checked, 0);
});

test('an opted-in project not yet locked is provisioned once, even when its vault is also unfinished', async () => {
  const provisioned = [];
  const result = await run({
    projectsNeedingVault: async () => [42],
    projectsWantingLockdown: async () => [42, 7],
    projectsNeedingLockdown: async (ids) => { assert.deepEqual(ids, [42, 7]); return [42, 7]; },
    provisionVault: async (projectId) => { provisioned.push(projectId); return { errors: [] }; }
  });
  assert.deepEqual(provisioned, [42, 7]);
  assert.equal(result.checked, 2);
});
