import { executeQuery, limitClause } from '../lib/db.js';
import { newId } from './store.js';

export async function getVaultSpace(projectId, query = executeQuery) {
  const rows = await query(
    'SELECT project_id, space_id, space_key, project_page_id, permission_scheme_id, permission_locked_at, created_at, created_by FROM va_vault_space WHERE project_id = ?',
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

/**
 * Projects with an ACTIVE baseline-capturing rule whose vault is not complete
 * — no project page yet, or the attachment-delete lockdown not yet applied.
 * The hourly backfill provisions these, so rules saved before vaulting
 * existed, and any attempt that failed, are picked up without anyone
 * re-saving a rule.
 */
export async function projectsNeedingVault({ limit = 10 } = {}, query = executeQuery) {
  const rows = await query(
    `SELECT DISTINCT ct.project_id FROM va_controlled_transition ct
      WHERE ct.state = 'ACTIVE' AND ct.capture_baseline = 1
        AND ct.project_id NOT IN (
          SELECT vs.project_id FROM va_vault_space vs
           WHERE vs.project_page_id IS NOT NULL AND vs.permission_locked_at IS NOT NULL)
      ORDER BY ct.project_id LIMIT ${limitClause(limit)}`,
    []
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
    [projectId, spaceId, spaceKey, projectPageId, now, createdBy]
  );
  if (!rows?.result) throw rows?.error ?? new Error('Failed to record vault space');
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
