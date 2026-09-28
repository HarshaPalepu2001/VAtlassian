# Confluence Attachment Vault (Phases 1 & 2) Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Jira project gets a controlled transition with `capture_baseline = true`, silently provision a dedicated, locked-down Confluence space for it and block attachment deletion project-wide; when a baseline is captured for an issue in such a project, push a copy of its current attachments into that vault as durable, hashed evidence.

**Architecture:** Two new orchestration points hang off existing code: `usecases/transitions.js` (where `capture_baseline` gets turned on) triggers space creation + permission lockdown synchronously; `usecases/drift.js`'s `applyApproval` (where a baseline is actually captured) enqueues attachment vaulting onto a new Forge queue, processed by a new worker, mirroring the existing `va-restore-queue`/`restoreWorker.js` pattern. All of it is best-effort and audited — nothing here can fail an approval or a config save.

**Tech Stack:** Node.js (Forge app runtime), `@forge/api` (Jira/Confluence REST), `@forge/sql`, `@forge/events` (Queue), `node:test`/`node:assert/strict` for tests.

**Spec:** [docs/specs/2026-09-22-confluence-attachment-vault-design.md](../specs/2026-09-22-confluence-attachment-vault-design.md)

## Global Constraints

- No new Forge permission scopes — `write:confluence-space`, `write:confluence-content`, `read:confluence-content.all`, `manage:jira-configuration` are already declared in `manifest.yml`.
- Every new DB access function accepts an injectable query function (`query = executeQuery` default param), matching `src/db/driftStore.js`'s pattern, so it's unit-testable without a live Forge SQL connection.
- Every new orchestration function accepts an injectable `deps` object with real defaults, matching `src/lib/capture.js`/`src/jobs/restoreWorker.js`'s pattern.
- Nothing in this plan may cause `createControlledTransition`, `updateControlledTransition`, or `applyApproval` to fail because of a vaulting/lockdown problem. Every call site catches, logs to console, and appends a best-effort audit event via `tryAppend`.
- Test command: `node --test test/*.test.js` (from `package.json`'s `"test"` script). Run the exact new test file after writing it, then the full suite before each commit that touches shared files (`ledger.js`, `migrations.js`, `transitions.js`, `approval.js`).

---

## Task 1: Migrations and audit event constants

**Files:**
- Modify: `src/db/migrations.js` (append after the last entry, `v055_va_events`)
- Modify: `src/lib/ledger.js:293` (inside the `EVENT` object, before the closing `};`)
- Test: `test/migrations.test.js` (append new tests)

**Interfaces:**
- Produces: three new tables — `va_vault_space(project_id PK, space_id, space_key, permission_scheme_id, permission_locked_at, created_at, created_by)`, `va_vault_page(issue_id PK, project_id, confluence_page_id, created_at)`, `va_vault_attachment(id PK, baseline_id, issue_id, jira_attachment_id, filename, content_hash, confluence_attachment_id, vaulted_at, UNIQUE(baseline_id, jira_attachment_id))`.
- Produces: `EVENT.VAULT_SPACE_CREATED`, `EVENT.VAULT_SPACE_CREATE_FAILED`, `EVENT.ATTACHMENT_DELETE_LOCKED`, `EVENT.ATTACHMENT_DELETE_LOCK_FAILED`, `EVENT.VAULT_QUEUE_FAILED`, `EVENT.ATTACHMENT_VAULTED`, `EVENT.ATTACHMENT_VAULT_FAILED`.

- [ ] **Step 1: Write the failing migration tests**

Append to `test/migrations.test.js`:

```js
test('vault space is keyed by project and records its permission lockdown', () => {
  const sql = sqlFor('v056_vault_space');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS va_vault_space/);
  assert.match(sql, /PRIMARY KEY \(project_id\)/);
  for (const column of ['space_id', 'space_key', 'permission_scheme_id', 'permission_locked_at', 'created_at', 'created_by']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`), `missing ${column}`);
  }
});

test('vault page is keyed by issue', () => {
  const sql = sqlFor('v057_vault_page');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS va_vault_page/);
  assert.match(sql, /PRIMARY KEY \(issue_id\)/);
  assert.match(sql, /confluence_page_id/);
});

test('vault attachment is unique per baseline and jira attachment', () => {
  const sql = sqlFor('v058_vault_attachment');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS va_vault_attachment/);
  assert.match(sql, /UNIQUE KEY uq_vault_attachment_baseline \(baseline_id, jira_attachment_id\)/);
  assert.match(sql, /content_hash CHAR\(64\) NOT NULL/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/migrations.test.js`
Expected: FAIL — `Migration v056_vault_space not found` (and similarly for v057/v058).

- [ ] **Step 3: Add the migrations**

Append to the `MIGRATIONS` array in `src/db/migrations.js`, right after the `v055_va_events` entry:

```js
  { id: 'v056_vault_space', sql: `CREATE TABLE IF NOT EXISTS va_vault_space (
    project_id BIGINT NOT NULL,
    space_id VARCHAR(64) NOT NULL,
    space_key VARCHAR(64) NOT NULL,
    permission_scheme_id VARCHAR(64) NULL,
    permission_locked_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (project_id)
  )` },
  { id: 'v057_vault_page', sql: `CREATE TABLE IF NOT EXISTS va_vault_page (
    issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    confluence_page_id VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (issue_id)
  )` },
  { id: 'v058_vault_attachment', sql: `CREATE TABLE IF NOT EXISTS va_vault_attachment (
    id VARCHAR(32) NOT NULL,
    baseline_id VARCHAR(128) NOT NULL,
    issue_id BIGINT NOT NULL,
    jira_attachment_id VARCHAR(64) NOT NULL,
    filename VARCHAR(512) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    confluence_attachment_id VARCHAR(64) NOT NULL,
    vaulted_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_vault_attachment_baseline (baseline_id, jira_attachment_id)
  )` }
```

Note: keep `v055_va_events` as the final entry in the array *before* these three — do not reorder existing entries.

Add the seven new event constants to `src/lib/ledger.js`'s `EVENT` object, replacing the closing line:

```js
  TREE_RESTORE_VERIFIED: 'TREE_RESTORE_VERIFIED',
  VAULT_SPACE_CREATED: 'VAULT_SPACE_CREATED',
  VAULT_SPACE_CREATE_FAILED: 'VAULT_SPACE_CREATE_FAILED',
  ATTACHMENT_DELETE_LOCKED: 'ATTACHMENT_DELETE_LOCKED',
  ATTACHMENT_DELETE_LOCK_FAILED: 'ATTACHMENT_DELETE_LOCK_FAILED',
  VAULT_QUEUE_FAILED: 'VAULT_QUEUE_FAILED',
  ATTACHMENT_VAULTED: 'ATTACHMENT_VAULTED',
  ATTACHMENT_VAULT_FAILED: 'ATTACHMENT_VAULT_FAILED'
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/migrations.test.js`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js src/lib/ledger.js test/migrations.test.js
git commit -m "feat(vault): add vault space/page/attachment tables and audit events"
```

---

## Task 2: `src/db/vaultStore.js` — DB access layer

**Files:**
- Create: `src/db/vaultStore.js`
- Test: `test/vault-store.test.js`

**Interfaces:**
- Consumes: `executeQuery` from `../lib/db.js`, `newId` from `./store.js`.
- Produces: `getVaultSpace(projectId, query?)`, `insertVaultSpace({projectId, spaceId, spaceKey, createdBy, now?}, query?)`, `markPermissionLocked({projectId, permissionSchemeId, now?}, query?)`, `getVaultPage(issueId, query?)`, `insertVaultPage({issueId, projectId, confluencePageId, now?}, query?)`, `isAttachmentVaulted({baselineId, jiraAttachmentId}, query?)`, `insertVaultAttachment({baselineId, issueId, jiraAttachmentId, filename, contentHash, confluenceAttachmentId, now?}, query?)` (returns the generated `id`).

- [ ] **Step 1: Write the failing tests**

Create `test/vault-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVaultSpace, insertVaultSpace, markPermissionLocked,
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
    { projectId: 7, spaceId: 's1', spaceKey: 'VLTENG', createdBy: 'system', now: 100 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
  );
  assert.match(captured.sql, /INSERT INTO va_vault_space/);
  assert.deepEqual(captured.params, [7, 's1', 'VLTENG', 100, 'system']);
});

test('markPermissionLocked updates the scheme id and timestamp', async () => {
  let captured;
  await markPermissionLocked(
    { projectId: 7, permissionSchemeId: '10000', now: 200 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
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
    { baselineId: 'b1', issueId: 42, jiraAttachmentId: 'a1', filename: 'x.png', contentHash: 'h'.repeat(64), confluenceAttachmentId: 'c1', now: 400 },
    async (sql, params) => { captured = { sql, params }; return { result: true }; }
  );
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.match(captured.sql, /INSERT INTO va_vault_attachment/);
  assert.equal(captured.params[0], id);
  assert.deepEqual(captured.params.slice(1), ['b1', 42, 'a1', 'x.png', 'h'.repeat(64), 'c1', 400]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/vault-store.test.js`
Expected: FAIL — `Cannot find module '../src/db/vaultStore.js'`.

- [ ] **Step 3: Implement `src/db/vaultStore.js`**

```js
import { executeQuery } from '../lib/db.js';
import { newId } from './store.js';

export async function getVaultSpace(projectId, query = executeQuery) {
  const rows = await query(
    'SELECT project_id, space_id, space_key, permission_scheme_id, permission_locked_at, created_at, created_by FROM va_vault_space WHERE project_id = ?',
    [projectId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault space storage is unavailable');
  return rows.data?.[0] ?? null;
}

export async function insertVaultSpace({ projectId, spaceId, spaceKey, createdBy, now = Date.now() }, query = executeQuery) {
  const rows = await query(
    'INSERT INTO va_vault_space (project_id, space_id, space_key, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
    [projectId, spaceId, spaceKey, now, createdBy]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record vault space');
}

export async function markPermissionLocked({ projectId, permissionSchemeId, now = Date.now() }, query = executeQuery) {
  const rows = await query(
    'UPDATE va_vault_space SET permission_scheme_id = ?, permission_locked_at = ? WHERE project_id = ?',
    [permissionSchemeId, now, projectId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record permission lockdown');
}

export async function getVaultPage(issueId, query = executeQuery) {
  const rows = await query(
    'SELECT issue_id, project_id, confluence_page_id, created_at FROM va_vault_page WHERE issue_id = ?',
    [issueId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault page storage is unavailable');
  return rows.data?.[0] ?? null;
}

export async function insertVaultPage({ issueId, projectId, confluencePageId, now = Date.now() }, query = executeQuery) {
  const rows = await query(
    'INSERT INTO va_vault_page (issue_id, project_id, confluence_page_id, created_at) VALUES (?, ?, ?, ?)',
    [issueId, projectId, confluencePageId, now]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record vault page');
}

export async function isAttachmentVaulted({ baselineId, jiraAttachmentId }, query = executeQuery) {
  const rows = await query(
    'SELECT 1 FROM va_vault_attachment WHERE baseline_id = ? AND jira_attachment_id = ?',
    [baselineId, jiraAttachmentId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault attachment storage is unavailable');
  return (rows.data?.length ?? 0) > 0;
}

export async function insertVaultAttachment(
  { baselineId, issueId, jiraAttachmentId, filename, contentHash, confluenceAttachmentId, now = Date.now() },
  query = executeQuery
) {
  const id = newId().toString('hex');
  const rows = await query(
    `INSERT INTO va_vault_attachment
       (id, baseline_id, issue_id, jira_attachment_id, filename, content_hash, confluence_attachment_id, vaulted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, baselineId, issueId, jiraAttachmentId, filename, contentHash, confluenceAttachmentId, now]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record vaulted attachment');
  return id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/vault-store.test.js`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/vaultStore.js test/vault-store.test.js
git commit -m "feat(vault): add vault space/page/attachment DB access layer"
```

---

## Task 3: `src/lib/vaultConfluence.js` — Confluence I/O

**Files:**
- Create: `src/lib/vaultConfluence.js`
- Test: `test/vault-confluence.test.js`

**Interfaces:**
- Consumes: `@forge/api` default export (`api`) and `route`.
- Produces: `deriveSpaceKey(projectKey)` (pure), `findSpaceByKey(spaceKey, forgeApi?)`, `createSpace({spaceKey, name}, forgeApi?)`, `restrictSpacePermissions(spaceKey, forgeApi?)`, `createVaultPage({spaceId, issueKey}, forgeApi?)`, `uploadAttachmentToPage({pageId, filename, buffer}, forgeApi?)`.

- [ ] **Step 1: Write the failing tests**

Create `test/vault-confluence.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSpaceKey, findSpaceByKey, createSpace, restrictSpacePermissions,
  createVaultPage, uploadAttachmentToPage
} from '../src/lib/vaultConfluence.js';

function fakeApi(handler) {
  return { asApp: () => ({ requestConfluence: handler }) };
}

test('deriveSpaceKey uppercases and strips non-alphanumerics', () => {
  assert.equal(deriveSpaceKey('eng'), 'VLTENG');
  assert.equal(deriveSpaceKey('My-Proj 1'), 'VLTMYPROJ1');
});

test('deriveSpaceKey refuses an empty project key', () => {
  assert.throws(() => deriveSpaceKey(''), /empty project key/);
});

test('findSpaceByKey returns the first match or null', async () => {
  const found = await findSpaceByKey('VLTENG', fakeApi(async () => ({ ok: true, json: async () => ({ results: [{ id: 's1', key: 'VLTENG' }] }) })));
  assert.equal(found.id, 's1');
  const missing = await findSpaceByKey('VLTENG', fakeApi(async () => ({ ok: true, json: async () => ({ results: [] }) })));
  assert.equal(missing, null);
});

test('createSpace posts key and name and returns the created space', async () => {
  let captured;
  const space = await createSpace({ spaceKey: 'VLTENG', name: 'VAtlassian Vault — ENG' }, fakeApi(async (path, init) => {
    captured = { path: path.value, init };
    return { ok: true, json: async () => ({ id: 's1', key: 'VLTENG' }) };
  }));
  assert.equal(space.id, 's1');
  assert.match(captured.path, /\/wiki\/api\/v2\/spaces$/);
  assert.deepEqual(JSON.parse(captured.init.body), { key: 'VLTENG', name: 'VAtlassian Vault — ENG' });
});

test('createSpace on a 409 adopts the existing space by key instead of failing', async () => {
  let call = 0;
  const forgeApi = fakeApi(async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 409 };
    return { ok: true, json: async () => ({ results: [{ id: 's1', key: 'VLTENG' }] }) };
  });
  const space = await createSpace({ spaceKey: 'VLTENG', name: 'x' }, forgeApi);
  assert.equal(space.id, 's1');
});

test('createSpace throws when the create fails for a reason other than a conflict', async () => {
  await assert.rejects(
    () => createSpace({ spaceKey: 'VLTENG', name: 'x' }, fakeApi(async () => ({ ok: false, status: 500 }))),
    /Failed to create Confluence space/
  );
});

test('restrictSpacePermissions removes every existing grant', async () => {
  const deleted = [];
  const forgeApi = fakeApi(async (path, init) => {
    if (!init) return { ok: true, json: async () => ({ results: [{ id: 'g1' }, { id: 'g2' }] }) };
    deleted.push(path.value);
    return { ok: true };
  });
  await restrictSpacePermissions('VLTENG', forgeApi);
  assert.equal(deleted.length, 2);
  assert.match(deleted[0], /permission\/g1$/);
  assert.match(deleted[1], /permission\/g2$/);
});

test('createVaultPage posts a page titled with the issue key', async () => {
  let captured;
  const page = await createVaultPage({ spaceId: 's1', issueKey: 'ENG-1' }, fakeApi(async (path, init) => {
    captured = { path: path.value, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ id: 'p1' }) };
  }));
  assert.equal(page.id, 'p1');
  assert.equal(captured.body.title, 'ENG-1');
  assert.equal(captured.body.spaceId, 's1');
});

test('uploadAttachmentToPage posts multipart form data with the filename', async () => {
  let captured;
  const uploaded = await uploadAttachmentToPage(
    { pageId: 'p1', filename: 'evidence.png', buffer: Buffer.from('bytes') },
    fakeApi(async (path, init) => {
      captured = { path: path.value, init };
      return { ok: true, json: async () => ({ results: [{ id: 'att1' }] }) };
    })
  );
  assert.equal(uploaded.id, 'att1');
  assert.match(captured.path, /\/wiki\/rest\/api\/content\/p1\/child\/attachment$/);
  assert.match(captured.init.body.toString('utf8'), /filename="evidence\.png"/);
  assert.match(captured.init.body.toString('utf8'), /bytes/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/vault-confluence.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/vaultConfluence.js`**

```js
import api, { route } from '@forge/api';

export function deriveSpaceKey(projectKey) {
  const cleaned = String(projectKey ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) throw new Error('Cannot derive a vault space key from an empty project key');
  return `VLT${cleaned}`.slice(0, 64);
}

export async function findSpaceByKey(spaceKey, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${spaceKey}`);
  if (!res.ok) throw new Error(`Failed to look up Confluence space ${spaceKey}: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? null;
}

export async function createSpace({ spaceKey, name }, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: spaceKey, name })
  });
  if (res.status === 409) {
    const existing = await findSpaceByKey(spaceKey, forgeApi);
    if (existing) return existing;
    throw new Error(`Confluence reported space key ${spaceKey} already exists but it could not be found`);
  }
  if (!res.ok) throw new Error(`Failed to create Confluence space ${spaceKey}: ${res.status}`);
  return res.json();
}

/**
 * A freshly created space's only grants are Confluence's own defaults, so
 * removing all of them (rather than filtering by subject) is safe here
 * specifically — this must never be called against a pre-existing space.
 *
 * VERIFY AGAINST THE LIVE TEST SITE: confirm the legacy permission-list shape
 * below matches what a new space actually receives, and that DELETE removes
 * access rather than erroring when the last grant for an operation is removed.
 */
export async function restrictSpacePermissions(spaceKey, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/rest/api/space/${spaceKey}/permission`);
  if (!res.ok) throw new Error(`Failed to read permissions for space ${spaceKey}: ${res.status}`);
  const data = await res.json();
  for (const grant of data.results ?? []) {
    const delRes = await forgeApi.asApp().requestConfluence(
      route`/wiki/rest/api/space/${spaceKey}/permission/${grant.id}`, { method: 'DELETE' }
    );
    if (!delRes.ok && delRes.status !== 404) {
      throw new Error(`Failed to remove space permission ${grant.id} on ${spaceKey}: ${delRes.status}`);
    }
  }
}

export async function createVaultPage({ spaceId, issueKey }, forgeApi = api) {
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spaceId, status: 'current', title: issueKey,
      body: { representation: 'storage', value: `<p>Vaulted attachment evidence for ${issueKey}.</p>` }
    })
  });
  if (!res.ok) throw new Error(`Failed to create vault page for ${issueKey}: ${res.status}`);
  return res.json();
}

export async function uploadAttachmentToPage({ pageId, filename, buffer }, forgeApi = api) {
  const boundary = '----VAtlassianVault' + Math.random().toString(36).slice(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header, 'utf8'), buffer, Buffer.from(footer, 'utf8')]);
  const res = await forgeApi.asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/child/attachment`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'nocheck', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error(`Failed to upload attachment ${filename} to page ${pageId}: ${res.status}`);
  const data = await res.json();
  return data.results?.[0] ?? data;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/vault-confluence.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vaultConfluence.js test/vault-confluence.test.js
git commit -m "feat(vault): add Confluence space/page/attachment API adapter"
```

---

## Task 4: `src/lib/vaultPermissions.js` — Jira permission-scheme lockdown

**Files:**
- Create: `src/lib/vaultPermissions.js`
- Test: `test/vault-permissions.test.js`

**Interfaces:**
- Consumes: `@forge/api` default export and `route`.
- Produces: `getProjectPermissionScheme(projectId, forgeApi?)`, `attachmentDeleteGrantIds(scheme)` (pure), `removeAttachmentDeleteGrants({schemeId, grantIds}, forgeApi?)`.

- [ ] **Step 1: Write the failing tests**

Create `test/vault-permissions.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants } from '../src/lib/vaultPermissions.js';

function fakeApi(handler) {
  return { asApp: () => ({ requestJira: handler }) };
}

test('getProjectPermissionScheme reads the scheme for a project', async () => {
  const scheme = await getProjectPermissionScheme(7, fakeApi(async () => ({ ok: true, json: async () => ({ id: 10000, name: 'Default', permissions: [] }) })));
  assert.equal(scheme.id, 10000);
});

test('getProjectPermissionScheme throws on a failed read', async () => {
  await assert.rejects(
    () => getProjectPermissionScheme(7, fakeApi(async () => ({ ok: false, status: 404 }))),
    /Failed to read permission scheme/
  );
});

test('attachmentDeleteGrantIds finds only the two attachment-delete permission types', () => {
  const scheme = { permissions: [
    { id: 1, permission: 'DELETE_OWN_ATTACHMENTS' },
    { id: 2, permission: 'DELETE_ALL_ATTACHMENTS' },
    { id: 3, permission: 'EDIT_ISSUES' }
  ] };
  assert.deepEqual(attachmentDeleteGrantIds(scheme), [1, 2]);
});

test('attachmentDeleteGrantIds returns an empty list when the scheme has none', () => {
  assert.deepEqual(attachmentDeleteGrantIds({ permissions: [] }), []);
  assert.deepEqual(attachmentDeleteGrantIds({}), []);
});

test('removeAttachmentDeleteGrants deletes every grant id from the scheme', async () => {
  const deleted = [];
  await removeAttachmentDeleteGrants({ schemeId: 10000, grantIds: [1, 2] }, fakeApi(async (path) => {
    deleted.push(path.value);
    return { ok: true };
  }));
  assert.equal(deleted.length, 2);
  assert.match(deleted[0], /permissionscheme\/10000\/permission\/1$/);
  assert.match(deleted[1], /permissionscheme\/10000\/permission\/2$/);
});

test('removeAttachmentDeleteGrants tolerates a grant already gone (404)', async () => {
  await removeAttachmentDeleteGrants({ schemeId: 10000, grantIds: [1] }, fakeApi(async () => ({ ok: false, status: 404 })));
});

test('removeAttachmentDeleteGrants throws on a real failure', async () => {
  await assert.rejects(
    () => removeAttachmentDeleteGrants({ schemeId: 10000, grantIds: [1] }, fakeApi(async () => ({ ok: false, status: 500 }))),
    /Failed to remove permission grant/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/vault-permissions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/vaultPermissions.js`**

```js
import api, { route } from '@forge/api';

const ATTACHMENT_DELETE_PERMISSIONS = ['DELETE_OWN_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS'];

export async function getProjectPermissionScheme(projectId, forgeApi = api) {
  const res = await forgeApi.asApp().requestJira(route`/rest/api/3/project/${projectId}/permissionscheme`);
  if (!res.ok) throw new Error(`Failed to read permission scheme for project ${projectId}: ${res.status}`);
  return res.json();
}

export function attachmentDeleteGrantIds(scheme) {
  return (scheme?.permissions ?? [])
    .filter((p) => ATTACHMENT_DELETE_PERMISSIONS.includes(p.permission))
    .map((p) => p.id);
}

export async function removeAttachmentDeleteGrants({ schemeId, grantIds }, forgeApi = api) {
  for (const grantId of grantIds) {
    const res = await forgeApi.asApp().requestJira(
      route`/rest/api/3/permissionscheme/${schemeId}/permission/${grantId}`, { method: 'DELETE' }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to remove permission grant ${grantId} from scheme ${schemeId}: ${res.status}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/vault-permissions.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vaultPermissions.js test/vault-permissions.test.js
git commit -m "feat(vault): add Jira permission-scheme attachment-delete lockdown"
```

---

## Task 5: `src/lib/vaultProvision.js` — orchestration

**Files:**
- Create: `src/lib/vaultProvision.js`
- Test: `test/vault-provision.test.js`

**Interfaces:**
- Consumes: `getVaultSpace`, `insertVaultSpace`, `markPermissionLocked` from `../db/vaultStore.js`; `deriveSpaceKey`, `createSpace`, `restrictSpacePermissions` from `./vaultConfluence.js` (`findSpaceByKey` is used internally by `createSpace` on a 409 and is not called directly here); `getProjectPermissionScheme`, `attachmentDeleteGrantIds`, `removeAttachmentDeleteGrants` from `./vaultPermissions.js`; `tryAppend` from `../db/store.js`; `EVENT` from `./ledger.js`; `api`, `route` from `@forge/api`.
- Produces: `ensureVaultSpace(projectId, deps?)` → `{created, spaceId, spaceKey}`; `lockAttachmentDeletion(projectId, deps?)` → `{schemeId, grantsRemoved}`; `provisionVault(projectId, deps?)` → `{space, lockdown, errors: []}` — never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/vault-provision.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureVaultSpace, lockAttachmentDeletion, provisionVault } from '../src/lib/vaultProvision.js';

function baseDeps(overrides = {}) {
  return {
    getVaultSpace: async () => null,
    insertVaultSpace: async () => {},
    projectKeyFor: async () => 'ENG',
    deriveSpaceKey: (key) => `VLT${key}`,
    createSpace: async () => ({ id: 's1', key: 'VLTENG' }),
    restrictSpacePermissions: async () => {},
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [] }),
    attachmentDeleteGrantIds: () => [],
    removeAttachmentDeleteGrants: async () => {},
    markPermissionLocked: async () => {},
    tryAppend: async () => {},
    now: () => 1000,
    actorAccountId: 'system',
    ...overrides
  };
}

test('ensureVaultSpace returns the existing space without creating a new one', async () => {
  const deps = baseDeps({ getVaultSpace: async () => ({ space_id: 's1', space_key: 'VLTENG' }) });
  let created = false;
  deps.createSpace = async () => { created = true; return { id: 's1', key: 'VLTENG' }; };
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.created, false);
  assert.equal(created, false);
});

test('ensureVaultSpace creates, restricts, and records a new space', async () => {
  const calls = [];
  const deps = baseDeps({
    createSpace: async (args) => { calls.push(['createSpace', args]); return { id: 's1', key: 'VLTENG' }; },
    restrictSpacePermissions: async (key) => calls.push(['restrict', key]),
    insertVaultSpace: async (args) => calls.push(['insert', args]),
    tryAppend: async (event) => calls.push(['audit', event.eventType])
  });
  const result = await ensureVaultSpace(7, deps);
  assert.equal(result.created, true);
  assert.equal(result.spaceId, 's1');
  assert.deepEqual(calls.map((c) => c[0]), ['createSpace', 'restrict', 'insert', 'audit']);
  assert.equal(calls[3][1], 'VAULT_SPACE_CREATED');
});

test('lockAttachmentDeletion removes attachment-delete grants and records the scheme', async () => {
  const calls = [];
  const deps = baseDeps({
    getProjectPermissionScheme: async () => ({ id: 10000, name: 'Default', permissions: [{ id: 1, permission: 'DELETE_OWN_ATTACHMENTS' }] }),
    attachmentDeleteGrantIds: (scheme) => scheme.permissions.map((p) => p.id),
    removeAttachmentDeleteGrants: async (args) => calls.push(['remove', args]),
    markPermissionLocked: async (args) => calls.push(['mark', args]),
    tryAppend: async (event) => calls.push(['audit', event.eventType])
  });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.schemeId, 10000);
  assert.equal(result.grantsRemoved, 1);
  assert.deepEqual(calls.map((c) => c[0]), ['remove', 'mark', 'audit']);
  assert.equal(calls[2][1], 'ATTACHMENT_DELETE_LOCKED');
});

test('lockAttachmentDeletion skips the removal call when there is nothing to remove', async () => {
  let removeCalled = false;
  const deps = baseDeps({ removeAttachmentDeleteGrants: async () => { removeCalled = true; } });
  const result = await lockAttachmentDeletion(7, deps);
  assert.equal(result.grantsRemoved, 0);
  assert.equal(removeCalled, false);
});

test('provisionVault runs both steps and reports no errors on success', async () => {
  const deps = baseDeps();
  const result = await provisionVault(7, deps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.space.created, true);
  assert.equal(result.lockdown.schemeId, 10000);
});

test('provisionVault never throws and still attempts the lockdown when space creation fails', async () => {
  const calls = [];
  const deps = baseDeps({
    createSpace: async () => { throw new Error('confluence down'); },
    tryAppend: async (event) => calls.push(event.eventType)
  });
  const result = await provisionVault(7, deps);
  assert.equal(result.space, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'ensureVaultSpace');
  assert.ok(result.lockdown, 'lockdown still ran despite the space failure');
  assert.ok(calls.includes('VAULT_SPACE_CREATE_FAILED'));
});

test('provisionVault records the lockdown failure independently of the space result', async () => {
  const deps = baseDeps({ getProjectPermissionScheme: async () => { throw new Error('jira down'); } });
  const result = await provisionVault(7, deps);
  assert.equal(result.space.created, true);
  assert.equal(result.lockdown, null);
  assert.equal(result.errors[0].step, 'lockAttachmentDeletion');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/vault-provision.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/vaultProvision.js`**

```js
import api, { route } from '@forge/api';
import { getVaultSpace, insertVaultSpace, markPermissionLocked } from '../db/vaultStore.js';
import { deriveSpaceKey, createSpace, restrictSpacePermissions } from './vaultConfluence.js';
import { getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants } from './vaultPermissions.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

async function defaultProjectKeyFor(projectId) {
  const res = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`);
  if (!res.ok) throw new Error(`Failed to read project ${projectId}: ${res.status}`);
  const project = await res.json();
  return project.key;
}

export async function ensureVaultSpace(projectId, deps = {}) {
  const d = {
    getVaultSpace, insertVaultSpace, deriveSpaceKey, createSpace, restrictSpacePermissions,
    projectKeyFor: defaultProjectKeyFor, tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const existing = await d.getVaultSpace(projectId);
  if (existing) return { created: false, spaceId: existing.space_id, spaceKey: existing.space_key };

  const projectKey = await d.projectKeyFor(projectId);
  const spaceKey = d.deriveSpaceKey(projectKey);
  const space = await d.createSpace({ spaceKey, name: `VAtlassian Vault — ${projectKey}` });
  const resolvedKey = space.key ?? spaceKey;
  await d.restrictSpacePermissions(resolvedKey);
  await d.insertVaultSpace({ projectId, spaceId: space.id, spaceKey: resolvedKey, createdBy: d.actorAccountId, now: d.now() });
  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.VAULT_SPACE_CREATED,
    payload: { projectId, spaceId: space.id, spaceKey: resolvedKey } });
  return { created: true, spaceId: space.id, spaceKey: resolvedKey };
}

export async function lockAttachmentDeletion(projectId, deps = {}) {
  const d = {
    getProjectPermissionScheme, attachmentDeleteGrantIds, removeAttachmentDeleteGrants, markPermissionLocked,
    tryAppend, now: Date.now, actorAccountId: 'system',
    ...deps
  };
  const scheme = await d.getProjectPermissionScheme(projectId);
  const grantIds = d.attachmentDeleteGrantIds(scheme);
  if (grantIds.length > 0) {
    await d.removeAttachmentDeleteGrants({ schemeId: scheme.id, grantIds });
  }
  await d.markPermissionLocked({ projectId, permissionSchemeId: String(scheme.id), now: d.now() });
  await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_LOCKED,
    payload: { projectId, schemeId: scheme.id, schemeName: scheme.name, grantsRemoved: grantIds.length } });
  return { schemeId: scheme.id, grantsRemoved: grantIds.length };
}

/** Never throws — vaulting is defense-in-depth and must not block the caller. */
export async function provisionVault(projectId, deps = {}) {
  const d = { tryAppend, actorAccountId: 'system', ...deps };
  const result = { space: null, lockdown: null, errors: [] };

  try {
    result.space = await ensureVaultSpace(projectId, deps);
  } catch (error) {
    console.error('provisionVault: ensureVaultSpace failed', projectId, error);
    await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.VAULT_SPACE_CREATE_FAILED,
      payload: { projectId, error: String(error?.message ?? error) } });
    result.errors.push({ step: 'ensureVaultSpace', error: String(error?.message ?? error) });
  }

  try {
    result.lockdown = await lockAttachmentDeletion(projectId, deps);
  } catch (error) {
    console.error('provisionVault: lockAttachmentDeletion failed', projectId, error);
    await d.tryAppend({ actorAccountId: d.actorAccountId, eventType: EVENT.ATTACHMENT_DELETE_LOCK_FAILED,
      payload: { projectId, error: String(error?.message ?? error) } });
    result.errors.push({ step: 'lockAttachmentDeletion', error: String(error?.message ?? error) });
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/vault-provision.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vaultProvision.js test/vault-provision.test.js
git commit -m "feat(vault): orchestrate vault-space provisioning and attachment lockdown"
```

---

## Task 6: Wire `provisionVault` into controlled-transition save

**Files:**
- Modify: `src/usecases/transitions.js:61-83` (`createControlledTransition`) and `:91-125` (`updateControlledTransition`)
- Test: `test/admin-configuration.test.js` (append) — this is the file that already exercises `createControlledTransition`/`updateControlledTransition` end-to-end via `admin.createControlledTransition`/`admin.updateControlledTransition` and the shared `fixture()`/`request()` helpers from `./admin-fixture.js`. (`test/admin-workflow-transitions.test.js` tests a different usecase, `listWorkflowTransitions` — not this one.)

**Interfaces:**
- Consumes: `provisionVault(projectId, deps?)` from `../lib/vaultProvision.js` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `test/admin-configuration.test.js`, reusing the file's existing top-level `edge` constant and its `fixture`/`request` imports:

```js
test('creating a capture-baseline transition provisions the vault for its project', async () => {
  const deps = fixture();
  const calls = [];
  deps.provisionVault = async (projectId) => { calls.push(projectId); return { errors: [] }; };
  const result = await admin.createControlledTransition(request({ ...edge, captureBaseline: true }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [1]);
});

test('creating a transition without capture-baseline never touches vault provisioning', async () => {
  const deps = fixture();
  let called = false;
  deps.provisionVault = async () => { called = true; return { errors: [] }; };
  const result = await admin.createControlledTransition(request({ ...edge, captureBaseline: false }), deps);
  assert.equal(result.success, true);
  assert.equal(called, false);
});

test('a vault provisioning problem is surfaced as a note but never fails the save', async () => {
  const deps = fixture();
  deps.provisionVault = async () => ({ errors: [{ step: 'ensureVaultSpace', error: 'confluence down' }] });
  const result = await admin.createControlledTransition(request({ ...edge, captureBaseline: true }), deps);
  assert.equal(result.success, true);
  assert.match(result.note, /retry automatically/);
});

test('updating a transition to capture-baseline provisions the vault for its project', async () => {
  const deps = fixture({
    query: sql => ({
      result: true,
      data: sql.startsWith('SELECT state') ? [{ state: 'ACTIVE' }]
        : sql.includes('FROM va_eligibility') ? [{ role: 'QA' }]
        : []
    })
  });
  const calls = [];
  deps.provisionVault = async (projectId) => { calls.push(projectId); return { errors: [] }; };
  const result = await admin.updateControlledTransition(request({ ...edge, ctId: 'a'.repeat(32), captureBaseline: true }), deps);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [1]);
});
```

`fixture()` (from `test/admin-fixture.js`) returns the exact `deps` object `runAdmin` passes to the usecase — `adminDependencies(overrides, profile)` returns `overrides` unchanged when it's truthy, so setting `deps.provisionVault` before calling the usecase is a real, complete override, not a partial mock. `edge.projectId` is `'1'`; `Number('1') === 1`, which is what the implementation below passes through.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/admin-configuration.test.js`
Expected: FAIL — `deps.provisionVault` is never called (the real dynamic import fallback would otherwise try to reach live Confluence/Jira APIs and throw, since the wiring doesn't exist yet in production code).

- [ ] **Step 3: Wire `provisionVault` into `src/usecases/transitions.js`**

In `createControlledTransition` (currently ending with `return { success: true, ctId: id.toString('hex') };`), change to:

```js
export async function createControlledTransition(req, overrides) {
  return runAdmin(req, async deps => {
    const input = transitionInput(req.payload);
    await verifyControlledTransition(input, deps);
    if (input.captureBaseline) {
      const rows = await deps.declaredFieldRows({ projectId: input.projectId, issueTypeId: input.issueTypeId });
      if (rows.some(r => r.state !== 'EXCLUDED' && (r.store_values === 0 || r.store_values === false || r.store_values === '0'))) {
        throw new Error('This project has fields with retention disabled. Enable retention for all tracked fields before creating a capture-baseline policy.');
      }
    }
    const id = deps.newId();
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'CREATE_REQUESTED', ctId: id.toString('hex'), ...input });
    await query(deps, `INSERT INTO va_controlled_transition
      (ct_id, project_id, issue_type_id, from_status_id, to_status_id, required_role, meaning,
       reject_to_status_id, transition_id, required_assurance, capture_baseline, require_decision, state, created_at, created_by)
      VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [deps.toBinaryParam(id), ...edgeParams(input), Date.now(), req.context.accountId]);
    let note;
    if (input.captureBaseline) {
      const provisionVault = deps.provisionVault ?? (await import('../lib/vaultProvision.js')).provisionVault;
      const provisioned = await provisionVault(Number(input.projectId)).catch(error => {
        console.error('createControlledTransition: vault provisioning threw unexpectedly', error);
        return { errors: [{ step: 'provisionVault', error: String(error?.message ?? error) }] };
      });
      if (provisioned.errors?.length) {
        note = 'Rule saved. Attachment vaulting could not be fully provisioned yet and will retry automatically at the next baseline.';
      }
    }
    return { success: true, ctId: id.toString('hex'), ...(note ? { note } : {}) };
  }, overrides);
}
```

In `updateControlledTransition`, change the final `return { success: true, ctId: req.payload.ctId };` to the same pattern:

```js
    let note;
    if (input.captureBaseline) {
      const provisionVault = deps.provisionVault ?? (await import('../lib/vaultProvision.js')).provisionVault;
      const provisioned = await provisionVault(Number(input.projectId)).catch(error => {
        console.error('updateControlledTransition: vault provisioning threw unexpectedly', error);
        return { errors: [{ step: 'provisionVault', error: String(error?.message ?? error) }] };
      });
      if (provisioned.errors?.length) {
        note = 'Rule saved. Attachment vaulting could not be fully provisioned yet and will retry automatically at the next baseline.';
      }
    }
    return { success: true, ctId: req.payload.ctId, ...(note ? { note } : {}) };
```

`deps.provisionVault ?? (await import(...)).provisionVault` means: the fixture's injected `provisionVault` (as in Step 1's tests) is used under test, and the real module loads in production. `adminDependencies` in `src/usecases/adminRuntime.js` returns `overrides` completely unchanged when `overrides` is truthy (confirmed by reading that file) — so `deps` under test is exactly the `fixture()` object with `provisionVault` attached, no allowlist filtering to worry about.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/admin-configuration.test.js`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/usecases/transitions.js test/admin-configuration.test.js
git commit -m "feat(vault): provision the vault when a controlled transition captures a baseline"
```

---

## Task 7: `src/lib/vaultQueue.js` — enqueue helper

**Files:**
- Create: `src/lib/vaultQueue.js`
- Test: `test/vault-queue.test.js`

**Interfaces:**
- Consumes: `Queue` from `@forge/events` (mirrors `src/lib/restore/queue.js`).
- Produces: `VAULT_QUEUE_KEY`, `enqueueVault(body, {queue?})`.

- [ ] **Step 1: Write the failing tests**

Create `test/vault-queue.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueVault } from '../src/lib/vaultQueue.js';

function fakeQueue() {
  const pushed = [];
  return { queue: { push: async (msg) => { pushed.push(msg); return { jobId: 'job-1' }; } }, pushed };
}

test('enqueueVault normalizes and pushes a well-formed body', async () => {
  const { queue, pushed } = fakeQueue();
  const result = await enqueueVault({ baselineId: 'YmFzZQ==', issueId: '42', issueKey: 'ENG-1', projectId: '7' }, { queue });
  assert.deepEqual(result, { jobId: 'job-1' });
  assert.deepEqual(pushed[0].body, { baselineId: 'YmFzZQ==', issueId: 42, issueKey: 'ENG-1', projectId: 7 });
  assert.equal(pushed[0].concurrency.key, 'vault:42');
});

test('enqueueVault rejects a missing baselineId', async () => {
  const { queue } = fakeQueue();
  assert.throws(() => enqueueVault({ issueId: 42, issueKey: 'ENG-1', projectId: 7 }, { queue }), TypeError);
});

test('enqueueVault rejects a non-numeric issueId', async () => {
  const { queue } = fakeQueue();
  assert.throws(() => enqueueVault({ baselineId: 'b', issueId: 'nope', issueKey: 'ENG-1', projectId: 7 }, { queue }), TypeError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/vault-queue.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/vaultQueue.js`**

```js
import { Queue } from '@forge/events';

export const VAULT_QUEUE_KEY = 'va-vault-queue';
const vaultQueue = new Queue({ key: VAULT_QUEUE_KEY });

function bodyFor(body) {
  if (!body || typeof body !== 'object') throw new TypeError('Vault queue body is required');
  if (typeof body.baselineId !== 'string' || !body.baselineId) throw new TypeError('baselineId is required');
  if (!Number.isSafeInteger(Number(body.issueId)) || Number(body.issueId) <= 0) throw new TypeError('issueId is required');
  if (typeof body.issueKey !== 'string' || !body.issueKey) throw new TypeError('issueKey is required');
  if (!Number.isSafeInteger(Number(body.projectId)) || Number(body.projectId) <= 0) throw new TypeError('projectId is required');
  return {
    baselineId: body.baselineId,
    issueId: Number(body.issueId),
    issueKey: body.issueKey,
    projectId: Number(body.projectId)
  };
}

export function enqueueVault(body, { queue = vaultQueue } = {}) {
  const normalized = bodyFor(body);
  return queue.push({
    body: normalized,
    concurrency: { key: `vault:${normalized.issueId}`, limit: 1 }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/vault-queue.test.js`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vaultQueue.js test/vault-queue.test.js
git commit -m "feat(vault): add the attachment-vaulting queue helper"
```

---

## Task 8: `src/jobs/vaultWorker.js` — the vaulting worker

**Files:**
- Create: `src/jobs/vaultWorker.js`
- Test: `test/vault-worker.test.js`

**Interfaces:**
- Consumes: `ensureVaultSpace` from `../lib/vaultProvision.js`; `getVaultPage`, `insertVaultPage`, `isAttachmentVaulted`, `insertVaultAttachment` from `../db/vaultStore.js`; `createVaultPage`, `uploadAttachmentToPage` from `../lib/vaultConfluence.js`; `tryAppend` from `../db/store.js`; `EVENT` from `../lib/ledger.js`; `api`, `route`, `routeFromAbsolute` from `@forge/api`; `createHash` from `node:crypto`.
- Produces: `runVaultWorker(eventOrBody, overrides?)` → `{state, vaulted, skipped, failed}` or `{state: 'FAILED', reason}`; `handler(event)` (the Forge consumer entry point).

- [ ] **Step 1: Write the failing tests**

Create `test/vault-worker.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runVaultWorker } from '../src/jobs/vaultWorker.js';

function baseBody() {
  return { baselineId: 'b1', issueId: 42, issueKey: 'ENG-1', projectId: 7 };
}

function baseOverrides(overrides = {}) {
  return {
    ensureVaultSpace: async () => ({ created: false, spaceId: 's1', spaceKey: 'VLTENG' }),
    getVaultPage: async () => ({ confluence_page_id: 'p1' }),
    insertVaultPage: async () => {},
    createVaultPage: async () => ({ id: 'p1' }),
    isAttachmentVaulted: async () => false,
    insertVaultAttachment: async () => 'va1',
    uploadAttachmentToPage: async () => ({ id: 'catt1' }),
    readIssueAttachments: async () => [{ id: 'a1', filename: 'x.png' }],
    downloadAttachment: async () => Buffer.from('bytes'),
    tryAppend: async () => {},
    now: () => 1000,
    ...overrides
  };
}

test('rejects a body missing required fields', async () => {
  const result = await runVaultWorker({ body: { issueId: 42 } }, baseOverrides());
  assert.equal(result.state, 'FAILED');
  assert.equal(result.reason, 'INVALID_BODY');
});

test('creates the issue page when none exists yet', async () => {
  const calls = [];
  const overrides = baseOverrides({
    getVaultPage: async () => null,
    createVaultPage: async (args) => { calls.push(args); return { id: 'new-p1' }; },
    insertVaultPage: async (args) => calls.push(args)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.state, 'COMPLETE');
  assert.equal(calls[0].issueKey, 'ENG-1');
  assert.equal(calls[1].confluencePageId, 'new-p1');
});

test('vaults every current attachment not already recorded for this baseline', async () => {
  const uploaded = [];
  const recorded = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: 'a1', filename: 'one.png' }, { id: 'a2', filename: 'two.png' }],
    downloadAttachment: async (a) => Buffer.from(a.id),
    uploadAttachmentToPage: async (args) => { uploaded.push(args.filename); return { id: `c-${args.filename}` }; },
    insertVaultAttachment: async (args) => { recorded.push(args); return 'row-id'; }
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.vaulted, 2);
  assert.deepEqual(uploaded, ['one.png', 'two.png']);
  assert.equal(recorded[0].contentHash, createHash('sha256').update(Buffer.from('a1')).digest('hex'));
});

test('skips an attachment already vaulted for this baseline', async () => {
  const overrides = baseOverrides({
    isAttachmentVaulted: async ({ jiraAttachmentId }) => jiraAttachmentId === 'a1'
  });
  const overridesTwoAttachments = { ...overrides, readIssueAttachments: async () => [{ id: 'a1', filename: 'one.png' }, { id: 'a2', filename: 'two.png' }] };
  const result = await runVaultWorker({ body: baseBody() }, overridesTwoAttachments);
  assert.equal(result.skipped, 1);
  assert.equal(result.vaulted, 1);
});

test('one failed attachment does not stop the rest and is recorded as failed', async () => {
  let call = 0;
  const auditedEvents = [];
  const overrides = baseOverrides({
    readIssueAttachments: async () => [{ id: 'a1', filename: 'bad.png' }, { id: 'a2', filename: 'good.png' }],
    downloadAttachment: async () => { call += 1; if (call === 1) throw new Error('network blip'); return Buffer.from('ok'); },
    tryAppend: async (event) => auditedEvents.push(event.eventType)
  });
  const result = await runVaultWorker({ body: baseBody() }, overrides);
  assert.equal(result.failed, 1);
  assert.equal(result.vaulted, 1);
  assert.ok(auditedEvents.includes('ATTACHMENT_VAULT_FAILED'));
  assert.ok(auditedEvents.includes('ATTACHMENT_VAULTED'));
});

test('falls back to lazily provisioning the vault space when it was not created eagerly', async () => {
  const calls = [];
  const overrides = baseOverrides({ ensureVaultSpace: async (projectId) => { calls.push(projectId); return { created: true, spaceId: 's1', spaceKey: 'VLTENG' }; } });
  await runVaultWorker({ body: baseBody() }, overrides);
  assert.deepEqual(calls, [7]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/vault-worker.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/jobs/vaultWorker.js`**

```js
import api, { route, routeFromAbsolute } from '@forge/api';
import { createHash } from 'node:crypto';
import { ensureVaultSpace } from '../lib/vaultProvision.js';
import { getVaultPage, insertVaultPage, isAttachmentVaulted, insertVaultAttachment } from '../db/vaultStore.js';
import { createVaultPage, uploadAttachmentToPage } from '../lib/vaultConfluence.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';

async function defaultReadIssueAttachments(issueKey) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment`);
  if (!res.ok) throw new Error(`Failed to read attachments for ${issueKey}: ${res.status}`);
  const data = await res.json();
  return data.fields?.attachment ?? [];
}

async function defaultDownloadAttachment(attachment) {
  const res = await api.asApp().requestJira(routeFromAbsolute(attachment.content));
  if (!res.ok) throw new Error(`Failed to download attachment ${attachment.id}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function runVaultWorker(eventOrBody, overrides = {}) {
  const body = eventOrBody?.body ?? eventOrBody;
  const deps = {
    ensureVaultSpace, getVaultPage, insertVaultPage, createVaultPage,
    isAttachmentVaulted, insertVaultAttachment, uploadAttachmentToPage,
    readIssueAttachments: defaultReadIssueAttachments,
    downloadAttachment: defaultDownloadAttachment,
    tryAppend, now: Date.now,
    ...overrides
  };
  if (!body?.baselineId || !body?.issueId || !body?.issueKey || !body?.projectId) {
    return { state: 'FAILED', reason: 'INVALID_BODY' };
  }

  const space = await deps.ensureVaultSpace(body.projectId);

  let page = await deps.getVaultPage(body.issueId);
  if (!page) {
    const created = await deps.createVaultPage({ spaceId: space.spaceId, issueKey: body.issueKey });
    await deps.insertVaultPage({ issueId: body.issueId, projectId: body.projectId, confluencePageId: created.id, now: deps.now() });
    page = { confluence_page_id: created.id };
  }

  const attachments = await deps.readIssueAttachments(body.issueKey);
  const results = { vaulted: 0, skipped: 0, failed: 0 };

  for (const attachment of attachments) {
    if (await deps.isAttachmentVaulted({ baselineId: body.baselineId, jiraAttachmentId: attachment.id })) {
      results.skipped += 1;
      continue;
    }
    try {
      const buffer = await deps.downloadAttachment(attachment);
      const contentHash = createHash('sha256').update(buffer).digest('hex');
      const uploaded = await deps.uploadAttachmentToPage({ pageId: page.confluence_page_id, filename: attachment.filename, buffer });
      await deps.insertVaultAttachment({
        baselineId: body.baselineId, issueId: body.issueId, jiraAttachmentId: attachment.id,
        filename: attachment.filename, contentHash, confluenceAttachmentId: uploaded.id, now: deps.now()
      });
      await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULTED,
        payload: { baselineId: body.baselineId, jiraAttachmentId: attachment.id, filename: attachment.filename, contentHash } });
      results.vaulted += 1;
    } catch (error) {
      console.error('vaultWorker: failed to vault attachment', attachment.id, error);
      await deps.tryAppend({ actorAccountId: 'system', issueId: body.issueId, eventType: EVENT.ATTACHMENT_VAULT_FAILED,
        payload: { baselineId: body.baselineId, jiraAttachmentId: attachment.id, error: String(error?.message ?? error) } });
      results.failed += 1;
    }
  }

  return { state: 'COMPLETE', ...results };
}

export async function handler(event) {
  return runVaultWorker(event);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/vault-worker.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/vaultWorker.js test/vault-worker.test.js
git commit -m "feat(vault): add the baseline attachment-vaulting worker"
```

---

## Task 9: Wire attachment vaulting into `applyApproval`

`applyApproval` (the function that actually captures a baseline on approval)
lives in `src/usecases/drift.js`, **not** `src/usecases/approval.js` —
`approval.js` only holds the challenge/submit layer that eventually calls into
`drift.js`. Double-check this against the current file before starting: `grep -n
"^export async function applyApproval" src/usecases/drift.js`.

**Files:**
- Modify: `src/usecases/drift.js` (imports, and the block right after `if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');`)
- Modify: `test/drift-functional.test.js` — this file already runs `applyApproval` end-to-end through a module-resolution-hook fixture (`registerHooks`) that intercepts a fixed list of modules (the `modules` map near the top) and routes their exports to a `globalThis.vaFlow` fixture object. Add `lib/vaultQueue.js` to that list, exactly like `db/store.js` is already there for `tryAppend`.

**Interfaces:**
- Consumes: `enqueueVault` from `../lib/vaultQueue.js` (Task 7, plain static import — this file does not use parameter-injected deps, it uses top-level imports, matching how `markDecided`/`clearDrift`/`writeCapturedBaseline` are already imported here); `EVENT` from `../lib/ledger.js`; `tryAppend` from `../db/store.js` (neither is currently imported in this file — confirm with `grep -n "^import" src/usecases/drift.js` before adding).

- [ ] **Step 1: Add `vaultQueue.js` to the test fixture's module-interception list**

In `test/drift-functional.test.js`, the `modules` map (used by `registerHooks` to redirect specific module specifiers to synthetic fixture-backed exports) currently ends with:

```js
  'db/treeDriftStore.js': ['replaceTreeDrift']
};
```

Change it to:

```js
  'db/treeDriftStore.js': ['replaceTreeDrift'],
  'lib/vaultQueue.js': ['enqueueVault']
};
```

This is necessary, not optional: without it, `drift.js`'s new static import of the real `enqueueVault` would call the real `@forge/events` `Queue.push()` during this test (there is no Forge queue backend in a plain `node:test` run), which this fixture avoids everywhere else it can — note how `projectConfig:async()=>({enabled:true,restore:{queue:false}})` already forces the *existing* restore path off the real queue for the same reason. `enqueueVault` has no equivalent "off switch" in production (vaulting is unconditional whenever a baseline is captured), so the module hook is how this test avoids the same problem.

- [ ] **Step 2: Add the fixture's `enqueueVault` and a call log**

In the same file's `fixture()` function, add to the `f` object literal (anywhere alongside `restores:[], transitionRequests:[]` etc.):

```js
    vaultCalls: [],
```

and add an `enqueueVault` method to `f` (alongside `tryAppend:async(a)=>f.audits.push(a),`):

```js
    enqueueVault: async (body) => { f.vaultCalls.push(body); return { jobId: 'fixture-vault-job' }; },
```

- [ ] **Step 3: Write the failing tests**

Append to `test/drift-functional.test.js`, after the existing tests (this file's `fixture()` always sets `capture_baseline: true` on `f.policy`, and `f.sign()` drives a full APPROVE through challenge → submit → `applyApproval`, so no new fixture machinery is needed):

```js
test('an approved baseline capture enqueues attachment vaulting for the issue', async () => {
  const f = fixture();
  const result = await f.sign();
  assert.equal(result.success, true);
  assert.equal(f.vaultCalls.length, 1);
  assert.equal(f.vaultCalls[0].issueKey, 'T-10');
  assert.equal(f.vaultCalls[0].projectId, 1);
  assert.equal(typeof f.vaultCalls[0].baselineId, 'string');
  assert.ok(f.vaultCalls[0].baselineId.length > 0);
});

test('a vault-queue failure is audited and never fails the approval', async () => {
  const f = fixture();
  f.enqueueVault = async () => { throw new Error('queue down'); };
  const result = await f.sign();
  assert.equal(result.success, true);
  assert.ok(f.audits.some(a => a.eventType === 'VAULT_QUEUE_FAILED'));
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test test/drift-functional.test.js`
Expected: FAIL — `f.vaultCalls` stays empty (the production wiring doesn't exist yet).

- [ ] **Step 5: Wire the enqueue call into `applyApproval`**

In `src/usecases/drift.js`, add to the top imports (alongside the existing `import { clearDrift } from '../lib/driftProperty.js';`):

```js
import { EVENT } from '../lib/ledger.js';
import { tryAppend } from '../db/store.js';
import { enqueueVault } from '../lib/vaultQueue.js';
```

Find this existing block, immediately after the tree/field capture branch inside `applyApproval`:

```js
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
    }
```

Change it to:

```js
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
      if (capture.captured) {
        const baselineIdStr = Buffer.isBuffer(capture.baselineId) ? capture.baselineId.toString('base64') : String(capture.baselineId);
        await enqueueVault({ baselineId: baselineIdStr, issueId: checked.issueId, issueKey: checked.issue.key, projectId: checked.projectId })
          .catch(async (error) => {
            console.error('applyApproval: failed to enqueue attachment vaulting', error);
            await tryAppend({ actorAccountId: actor.accountId, issueId: checked.issueId,
              eventType: EVENT.VAULT_QUEUE_FAILED, payload: { baselineId: baselineIdStr, error: String(error?.message ?? error) } });
          });
      }
    }
```

The gate here is simply `capture.captured` — the spec's trigger is "whenever a baseline is captured," and `capture.captured` is already exactly that signal (true for both the tree-capture and field-only capture branches, and only when the write actually succeeded), so no extra `capturesBaseline`/`gate.capture_baseline` check is needed or more correct than this.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/drift-functional.test.js`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/usecases/drift.js test/drift-functional.test.js
git commit -m "feat(vault): enqueue attachment vaulting after a baseline is captured"
```

---

## Task 10: Manifest wiring and final verification

**Files:**
- Modify: `manifest.yml` (add a `consumer` entry and a `function` entry)

**Interfaces:** none (deployment configuration only).

- [ ] **Step 1: Add the consumer**

In `manifest.yml`, under the existing `consumer:` list (next to `confl-reconcile-cnsmr`), add:

```yaml
    - key: va-vault-consumer
      queue: va-vault-queue
      function: vault-worker
```

- [ ] **Step 2: Add the function**

Under the existing `function:` list (next to `confl-reconcile-wrk`), add:

```yaml
    - key: vault-worker
      handler: jobs/vaultWorker.handler
      timeoutSeconds: 300
```

- [ ] **Step 3: Verify the manifest is well-formed and consistent**

Run:

```bash
node -e "console.log(require('js-yaml') ? 'has js-yaml' : '')" 2>/dev/null; grep -n "va-vault-consumer\|vault-worker" manifest.yml
```

Expected: both the consumer and function entries print back, at the correct indentation matching the surrounding `consumer:`/`function:` blocks (2-space nesting consistent with `confl-reconcile-cnsmr`/`confl-reconcile-wrk` immediately above them). If a YAML linter is available in this project's toolchain (check `package.json` devDependencies), run it; otherwise a visual diff against the surrounding entries' indentation is sufficient — Forge's own `forge lint`/`forge deploy` will catch a real syntax error.

- [ ] **Step 4: Run the full test suite one final time**

Run: `node --test test/*.test.js`
Expected: PASS, no regressions across the whole suite (this repo has no test that exercises `manifest.yml` directly, so this step is really re-confirming Tasks 1–9 are all still green together).

- [ ] **Step 5: Commit**

```bash
git add manifest.yml
git commit -m "feat(vault): register the attachment-vaulting queue consumer"
```

- [ ] **Step 6: Flag remaining manual verification (not automatable in this session)**

This plan's spec calls for one live end-to-end pass against the VJIRA/Confluence test site before Phases 1–2 are considered done: create a controlled transition with baseline capture on a real test project, confirm the vault space and permission-scheme change land, approve an issue with an attachment, confirm it appears on the vault page, and confirm a normal attachment-delete attempt is now refused. This step touches live, shared Jira/Confluence configuration (a permission scheme edit) and should be run deliberately by a human, not automatically — do not run `forge deploy` or perform this verification without the user's explicit go-ahead at that time.
