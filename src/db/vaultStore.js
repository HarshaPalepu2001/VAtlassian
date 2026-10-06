import { executeQuery, limitClause } from '../lib/db.js';
import { newId } from './store.js';
import { STORAGE, isReadableCopy } from '../lib/vaultLocation.js';

export async function getVaultSpace(projectId, query = executeQuery) {
  const rows = await query(
    `SELECT project_id, space_id, space_key, project_page_id, permission_scheme_id, permission_locked_at, app_delete_granted_at,
            app_delete_checked_at, created_at, created_by FROM va_vault_space WHERE project_id = ?`,
    [projectId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault space storage is unavailable');
  return rows.data?.[0] ?? null;
}

/** The site vault, when `spaceId` is it; null for any other space. */
export async function getVaultSiteBySpaceId(spaceId, query = executeQuery) {
  const rows = await query(
    'SELECT space_id, space_key, homepage_id, created_at, created_by FROM va_vault_site WHERE space_id = ?',
    [String(spaceId)]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault site storage is unavailable');
  return rows.data?.[0] ?? null;
}

/** THE one vault space for this site (see lib/vaultConfluence.js). */
const SITE_ROW = 'SITE';

export async function getVaultSite(query = executeQuery) {
  const rows = await query(
    'SELECT space_id, space_key, homepage_id, created_at, created_by FROM va_vault_site WHERE id = ?',
    [SITE_ROW]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault site storage is unavailable');
  return rows.data?.[0] ?? null;
}

export async function insertVaultSite({ spaceId, spaceKey, homepageId, createdBy, now = Date.now() }, query = executeQuery) {
  const rows = await query(
    'INSERT INTO va_vault_site (id, space_id, space_key, homepage_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [SITE_ROW, spaceId, spaceKey, homepageId ?? null, now, createdBy]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record the vault space');
}

/** How long a refused app grant is left before the backfill asks Jira again. */
export const APP_GRANT_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Projects with an ACTIVE baseline-capturing rule whose vault is not complete
 * — no project page yet, or the app's own grant to delete attachments (which a
 * rejection needs to remove a file added after approval) not yet in place.
 * The hourly backfill provisions these, so rules saved before vaulting
 * existed, and any attempt that failed, are picked up without anyone
 * re-saving a rule.
 *
 * The attachment-delete LOCKDOWN is not part of "complete": it is a per-project
 * choice, off by default (projectsNeedingLockdown). A grant Jira refused counts
 * as done for a day, so a site that will never allow it is not asked hourly.
 */
export async function projectsNeedingVault({ limit = 10, now = Date.now(), objectStoreOnly = false } = {}, query = executeQuery) {
  // A site whose vault is the Object Store has no Confluence page to make.
  const page = objectStoreOnly ? '' : 'vs.project_page_id IS NOT NULL AND ';
  const rows = await query(
    `SELECT DISTINCT ct.project_id FROM va_controlled_transition ct
      WHERE ct.state = 'ACTIVE' AND ct.capture_baseline = 1
        AND ct.project_id NOT IN (
          SELECT vs.project_id FROM va_vault_space vs
           WHERE ${page}(vs.app_delete_granted_at IS NOT NULL OR vs.app_delete_checked_at > ?))
      ORDER BY ct.project_id LIMIT ${limitClause(limit)}`,
    [now - APP_GRANT_RETRY_MS]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault backfill storage is unavailable');
  return (rows.data ?? []).map(row => Number(row.project_id));
}

/**
 * Of `projectIds` — the projects whose administrator turned the lockdown on
 * (configStore.projectsWantingLockdown) — those with an ACTIVE capturing rule
 * and no lockdown recorded yet. A project with no capturing rule has nothing
 * baselined to protect, and is locked when its first rule is saved.
 */
export async function projectsNeedingLockdown(projectIds, query = executeQuery) {
  const ids = [...new Set((projectIds ?? []).map(Number).filter(Number.isSafeInteger))];
  if (ids.length === 0) return [];
  const rows = await query(
    `SELECT DISTINCT ct.project_id FROM va_controlled_transition ct
      WHERE ct.state = 'ACTIVE' AND ct.capture_baseline = 1
        AND ct.project_id IN (${ids.map(() => '?').join(', ')})
        AND ct.project_id NOT IN (SELECT vs.project_id FROM va_vault_space vs WHERE vs.permission_locked_at IS NOT NULL)
      ORDER BY ct.project_id`,
    ids
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault backfill storage is unavailable');
  return (rows.data ?? []).map(row => Number(row.project_id));
}

export async function setVaultProjectPage({ projectId, spaceId, spaceKey, projectPageId }, query = executeQuery) {
  const rows = await query(
    'UPDATE va_vault_space SET space_id = ?, space_key = ?, project_page_id = ? WHERE project_id = ?',
    [spaceId, spaceKey, projectPageId, projectId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to link the project vault page');
}

export async function insertVaultSpace({ projectId, spaceId, spaceKey, projectPageId = null, createdBy, now = Date.now() }, query = executeQuery) {
  const rows = await query(
    'INSERT INTO va_vault_space (project_id, space_id, space_key, project_page_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [projectId, spaceId ?? null, spaceKey ?? null, projectPageId, now, createdBy]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record vault space');
}

/**
 * The project's row, with no vault space: a project on a Jira-only site, or
 * one whose Confluence vault could not be made yet. The app's delete grant and
 * the lockdown are recorded on it all the same. A row already there is kept.
 */
export async function ensureVaultProjectRow({ projectId, createdBy = 'system', now = Date.now() }, query = executeQuery) {
  if (await getVaultSpace(projectId, query)) return false;
  try {
    await insertVaultSpace({ projectId, spaceId: null, spaceKey: null, createdBy, now }, query);
    return true;
  } catch (error) {
    // Two provisions racing: the loser finds the winner's row.
    if (await getVaultSpace(projectId, query)) return false;
    throw error;
  }
}

export async function markPermissionLocked({ projectId, permissionSchemeId, now = Date.now() }, query = executeQuery) {
  const check = await query('SELECT 1 FROM va_vault_space WHERE project_id = ?', [projectId]);
  if (!check?.result) throw check?.error ?? new Error('Failed to check vault space');
  if ((check.data?.length ?? 0) === 0) {
    throw new Error(`Cannot lock permissions: vault space not provisioned for project ${projectId}`);
  }
  const rows = await query(
    'UPDATE va_vault_space SET permission_scheme_id = ?, permission_locked_at = ? WHERE project_id = ?',
    [permissionSchemeId, now, projectId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record permission lockdown');
}

/**
 * The lockdown was turned off. The time it was applied is cleared so turning
 * it on again locks again rather than finding it "already done"; the scheme
 * id is kept, as the record of which scheme the grants were taken from.
 */
export async function markPermissionUnlocked({ projectId }, query = executeQuery) {
  const rows = await query('UPDATE va_vault_space SET permission_locked_at = NULL WHERE project_id = ?', [projectId]);
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record the lockdown as off');
}

export async function markAppDeleteGranted({ projectId, now = Date.now() }, query = executeQuery) {
  const rows = await query('UPDATE va_vault_space SET app_delete_granted_at = ? WHERE project_id = ?', [now, projectId]);
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record the app attachment-delete grant');
}

export async function markAppDeleteChecked({ projectId, now = Date.now() }, query = executeQuery) {
  const rows = await query('UPDATE va_vault_space SET app_delete_checked_at = ? WHERE project_id = ?', [now, projectId]);
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record the refused app attachment-delete grant');
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
  { baselineId, issueId, jiraAttachmentId, filename, contentHash, confluenceAttachmentId = null, mediaId = null,
    storage = STORAGE.CONFLUENCE, objectKey = null, now = Date.now() },
  query = executeQuery
) {
  const id = newId().toString('hex');
  const rows = await query(
    `INSERT INTO va_vault_attachment
       (id, baseline_id, issue_id, jira_attachment_id, filename, content_hash, confluence_attachment_id, media_id, vaulted_at,
        storage, object_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, baselineId, issueId, jiraAttachmentId, filename, contentHash, confluenceAttachmentId ?? null, mediaId, now,
      storage, objectKey ?? null]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record vaulted attachment');
  return id;
}

/**
 * The newest vaulted copy of each of `attachmentIds` on `issueId`, from any
 * baseline, with the vault page it sits on. A Jira attachment never changes,
 * so every copy of one id is a copy of the same bytes; the newest is simply
 * the one most likely to still be there. A copy that names nowhere to read it
 * from (lib/vaultLocation.js isReadableCopy) gives way to an older one that
 * does. Map: Jira id -> row, with `storage` and `object_key`.
 */
export async function vaultedCopies({ issueId, attachmentIds }, query = executeQuery) {
  const ids = [...new Set((attachmentIds ?? []).map(String).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await query(
    `SELECT va.jira_attachment_id, va.filename, va.content_hash, va.confluence_attachment_id,
            va.baseline_id, va.vaulted_at, va.media_id, va.storage, va.object_key, vp.confluence_page_id
       FROM va_vault_attachment va
       LEFT JOIN va_vault_page vp ON vp.issue_id = va.issue_id
      WHERE va.issue_id = ? AND va.jira_attachment_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY va.vaulted_at DESC`,
    [issueId, ...ids]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Vault attachment storage is unavailable');
  const newest = new Map();
  for (const row of rows.data ?? []) {
    const id = String(row.jira_attachment_id);
    const media = newest.get(id)?.media_id ?? null;
    if (!newest.has(id) || (!isReadableCopy(newest.get(id)) && isReadableCopy(row))) {
      newest.set(id, { ...row, storage: row.storage ?? STORAGE.CONFLUENCE, media_id: row.media_id ?? media });
    }
    // A copy vaulted before media ids were recorded borrows one from another
    // copy of the same file: one Jira id is one media file.
    else if (!newest.get(id).media_id && row.media_id) newest.get(id).media_id = row.media_id;
  }
  return newest;
}

/**
 * Restored attachments on these work items: Map issueId -> {
 *   files: Map(Jira id -> the original Jira id it stands for),
 *   media: Map(media id -> the original media id it stands for),
 *   mediaOwner: Map(media id -> the Jira id of the restored copy it belongs to) }.
 * See lib/attachmentIdentity.js.
 *
 * OLDEST FIRST. A file removed and restored twice has two copies standing for
 * one original, the first of them deleted; Maps keep insertion order, so a
 * reader walking them meets the newest copy last (restore/attachments.js
 * pointAtLiveFiles relies on it). Rows are never deleted: a deleted copy's row
 * is still how an old changelog entry's id is recognised.
 */
export async function identityRecords(issueIds, query = executeQuery) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isSafeInteger))];
  const out = new Map();
  if (ids.length === 0) return out;
  const rows = await query(
    `SELECT issue_id, attachment_id, stands_for_id, media_id, stands_for_media_id FROM va_attachment_alias
      WHERE issue_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY created_at, attachment_id`,
    ids
  );
  if (!rows?.result) throw rows?.error ?? new Error('Attachment identity storage is unavailable');
  for (const row of rows.data ?? []) {
    const issueId = Number(row.issue_id);
    if (!out.has(issueId)) out.set(issueId, { files: new Map(), media: new Map(), mediaOwner: new Map() });
    const entry = out.get(issueId);
    entry.files.set(String(row.attachment_id), String(row.stands_for_id));
    if (row.media_id && row.stands_for_media_id) {
      entry.media.set(String(row.media_id), String(row.stands_for_media_id));
      entry.mediaOwner.set(String(row.media_id), String(row.attachment_id));
    }
  }
  return out;
}

/** Map issueId -> Map(Jira id -> the original Jira id it stands for). */
export async function attachmentAliases(issueIds, query = executeQuery) {
  const records = await identityRecords(issueIds, query);
  return new Map([...records].map(([issueId, entry]) => [issueId, entry.files]));
}

/** Idempotent: a retried restore records the same alias again harmlessly. */
export async function recordAttachmentAlias({ attachmentId, issueId, standsForId, contentHash, restoreRef = null,
  mediaId = null, standsForMediaId = null, now = Date.now() }, query = executeQuery) {
  const rows = await query(
    `INSERT INTO va_attachment_alias (attachment_id, issue_id, stands_for_id, content_hash, restore_ref, created_at,
       media_id, stands_for_media_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE attachment_id = attachment_id`,
    [String(attachmentId), Number(issueId), String(standsForId), contentHash, restoreRef, now, mediaId, standsForMediaId]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record the restored attachment identity');
}
