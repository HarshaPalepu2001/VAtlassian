import test from 'node:test';
import assert from 'node:assert/strict';
import { project, FIELD_KIND, normaliseField } from '../src/lib/content.js';
import { decide } from '../src/lib/decision.js';

test('cascading option child is part of the signed record', () => {
  const fields = [{ field_id: 'customfield_1', field_kind: FIELD_KIND.SCALAR, store_values: true }];
  const before = project({ customfield_1: { id: '1', child: { id: '2' } } }, fields);
  const after = project({ customfield_1: { id: '1', child: { id: '3' } } }, fields);
  assert.notEqual(before.contentHash, after.contentHash);
});

test('account display-name changes do not change a signed user identity', () => {
  assert.equal(normaliseField(FIELD_KIND.SCALAR, { accountId: 'a', displayName: 'Before' }),
    normaliseField(FIELD_KIND.SCALAR, { accountId: 'a', displayName: 'After' }));
});

test('a rich document accidentally classified as text still detects content edits', () => {
  const doc = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  assert.notDeepEqual(normaliseField(FIELD_KIND.TEXT, doc('Before')), normaliseField(FIELD_KIND.TEXT, doc('After')));
});

test('formatting-only integrity drift can be rejected and restored', () => {
  assert.equal(decide({ decision: 'REJECT', diff: { changedFieldCount: 1, materialFieldCount: 0 },
    plan: { steps: [{ strategy: 'field' }] } }).allow, true);
});

test('100 configured fields are all hashed and retained', () => {
  const fields = Array.from({ length: 100 }, (_, i) => ({ field_id: `customfield_${i}`, field_kind: FIELD_KIND.SCALAR, store_values: true }));
  const values = Object.fromEntries(fields.map((f, i) => [f.field_id, i]));
  const snapshot = project(values, fields);
  assert.equal(Object.keys(snapshot.digests).length, 100);
  assert.deepEqual(snapshot.raw, values);
});
