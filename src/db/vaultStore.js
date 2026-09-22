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
