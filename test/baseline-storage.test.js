import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllValues, valueBatches } from '../src/db/baselineStore.js';
import { encodeValue, decodeValue } from '../src/lib/valuestore.js';

test('read a 100-field baseline with bounded chunk pages instead of per-field queries', async () => {
  const expected = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`customfield_${String(i).padStart(3, '0')}`, { value: i }]));
  const rows = Object.entries(expected).flatMap(([field_id, value]) => {
    const encoded = encodeValue(value);
    return encoded.chunks.map((data, seq) => ({ field_id, seq, data, encoding: encoded.encoding, raw_bytes: encoded.rawBytes }));
  });
  let calls = 0;
  const query = async (sql, params) => {
    calls++;
    const [issue, version, lastField, sameField, lastSeq] = params;
    assert.equal(issue, 42); assert.equal(version, 3);
    return rows.filter(r => r.field_id > lastField || (r.field_id === sameField && r.seq > lastSeq)).slice(0, 20);
  };
  assert.deepEqual(await readAllValues(42, 3, query), expected);
  assert.equal(calls, 6);
});

test('missing or mixed chunks cannot be mistaken for a complete value', () => {
  assert.throws(() => decodeValue([{ seq: 1, encoding: 'PLAIN_B64', data: Buffer.from('null').toString('base64') }]), /INCOMPLETE/);
  assert.throws(() => decodeValue([{ seq: 0, encoding: 'UNKNOWN', data: 'bnVsbA==' }]), /ENCODING/);
});

test('100 small values use one write; large chunks respect the request byte limit', () => {
  assert.equal(valueBatches(Array.from({ length: 100 }, (_, i) => [i, 'small'])).length, 1);
  const rows = Array.from({ length: 13 }, (_, i) => [i, 'x'.repeat(180000)]);
  const batches = valueBatches(rows);
  assert.equal(batches.flat().length, 13);
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) < 850000));
});
