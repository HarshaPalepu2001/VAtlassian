import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineByVersion, readAllValues, valueBatches, writeBaseline } from '../src/db/baselineStore.js';
import { encodeValue, decodeValue } from '../src/lib/valuestore.js';

function provenancedBaseline() {
  return {
    issue_id: 1, project_id: 100, issue_type_id: '200', version: 2,
    content_hash: 'content-hash', field_digests: '{}',
    transition_id: '31', from_status_id: 'review', to_status_id: 'approved',
    required_role: 'Quality Reviewer', required_assurance: 'ESIGNATURE',
    controlled_fields_hash: 'd'.repeat(64),
    approved_by: 'user-1', approved_name: 'Reviewer', transition_at: 10, captured_at: 11,
    assurance_level: 'BIOMETRIC', approval_id: Buffer.alloc(16, 7), fidelity: 'EXACT', field_count: 1
  };
}

// The evidence every writeBaseline call now passes explicitly; these tests are
// about the baseline row, so its evidence is not required and not written.
const unrequiredEvidence = () => ({ evidence: { required: false, cause: 'OWN_TRANSITION', links: [],
  evidence: { fields: [], rules: [], signatures: [] } }, writeEvidence: async () => {} });

test('scalar baseline insert records immutable control provenance', async () => {
  const queries = [];
  await writeBaseline({
    baseline: provenancedBaseline(), raw: {}, ...unrequiredEvidence(),
    query: async (sql, params) => {
      queries.push({ sql, params });
      return sql.includes("SET state = 'ACTIVE'") ? { affectedRows: 1 } : [];
    },
    execute: async () => ({ result: true, data: { affectedRows: 0 } })
  });

  const insert = queries.find(entry => entry.sql.includes('INSERT INTO va_baseline\n'));
  assert.match(insert.sql, /required_role, required_assurance, controlled_fields_hash/);
  assert.equal((insert.sql.match(/\?/g) ?? []).length, insert.params.length);
  assert.deepEqual(insert.params.slice(-3), ['Quality Reviewer', 'ESIGNATURE', 'd'.repeat(64)]);
});

test('scalar publication is guarded by provenance at the database update', async () => {
  const queries = [];
  const executed = [];
  await assert.rejects(() => writeBaseline({
    baseline: provenancedBaseline(), raw: {}, ...unrequiredEvidence(),
    query: async (sql, params) => {
      queries.push({ sql, params });
      return sql.includes("SET state = 'ACTIVE'") ? { affectedRows: 0 } : [];
    },
    execute: async sql => { executed.push(sql); return { result: true, data: {} }; }
  }), error => error.reason === 'CAPTURE_INCOMPLETE');

  const publish = queries.find(entry => entry.sql.includes("SET state = 'ACTIVE'"));
  assert.match(publish.sql, /required_role IS NOT NULL/);
  assert.match(publish.sql, /required_assurance IS NOT NULL/);
  assert.match(publish.sql, /controlled_fields_hash IS NOT NULL/);
  assert.deepEqual(executed, [], 'an unpublished baseline must not supersede the standing one');
});

test('controlled-field provenance has one canonical server-side hash', async () => {
  const policy = await import('../src/lib/baselinePolicy.js').catch(() => null);
  assert.equal(typeof policy?.controlledFieldsHash, 'function');

  const fields = [{
    field_id: 'summary', field_kind: 'TEXT', schema_type: 'string',
    materiality: 'MAJOR', store_values: true, writable: false
  }];
  const expected = 'fd72aecbb8f6bb81b736aef9a8487475cbd738237f347353fbc93b37c8599e5f';

  assert.equal(policy.controlledFieldsHash(fields, { summary: true }), expected);
  assert.equal(policy.controlledFieldsHash([...fields].reverse(), { summary: true }), expected);
  assert.notEqual(policy.controlledFieldsHash(fields, { summary: false }), expected);
});

test('baseline policy remains the signed policy after the current rule changes', async () => {
  const policyModule = await import('../src/lib/baselinePolicy.js');
  assert.equal(typeof policyModule.baselinePolicy, 'function');
  const baselineId = Buffer.alloc(16, 4);
  const baseline = {
    baseline_id: baselineId,
    version: 7,
    transition_id: '31',
    from_status_id: 'review',
    to_status_id: 'approved',
    required_role: 'Quality Reviewer',
    required_assurance: 'ESIGNATURE',
    controlled_fields_hash: 'a'.repeat(64),
    assurance_level: 'BIOMETRIC'
  };
  const currentRule = {
    transition_id: '99', required_role: 'Administrator', required_assurance: 'BIOMETRIC'
  };

  const result = policyModule.baselinePolicy(baseline);
  currentRule.transition_id = '100';

  assert.deepEqual(result, {
    baselineId,
    version: 7,
    transitionId: '31',
    reviewStatusId: 'review',
    destinationStatusId: 'approved',
    requiredRole: 'Quality Reviewer',
    requiredAssurance: 'ESIGNATURE',
    controlledFieldsHash: 'a'.repeat(64)
  });
  assert.equal(baseline.assurance_level, 'BIOMETRIC');
  assert.equal(result.requiredAssurance, 'ESIGNATURE');
});

test('an incomplete historical baseline cannot supply drift authority', async () => {
  const { baselinePolicy } = await import('../src/lib/baselinePolicy.js');
  assert.equal(typeof baselinePolicy, 'function');
  const complete = {
    baseline_id: Buffer.alloc(16, 4), version: 1, transition_id: '31',
    from_status_id: 'review', to_status_id: 'approved', required_role: 'Quality Reviewer',
    required_assurance: 'ESIGNATURE', controlled_fields_hash: 'b'.repeat(64)
  };

  for (const field of [
    'baseline_id', 'version', 'transition_id', 'from_status_id', 'to_status_id',
    'required_role', 'required_assurance', 'controlled_fields_hash'
  ]) {
    const incomplete = { ...complete, [field]: null };
    assert.throws(
      () => baselinePolicy(incomplete),
      error => error.reason === 'BASELINE_POLICY_INCOMPLETE',
      `${field} must be required`
    );
  }
});

test('baseline reads include immutable control provenance', async () => {
  let statement = '';
  await baselineByVersion(42, 3, async sql => {
    statement = sql;
    return [];
  });

  assert.match(statement, /required_role/);
  assert.match(statement, /required_assurance/);
  assert.match(statement, /controlled_fields_hash/);
});

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

test('a baseline read carries the parent capture that produced it, decoded', async () => {
  const parent = Buffer.alloc(16, 9);
  const own = await baselineByVersion(1, 2, async sql => {
    assert.match(sql, /TO_BASE64\(captured_by_baseline_id\) AS captured_by_baseline_id/);
    return [{ baseline_id: Buffer.alloc(16, 1).toString('base64'), approval_id: null, captured_by_baseline_id: null }];
  });
  assert.equal(own.captured_by_baseline_id, null);
  const child = await baselineByVersion(1, 2, async () =>
    [{ baseline_id: Buffer.alloc(16, 1).toString('base64'), approval_id: null, captured_by_baseline_id: parent.toString('base64') }]);
  assert.ok(Buffer.from(child.captured_by_baseline_id).equals(parent));
});

test('between deploy and migration, baseline reads fall back to the columns that exist', async () => {
  const seen = [];
  const row = await baselineByVersion(1, 2, async sql => {
    seen.push(sql);
    if (sql.includes('captured_by_baseline_id')) throw Object.assign(new Error("Unknown column 'captured_by_baseline_id'"), { code: 'ER_BAD_FIELD_ERROR' });
    return [{ baseline_id: Buffer.alloc(16, 1).toString('base64'), approval_id: null }];
  });
  assert.equal(seen.length, 4, 'link policy first, then the three older column sets');
  assert.ok(seen[0].includes('link_policy'));
  assert.equal(row.captured_by_baseline_id, null);
  // v068 alone missing: captured_by is still read.
  const partial = await baselineByVersion(1, 2, async sql => {
    if (sql.includes('nodes_captured_at')) throw Object.assign(new Error("Unknown column 'nodes_captured_at'"), { code: 'ER_BAD_FIELD_ERROR' });
    return [{ baseline_id: Buffer.alloc(16, 1).toString('base64'), approval_id: null,
      captured_by_baseline_id: Buffer.alloc(16, 2).toString('base64') }];
  });
  assert.deepEqual(partial.captured_by_baseline_id, Buffer.alloc(16, 2));
  assert.equal(partial.nodes_captured_at, null);
  await assert.rejects(() => baselineByVersion(1, 2, async () => { throw new Error('connection reset'); }), /connection reset/,
    'any other failure still fails');
});

test('a capture\'s evidence is written before publication, and publication requires it', async () => {
  const order = [];
  await writeBaseline({
    baseline: provenancedBaseline(), raw: {},
    evidence: { required: true, cause: 'OWN_TRANSITION', links: [], evidence: { fields: [], rules: [], signatures: [] } },
    writeEvidence: async ({ entries }) => { order.push(['evidence', entries[0].cause, entries[0].baselineId.length]); },
    query: async sql => {
      if (sql.includes("SET state = 'ACTIVE'")) { order.push(['publish', sql]); return { affectedRows: 1 }; }
      return [];
    },
    execute: async () => ({ result: true, data: {} })
  });
  assert.deepEqual(order[0], ['evidence', 'OWN_TRANSITION', 16]);
  assert.equal(order[1][0], 'publish');
  assert.match(order[1][1], /AND policy_recorded = TRUE/);
});

test('a version without required evidence publishes on its provenance alone', async () => {
  let publish;
  await writeBaseline({
    baseline: provenancedBaseline(), raw: {},
    evidence: { required: false, cause: 'LINK_RECORD', links: [], evidence: { fields: [], rules: [], signatures: [] } },
    writeEvidence: async () => {},
    query: async sql => { if (sql.includes("SET state = 'ACTIVE'")) { publish = sql; return { affectedRows: 1 }; } return []; },
    execute: async () => ({ result: true, data: {} })
  });
  assert.doesNotMatch(publish, /policy_recorded/);
});

test('a write without its evidence is refused before anything is written', async () => {
  const written = [];
  const record = async sql => { written.push(sql); return { affectedRows: 1, result: true, data: {} }; };
  for (const evidence of [undefined, null]) {
    await assert.rejects(() => writeBaseline({ baseline: provenancedBaseline(), raw: { summary: 'x' }, evidence,
      writeEvidence: async () => { written.push('evidence'); }, query: record, execute: record }),
    error => error.reason === 'CAPTURE_INCOMPLETE');
  }
  assert.deepEqual(written, []);
});

test('a resumed capture clears its version\'s earlier evidence, then writes this attempt\'s', async () => {
  const resume = { baseline_id: Buffer.alloc(16, 5), state: 'CAPTURING', version: 2 };
  const run = state => {
    const order = [];
    const written = writeBaseline({ baseline: provenancedBaseline(), raw: {}, resume,
      evidence: { required: true, cause: 'OWN_TRANSITION', links: [], evidence: { fields: [], rules: [], signatures: [] } },
      writeEvidence: async ({ entries }) => { order.push(['evidence', entries[0].baselineId.equals(resume.baseline_id)]); },
      query: async (sql, params) => {
        const text = sql.replace(/\s+/g, ' ').trim();
        if (text.startsWith('SELECT state FROM va_baseline')) { order.push(['state', params[0]]); return [{ state }]; }
        if (text.startsWith('DELETE FROM')) order.push(['delete', text.match(/DELETE FROM (\w+)/)[1]]);
        if (text.includes("SET state = 'ACTIVE'")) { order.push(['publish']); return { affectedRows: 1 }; }
        return [];
      },
      execute: async () => ({ result: true, data: {} }) });
    return { order, written };
  };
  const resumed = run('CAPTURING');
  await resumed.written;
  assert.deepEqual(resumed.order, [['state', resume.baseline_id.toString('base64')],
    ['delete', 'va_baseline_field'], ['delete', 'va_baseline_rule'], ['delete', 'va_baseline_signature'],
    ['delete', 'va_baseline_link'], ['delete', 'va_baseline_value'], ['evidence', true], ['publish']]);
  const published = run('ACTIVE');
  await assert.rejects(() => published.written, error => error.reason === 'CAPTURE_INCOMPLETE');
  assert.deepEqual(published.order, [['state', resume.baseline_id.toString('base64')]],
    'a version that is no longer CAPTURING is never cleared or rewritten');
});
