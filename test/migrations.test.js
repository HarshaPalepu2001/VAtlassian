import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS } from '../src/db/migrations.js';

function sqlFor(id) {
  const m = MIGRATIONS.find(x => x.id === id);
  if (!m) throw new Error(`Migration ${id} not found`);
  return m.sql;
}

test('tree values are keyed by baseline and logical node and use MEDIUMTEXT', () => {
  const sql = sqlFor('v034_baseline_node_value');
  assert.match(
    sql,
    /PRIMARY KEY \(baseline_id, logical_node_id, field_id, seq\)/
  );
  assert.match(sql, /chunk MEDIUMTEXT NOT NULL/);
});

test('migration v041 modifies baseline_node_value chunk to MEDIUMTEXT', () => {
  const sql = sqlFor('v041_baseline_node_value_mediumtext');
  assert.match(sql, /ALTER TABLE va_baseline_node_value MODIFY COLUMN chunk MEDIUMTEXT NOT NULL/);
});

test('tree restoration actions are journaled by restore and durable step key', () => {
  const sql = sqlFor('v038_restore_action');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS va_restore_action/);
  assert.match(sql, /PRIMARY KEY \(restore_id, step_key\)/);
  assert.match(sql, /KEY idx_restore_action_state \(restore_id, state, started_at\)/);
});

test('baseline control provenance has its own append-only migration', () => {
  const sql = sqlFor('v039_baseline_control_provenance');
  assert.match(sql, /ALTER TABLE va_baseline/);
  assert.match(sql, /ADD COLUMN required_role VARCHAR\(32\) NULL/);
  assert.match(sql, /ADD COLUMN required_assurance VARCHAR\(24\) NULL/);
  assert.match(sql, /ADD COLUMN controlled_fields_hash CHAR\(64\) NULL/);
});

test('restore progress has durable queue and checkpoint columns', () => {
  const sql = sqlFor('v040_restore_progress');
  assert.match(sql, /ALTER TABLE va_restore/);
  for (const column of ['job_id', 'queued_at', 'heartbeat_at', 'total_steps', 'completed_steps', 'last_checkpoint', 'last_error']) {
    assert.match(sql, new RegExp(`ADD COLUMN ${column}\\b`), `missing ${column}`);
  }
});

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

test('v061 adds the parent-capture link to va_baseline', () => {
  const sql = sqlFor('v061_baseline_captured_by');
  assert.match(sql, /ALTER TABLE va_baseline\s+ADD COLUMN captured_by_baseline_id BINARY\(16\) NULL/);
  assert.match(sqlFor('v062_baseline_captured_by_index'),
    /ALTER TABLE va_baseline ADD INDEX idx_baseline_captured_by \(captured_by_baseline_id\)/);
});

test('v063 records which original a restored attachment stands for, keyed by its own Jira id', () => {
  const sql = sqlFor('v063_attachment_alias');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS va_attachment_alias/);
  assert.match(sql, /PRIMARY KEY \(attachment_id\)/);
  assert.match(sql, /stands_for_id VARCHAR\(64\) NOT NULL/);
  assert.match(sql, /content_hash CHAR\(64\) NOT NULL/);
  assert.match(sql, /KEY idx_attachment_alias_issue \(issue_id\)/);
});

test('v064 and v065 index vaulted copies by issue and record the app delete grant', () => {
  assert.match(sqlFor('v064_vault_attachment_issue_index'),
    /ALTER TABLE va_vault_attachment ADD INDEX idx_vault_attachment_issue \(issue_id, jira_attachment_id\)/);
  assert.match(sqlFor('v065_vault_app_delete_grant'),
    /ALTER TABLE va_vault_space ADD COLUMN app_delete_granted_at BIGINT NULL/);
});

test('v066 and v067 record the media ids rich text points at, for the vault and for restored copies', () => {
  assert.match(sqlFor('v066_vault_attachment_media'), /ALTER TABLE va_vault_attachment ADD COLUMN media_id VARCHAR\(64\) NULL/);
  const sql = sqlFor('v067_attachment_alias_media');
  assert.match(sql, /ADD COLUMN media_id VARCHAR\(64\) NULL/);
  assert.match(sql, /ADD COLUMN stands_for_media_id VARCHAR\(64\) NULL/);
});

test('v068 records when a tree version\'s child nodes were read, for a version that re-recorded only a link', () => {
  assert.match(sqlFor('v068_baseline_nodes_captured_at'), /ALTER TABLE va_baseline ADD COLUMN nodes_captured_at BIGINT NULL/);
});

test('v069 keeps the link decisions queued for an issue until its record takes them', () => {
  const sql = sqlFor('v069_link_pending');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS va_link_pending/);
  assert.match(sql, /PRIMARY KEY \(issue_id, decided_on_issue_id\)/);
  assert.equal(MIGRATIONS.at(-1).id, 'v069_link_pending');
});
