import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVaultSpace, insertVaultSpace, markPermissionLocked, setVaultProjectPage,
  getVaultSite, insertVaultSite, projectsNeedingVault,
  getVaultPage, insertVaultPage,
  isAttachmentVaulted, insertVaultAttachment
} from '../src/db/vaultStore.js';

test('getVaultSpace returns null when no row exists', async () => {
  const space = await getVaultSpace(7, async () => ({ result: true, data: [] }));
  assert.equal(space, null);
});

test('getVaultSpace returns the row when one exists', async () => {
  const space = await getVaultSpace(7, async () => ({ result: true, data: [{ project_id: 7, space_id: 's1', space_key: 'VLTENG' }] }));
  assert.equal(space.space_key, 'VLTENG');
});

test('getVaultSpace fails closed when storage is unavailable', async () => {
  await assert.rejects(
    () => getVaultSpace(7, async () => ({ result: false, error: new Error('down') })),
    /down/
  );
});

test('insertVaultSpace writes project, space and creator', async () => {
  let captured;
  await insertVaultSpace(
    { projectId: 7, spaceId: 's1', spaceKey: 'VATVAULT', projectPageId: 'pp1', createdBy: 'system', now: 100 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
  );
  assert.match(captured.sql, /INSERT INTO va_vault_space/);
  assert.deepEqual(captured.params, [7, 's1', 'VATVAULT', 'pp1', 100, 'system']);
});

test('markPermissionLocked updates the scheme id and timestamp', async () => {
  let captured;
  await markPermissionLocked(
    { projectId: 7, permissionSchemeId: '10000', now: 200 },
    async (sql, params) => {
      if (sql.startsWith('SELECT')) return { result: true, data: [{ '1': 1 }] };
      captured = { sql, params }; return { result: true };
    }
  );
  assert.match(captured.sql, /UPDATE va_vault_space SET permission_scheme_id/);
  assert.deepEqual(captured.params, ['10000', 200, 7]);
});

test('getVaultPage returns null when no page exists yet', async () => {
  const page = await getVaultPage(42, async () => ({ result: true, data: [] }));
  assert.equal(page, null);
});

test('insertVaultPage writes the issue-to-page mapping', async () => {
  let captured;
  await insertVaultPage(
    { issueId: 42, projectId: 7, confluencePageId: 'p1', now: 300 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
  );
  assert.match(captured.sql, /INSERT INTO va_vault_page/);
  assert.deepEqual(captured.params, [42, 7, 'p1', 300]);
});

test('isAttachmentVaulted is false when no row matches', async () => {
  const vaulted = await isAttachmentVaulted({ baselineId: 'b1', jiraAttachmentId: 'a1' }, async () => ({ result: true, data: [] }));
  assert.equal(vaulted, false);
});

test('isAttachmentVaulted is true when a row matches', async () => {
  const vaulted = await isAttachmentVaulted({ baselineId: 'b1', jiraAttachmentId: 'a1' }, async () => ({ result: true, data: [{ '1': 1 }] }));
  assert.equal(vaulted, true);
});

test('insertVaultAttachment generates and returns a fresh id', async () => {
  let captured;
  const id = await insertVaultAttachment(
    { baselineId: 'b1', issueId: 42, jiraAttachmentId: 'a1', filename: 'x.png', contentHash: 'h'.repeat(64), confluenceAttachmentId: 'c1', mediaId: 'm1', now: 400 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
  );
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.match(captured.sql, /INSERT INTO va_vault_attachment/);
  assert.equal(captured.params[0], id);
  assert.deepEqual(captured.params.slice(1), ['b1', 42, 'a1', 'x.png', 'h'.repeat(64), 'c1', 'm1', 400]);
});

test('markPermissionLocked fails when vault space row does not exist', async () => {
  await assert.rejects(
    () => markPermissionLocked({ projectId: 7, permissionSchemeId: '10000' }, async (sql) => {
      if (sql.startsWith('SELECT')) return { result: true, data: [] };
      return { result: true };
    }),
    /not provisioned/
  );
});

test('getVaultSite returns the one site vault, or null before it exists', async () => {
  let captured;
  const none = await getVaultSite(async (sql, params) => { captured = { sql, params }; return { result: true, data: [] }; });
  assert.equal(none, null);
  assert.match(captured.sql, /FROM va_vault_site WHERE id = \?/);
  assert.deepEqual(captured.params, ['SITE']);
  const site = await getVaultSite(async () => ({ result: true, data: [{ space_id: 's1', space_key: 'VATVAULT', homepage_id: 'h1' }] }));
  assert.equal(site.homepage_id, 'h1');
});

test('insertVaultSite records the space under the fixed SITE id', async () => {
  let captured;
  await insertVaultSite({ spaceId: 's1', spaceKey: 'VATVAULT', homepageId: 'h1', createdBy: 'system', now: 5 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; });
  assert.match(captured.sql, /INSERT INTO va_vault_site/);
  assert.deepEqual(captured.params, ['SITE', 's1', 'VATVAULT', 'h1', 5, 'system']);
});

test('setVaultProjectPage links a project row to its page in the site vault', async () => {
  let captured;
  await setVaultProjectPage({ projectId: 7, spaceId: 's1', spaceKey: 'VATVAULT', projectPageId: 'pp1' },
    async (sql, params) => { captured = { sql, params }; return { result: true }; });
  assert.match(captured.sql, /UPDATE va_vault_space SET space_id = \?, space_key = \?, project_page_id = \?/);
  assert.deepEqual(captured.params, ['s1', 'VATVAULT', 'pp1', 7]);
});

test('projectsNeedingVault lists ACTIVE baseline-capturing projects not yet fully provisioned', async () => {
  let captured;
  const ids = await projectsNeedingVault({ limit: 10 }, async (sql, params) => {
    captured = { sql, params };
    return { result: true, data: [{ project_id: 11851 }, { project_id: '42' }] };
  });
  assert.deepEqual(ids, [11851, 42]);
  assert.match(captured.sql, /va_controlled_transition/);
  assert.match(captured.sql, /state = 'ACTIVE'/);
  assert.match(captured.sql, /capture_baseline/);
  assert.match(captured.sql, /project_page_id IS NOT NULL/);
  assert.match(captured.sql, /permission_locked_at IS NOT NULL/);
  assert.match(captured.sql, /app_delete_granted_at IS NOT NULL/, 'a project locked before the app kept its grant is picked up');
  // Forge SQL refuses `LIMIT ?` (ERROR 1210) — the limit is inlined as a checked integer.
  assert.doesNotMatch(captured.sql, /LIMIT \?/);
  assert.match(captured.sql, /LIMIT 10\b/);
  assert.deepEqual(captured.params, []);
});
