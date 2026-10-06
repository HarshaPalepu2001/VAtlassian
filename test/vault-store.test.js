import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVaultSpace, insertVaultSpace, markPermissionLocked, setVaultProjectPage,
  getVaultSite, insertVaultSite, projectsNeedingVault, projectsNeedingLockdown, markPermissionUnlocked, markAppDeleteChecked,
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
  assert.deepEqual(captured.params.slice(1), ['b1', 42, 'a1', 'x.png', 'h'.repeat(64), 'c1', 'm1', 400, 'CONFLUENCE', null]);
});

test('an Object Store copy is recorded with its key and no Confluence attachment', async () => {
  let captured;
  await insertVaultAttachment(
    { baselineId: 'b1', issueId: 42, jiraAttachmentId: 'a1', filename: 'x.png', contentHash: 'h'.repeat(64),
      storage: 'OBJECT_STORE', objectKey: 'vault/sha256/abc', now: 400 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
  );
  assert.match(captured.sql, /storage, object_key/);
  assert.deepEqual(captured.params.slice(6), [null, null, 400, 'OBJECT_STORE', 'vault/sha256/abc']);
});

test('vaultedCopies prefers the newest copy that can be read, and says where each lives', async () => {
  const { vaultedCopies } = await import('../src/db/vaultStore.js');
  const copies = await vaultedCopies({ issueId: 42, attachmentIds: ['a1', 'a2'] }, async (sql) => {
    assert.match(sql, /va\.storage, va\.object_key/);
    return { result: true, data: [
      // newest first, as the query orders them
      { jira_attachment_id: 'a1', storage: 'OBJECT_STORE', object_key: null, media_id: null },
      { jira_attachment_id: 'a1', storage: 'OBJECT_STORE', object_key: 'vault/sha256/k', media_id: 'm1' },
      { jira_attachment_id: 'a2', storage: null, confluence_attachment_id: 'c2', confluence_page_id: 'p', media_id: 'm2' }] };
  });
  assert.equal(copies.get('a1').object_key, 'vault/sha256/k', 'a row with nowhere to read from gives way');
  assert.equal(copies.get('a1').media_id, 'm1');
  assert.equal(copies.get('a2').storage, 'CONFLUENCE', 'a row from before tiers is a Confluence copy');
});

test('ensureVaultProjectRow makes a row with no vault space, once', async () => {
  const { ensureVaultProjectRow } = await import('../src/db/vaultStore.js');
  const inserts = [];
  const made = await ensureVaultProjectRow({ projectId: 7, now: 9 }, async (sql, params) => {
    if (sql.startsWith('SELECT')) return { result: true, data: [] };
    inserts.push(params);
    return { result: true };
  });
  assert.equal(made, true);
  assert.deepEqual(inserts[0], [7, null, null, null, 9, 'system']);
  const again = await ensureVaultProjectRow({ projectId: 7 }, async () => ({ result: true, data: [{ project_id: 7 }] }));
  assert.equal(again, false);
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
  const ids = await projectsNeedingVault({ limit: 10, now: 100_000_000 }, async (sql, params) => {
    captured = { sql, params };
    return { result: true, data: [{ project_id: 11851 }, { project_id: '42' }] };
  });
  assert.deepEqual(ids, [11851, 42]);
  assert.match(captured.sql, /va_controlled_transition/);
  assert.match(captured.sql, /state = 'ACTIVE'/);
  assert.match(captured.sql, /capture_baseline/);
  assert.match(captured.sql, /project_page_id IS NOT NULL/);
  assert.doesNotMatch(captured.sql, /permission_locked_at/, 'the lockdown is opt-in, not part of a finished vault');
  assert.match(captured.sql, /app_delete_granted_at IS NOT NULL/, 'a project without the app grant is picked up');
  assert.match(captured.sql, /app_delete_checked_at > \?/);
  assert.deepEqual(captured.params, [100_000_000 - 24 * 60 * 60 * 1000], 'a refused grant is asked again after a day');
  // Forge SQL refuses `LIMIT ?` (ERROR 1210) — the limit is inlined as a checked integer.
  assert.doesNotMatch(captured.sql, /LIMIT \?/);
  assert.match(captured.sql, /LIMIT 10\b/);
});

test('projectsNeedingLockdown keeps only opted-in projects with a capturing rule and no lock recorded', async () => {
  let captured;
  const ids = await projectsNeedingLockdown([11851, '42', 'x', 11851], async (sql, params) => {
    captured = { sql, params };
    return { result: true, data: [{ project_id: 11851 }] };
  });
  assert.deepEqual(ids, [11851]);
  assert.deepEqual(captured.params, [11851, 42]);
  assert.match(captured.sql, /capture_baseline = 1/);
  assert.match(captured.sql, /permission_locked_at IS NOT NULL/);
});

test('projectsNeedingLockdown with nobody opted in asks nothing', async () => {
  const ids = await projectsNeedingLockdown([], async () => { throw new Error('must not query'); });
  assert.deepEqual(ids, []);
});

test('markPermissionUnlocked clears the lock time so the lockdown can be applied again', async () => {
  let captured;
  await markPermissionUnlocked({ projectId: 7 }, async (sql, params) => { captured = { sql, params }; return { result: true }; });
  assert.match(captured.sql, /SET permission_locked_at = NULL/);
  assert.doesNotMatch(captured.sql, /permission_scheme_id/, 'the scheme the grants came from stays on record');
  assert.deepEqual(captured.params, [7]);
});

test('markAppDeleteChecked records a refused grant', async () => {
  let captured;
  await markAppDeleteChecked({ projectId: 7, now: 5 }, async (sql, params) => { captured = { sql, params }; return { result: true }; });
  assert.match(captured.sql, /app_delete_checked_at = \?/);
  assert.deepEqual(captured.params, [5, 7]);
});

test('identityRecords reads oldest first and records which copy owns each media id', async () => {
  const { identityRecords } = await import('../src/db/vaultStore.js');
  let captured;
  const records = await identityRecords([43903], async (sql, params) => {
    captured = { sql, params };
    return { result: true, data: [
      { issue_id: 43903, attachment_id: '12090', stands_for_id: '12085', media_id: 'm1', stands_for_media_id: 'm0' },
      { issue_id: 43903, attachment_id: '12095', stands_for_id: '12085', media_id: 'm2', stands_for_media_id: 'm0' },
      { issue_id: 43903, attachment_id: '12099', stands_for_id: '12086', media_id: null, stands_for_media_id: 'mx' }] };
  });
  assert.match(captured.sql, /ORDER BY created_at, attachment_id/);
  const entry = records.get(43903);
  assert.deepEqual([...entry.media], [['m1', 'm0'], ['m2', 'm0']]);
  assert.deepEqual([...entry.mediaOwner], [['m1', '12090'], ['m2', '12095']]);
  assert.equal(entry.files.get('12099'), '12086', 'a copy with no media id still stands for its file');
});
