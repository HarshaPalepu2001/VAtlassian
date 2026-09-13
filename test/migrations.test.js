import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS } from '../src/db/migrations.js';

function sqlFor(id) {
  const m = MIGRATIONS.find(x => x.id === id);
  if (!m) throw new Error(`Migration ${id} not found`);
  return m.sql;
}

test('tree values are keyed by baseline and logical node', () => {
  assert.match(
    sqlFor('v034_baseline_node_value'),
    /PRIMARY KEY \(baseline_id, logical_node_id, field_id, seq\)/
  );
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
