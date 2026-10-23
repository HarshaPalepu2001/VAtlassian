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
});

test('v070 records when Jira last refused the app its attachment-delete grant', () => {
  assert.match(sqlFor('v070_vault_space_app_delete_check'),
    /ALTER TABLE va_vault_space ADD COLUMN app_delete_checked_at BIGINT NULL/);
});

test('v071-v074 let a vaulted copy live in the Object Store, and a project have no vault space', () => {
  assert.match(sqlFor('v071_vault_attachment_confluence_optional'),
    /ALTER TABLE va_vault_attachment MODIFY COLUMN confluence_attachment_id VARCHAR\(64\) NULL/);
  const storage = sqlFor('v072_vault_attachment_storage');
  assert.match(storage, /ADD COLUMN storage VARCHAR\(16\) NOT NULL DEFAULT 'CONFLUENCE'/, 'existing rows are Confluence copies');
  assert.match(storage, /ADD COLUMN object_key VARCHAR\(191\) NULL/);
  assert.match(sqlFor('v073_vault_space_id_optional'), /MODIFY COLUMN space_id VARCHAR\(64\) NULL/);
  assert.match(sqlFor('v074_vault_space_key_optional'), /MODIFY COLUMN space_key VARCHAR\(64\) NULL/);
});

test('v075-v087 stay in the list: they may already have run on a site', () => {
  for (const id of ['v075_baseline_field', 'v076_baseline_rule', 'v077_baseline_signature',
    'v078_baseline_node_child', 'v079_baseline_link', 'v080_baseline_policy_recorded', 'v081_capture_lease',
    'v082_drift_observations', 'v083_decisions', 'v084_decision_group', 'v085_decision_signature',
    'v086_security_level', 'v087_baseline_cause']) {
    assert.ok(sqlFor(id), id);
  }
});

test('migration ids are unique and include the manual-test schema through rerun provenance', () => {
  const ids = MIGRATIONS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(MIGRATIONS.at(-1).id, 'v143_tm_project_author_separation');
});

test('v137-v142 record authors and pending step changes, one statement each', () => {
  for (const [id, table, column] of [['v137_tm_draft_editors', 'tm_test_draft', 'editors'], ['v138_tm_version_authors', 'tm_test_version', 'authors'],
    ['v139_tm_collection_draft_editors', 'tm_collection_draft', 'editors'], ['v140_tm_collection_revision_authors', 'tm_collection_revision', 'authors'],
    ['v141_tm_run_step_event', 'tm_run', 'step_event_id'], ['v142_tm_run_step_prior', 'tm_run', 'step_prior'],
    ['v143_tm_project_author_separation', 'tm_project', 'author_separation']]) {
    const sql = sqlFor(id);
    assert.match(sql, new RegExp(`^ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} `), id);
    assert.ok(!sql.includes(';'), id);
  }
});

test('v108 drops Confluence governance and vault tables, columns, and tier config', () => {
  const sql = sqlFor('v108_remove_confluence');
  assert.match(sql, /DROP TABLE IF EXISTS/);
  for (const table of ['va_governed_subject', 'va_governance_policy', 'va_governance_state', 'va_events', 'va_vault_site', 'va_vault_page']) {
    assert.match(sql, new RegExp(`\\b${table}\\b`), `missing table ${table}`);
  }
  for (const col of ['space_id', 'space_key', 'project_page_id']) {
    assert.match(sql, new RegExp(`DROP COLUMN IF EXISTS ${col}\\b`), `missing drop column ${col}`);
  }
  assert.match(sql, /DELETE FROM va_config WHERE cfg_key = 'vault:tier'/);
});

test('v088-v093 replace the draft field, rule and signature tables with the spec shape', () => {
  assert.match(sqlFor('v088_drop_draft_baseline_field'), /^DROP TABLE IF EXISTS va_baseline_field$/);
  const field = sqlFor('v089_baseline_field');
  for (const column of ['label_source VARCHAR\\(16\\) NOT NULL', 'materiality VARCHAR\\(16\\) NOT NULL',
    'restorable BOOLEAN NULL', 'digest CHAR\\(64\\) NOT NULL', 'required_by TEXT NOT NULL']) {
    assert.match(field, new RegExp(column), column);
  }
  assert.doesNotMatch(field, /severity/);
  assert.match(field, /PRIMARY KEY \(baseline_id, field_id\)/);

  assert.match(sqlFor('v090_drop_draft_baseline_rule'), /^DROP TABLE IF EXISTS va_baseline_rule$/);
  const rule = sqlFor('v091_baseline_rule');
  for (const column of ['rule_key CHAR\\(32\\) NOT NULL', 'source VARCHAR\\(16\\) NOT NULL', 'approvers TEXT NOT NULL',
    'imposed_by_baseline_id BINARY\\(16\\) NULL', 'imposed_by_version INT NULL']) {
    assert.match(rule, new RegExp(column), column);
  }
  assert.doesNotMatch(rule, /\brole VARCHAR/, 'a rule holds a set of approvers, not one role');

  assert.match(sqlFor('v092_drop_draft_baseline_signature'), /^DROP TABLE IF EXISTS va_baseline_signature$/);
  const signature = sqlFor('v093_baseline_signature');
  for (const column of ['cause_baseline_id BINARY\\(16\\) NULL', 'decision_id BINARY\\(16\\) NULL',
    'transition_id VARCHAR\\(32\\) NULL', 'transition_at BIGINT NULL', 'status_at_capture VARCHAR\\(32\\) NULL',
    'signed_at BIGINT NOT NULL']) {
    assert.match(signature, new RegExp(column), column);
  }
  assert.match(signature, /PRIMARY KEY \(baseline_id, approval_id\)/);
});

test('v094-v097 put the drift observation columns in the spec shape', () => {
  // Each re-runnable: a DDL that applied but was never ledgered must not stall every later migration.
  assert.match(sqlFor('v094_drift_drop_draft_editor'), /^ALTER TABLE va_drift DROP COLUMN IF EXISTS editor_account_id$/);
  assert.match(sqlFor('v095_drift_drop_draft_decision'), /^ALTER TABLE va_drift DROP COLUMN IF EXISTS decision_id$/);
  assert.match(sqlFor('v096_drift_decision'), /^ALTER TABLE va_drift ADD COLUMN IF NOT EXISTS decision_id BINARY\(16\) NULL$/);
  assert.match(sqlFor('v097_drift_by_baseline'),
    /^ALTER TABLE va_drift ADD INDEX IF NOT EXISTS idx_drift_baseline \(baseline_id, field_id\)$/);
});

test('v098-v103 replace the draft decision tables; a signature is appended, never overwritten', () => {
  assert.match(sqlFor('v098_drop_draft_decision'), /^DROP TABLE IF EXISTS va_decision$/);
  assert.match(sqlFor('v099_drop_draft_decision_group'), /^DROP TABLE IF EXISTS va_decision_group$/);
  assert.match(sqlFor('v100_drop_draft_decision_signature'), /^DROP TABLE IF EXISTS va_decision_signature$/);
  assert.match(sqlFor('v101_decision'), /decision_id BINARY\(16\) NOT NULL/);
  assert.doesNotMatch(sqlFor('v102_decision_group'), /evidence_hash/, 'a group\'s evidence is computed, not stored');
  const signature = sqlFor('v103_decision_signature');
  assert.match(signature, /PRIMARY KEY \(decision_id, group_key, approval_id\)/);
  assert.match(signature, /evidence_hash CHAR\(64\) NOT NULL/);
});

test('v104-v105 add the lease acquisition time and a migrated version\'s content time', () => {
  assert.match(sqlFor('v104_capture_lease_acquired'),
    /^ALTER TABLE va_capture_lease ADD COLUMN IF NOT EXISTS acquired_at BIGINT NULL$/);
  assert.match(sqlFor('v105_baseline_content_as_of'), /^ALTER TABLE va_baseline ADD COLUMN IF NOT EXISTS content_as_of BIGINT NULL$/);
});

test('a work item a parent restore rewrote can be found by its own id', () => {
  // The panel summary asks "did a restore of a parent write to THIS item?" on
  // every paint. va_restore_action is keyed by restore, so without this index
  // that question is a scan of every step ever journaled.
  const sql = sqlFor('v106_restore_action_issue_index');
  assert.match(sql, /ALTER TABLE va_restore_action ADD INDEX IF NOT EXISTS idx_restore_action_issue \(issue_id, state\)/);
});

test('a mixed drift decision stores the exact field map it signed, NULL on every other approval', () => {
  const sql = sqlFor('v107_approval_decision_map');
  assert.match(sql, /ALTER TABLE va_approval/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS decision_map TEXT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS decision_map_hash CHAR\(64\) NULL/);
});
