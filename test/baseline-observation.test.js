import test from 'node:test';
import assert from 'node:assert/strict';
import { observationPlan, recordObservation } from '../src/db/observationStore.js';
import { project } from '../src/lib/content.js';

const fields = [{ field_id: 'summary', field_kind: 'TEXT', store_values: true }];
const projection = project({ summary: 'Approved' }, fields);
const args = { issueId: 1, baseline: { baseline_id: Buffer.alloc(16, 1), version: 1, field_digests: projection.digests },
  fields, issueFields: { summary: 'Changed' }, eventId: 'evt1', eventAt: 10, observedAt: 20, detectedVia: 'EVENT' };
test('each observed event gets a complete cryptographic projection and changed retained values', () => {
  const p = observationPlan(args);
  assert.equal(p.matches, false); assert.equal(p.chunks.length, 1);
  assert.equal(p.eventAt, 10); assert.equal(p.observedAt, 20);
  assert.notEqual(p.key, observationPlan({ ...args, eventId: 'evt2' }).key);
  assert.equal(p.key, observationPlan({ ...args, observedAt: 30 }).key);
});
test('untracked edits are verified against baseline without duplicating approved values', () => {
  const p = observationPlan({ ...args, issueFields: { summary: 'Approved', untracked: 'changed' } });
  assert.equal(p.matches, true); assert.equal(p.chunks.length, 0);
  assert.deepEqual(p.projection.digests, projection.digests);
});
test('partial snapshot writes never publish COMPLETE and can be retried', async () => {
  const calls = [];
  await assert.rejects(recordObservation(args, async sql => {
    calls.push(sql);
    if (sql.startsWith('SELECT')) return [];
    if (sql.includes('INSERT INTO va_observation_value')) throw new Error('storage unavailable');
    return [];
  }), /storage unavailable/);
  assert.ok(!calls.some(sql => sql.includes("SET state = 'COMPLETE'")));
});
