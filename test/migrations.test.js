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
