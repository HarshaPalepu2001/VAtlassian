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
