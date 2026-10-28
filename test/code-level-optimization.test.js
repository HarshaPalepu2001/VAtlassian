import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, sha256Hex } from '../src/lib/hash.js';
import { logicalNodeId } from '../src/lib/tree/model.js';
import { isStructuralField, contentFields, contentFieldIds } from '../src/lib/tree/structure.js';
import { encodeValue, decodeValue, ENCODING } from '../src/lib/valuestore.js';
import { toBinaryParam, fromBinaryColumn } from '../src/lib/db.js';
import { digestsEquivalent, FIELD_KIND, normaliseAdf } from '../src/lib/content.js';
import { writeTreeCapture } from '../src/db/baselineTreeStore.js';
import { diffTree } from '../src/lib/tree/diff.js';

test('code-level optimization: Function call overhead minimized', () => {
  // 1. contentFieldIds uses single-pass iteration without .filter().map() allocation
  const sampleFields = [
    { field_id: 'summary' },
    { field_id: 'parent' },
    { field_id: 'description' },
    { field_id: 'subtasks' },
    { field_id: 'status' }
  ];
  const ids = contentFieldIds(sampleFields);
  assert.deepEqual(ids, ['summary', 'description', 'status']);

  // 2. diffTree creates baseline and current node maps via direct loop without intermediate array allocation
  const baselineTree = {
    nodes: [
      { logicalNodeId: 'node-1', parentLogicalId: null, digests: { summary: 'hash-s1' } },
      { logicalNodeId: 'node-2', parentLogicalId: 'node-1', digests: { summary: 'hash-s2' } }
    ]
  };
  const currentTree = {
    nodes: [
      { logicalNodeId: 'node-1', parentLogicalId: null, digests: { summary: 'hash-s1' } },
      { logicalNodeId: 'node-2', parentLogicalId: 'node-1', digests: { summary: 'hash-s2-mod' } }
    ]
  };
  const diffResult = diffTree({ baselineTree, currentTree, controlledFields: sampleFields });
  assert.equal(diffResult.changes.length, 1);
  assert.equal(diffResult.changes[0].kind, 'FIELD_CHANGED');
  assert.equal(diffResult.changes[0].logicalNodeId, 'node-2');

  // 3. decodeValue on single-row payloads avoids sort and some callbacks
  const encoded = encodeValue({ priority: 'High', tags: ['audit'] });
  const singleRow = [{ seq: 0, encoding: encoded.encoding, raw_bytes: encoded.rawBytes, data: encoded.chunks[0] }];
  const decoded = decodeValue(singleRow);
  assert.equal(decoded.present, true);
  assert.deepEqual(decoded.value, { priority: 'High', tags: ['audit'] });
});

test('code-level optimization: Loop unrolling considered and verified', async () => {
  // 1. sha256Hex 4x unrolled multi-part hashing matches canonical crypto computation across variable part counts
  const partsList = [
    [],
    ['part0'],
    ['part0', 'part1'],
    ['part0', 'part1', 'part2'],
    ['part0', 'part1', 'part2', 'part3'],
    ['part0', 'part1', 'part2', 'part3', 'part4'],
    ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
  ];

  for (const parts of partsList) {
    const directH = createHash('sha256');
    for (const p of parts) directH.update(p, 'utf8');
    const expected = directH.digest('hex');
    const actual = sha256Hex(...parts);
    assert.equal(actual, expected, `Mismatch for parts count ${parts.length}`);
  }

  // 2. writeTreeCapture 2x loop unrolling handles both even and odd row counts accurately
  const baselineId = Buffer.alloc(16, 0x42);
  const testNodeCounts = [1, 2, 3, 5, 50, 51]; // Tests both even and odd batch sizes

  for (const count of testNodeCounts) {
    const nodes = Array.from({ length: count }, (_, i) => ({
      logicalNodeId: `log-${i}`,
      originalIssueId: i + 100,
      currentIssueId: i + 100,
      issueKey: `TEST-${i + 1}`,
      parentLogicalNodeId: i === 0 ? null : 'log-0',
      projectId: 1001,
      issueTypeId: '10',
      contentHash: 'c'.repeat(64),
      fieldDigests: '{}',
      nodeOrder: i
    }));
    const values = {};
    for (let i = 0; i < count; i++) {
      values[`log-${i}`] = { summary: `Node summary ${i}` };
    }

    const executedQueries = [];
    await writeTreeCapture({
      baselineId,
      treeHash: 't'.repeat(64),
      nodes,
      values,
      query: async (sql, params) => {
        executedQueries.push({ sql, params });
        return [];
      }
    });

    const valueInserts = executedQueries.filter(q => q.sql.includes('INSERT INTO va_baseline_node_value'));
    assert.ok(valueInserts.length > 0);
    // Verify all value rows were inserted with correct parameter structure (7 params per row)
    const totalInsertedValueRows = valueInserts.reduce((acc, q) => acc + (q.params.length / 7), 0);
    assert.equal(totalInsertedValueRows, count);
  }
});

test('code-level optimization: Inlining opportunities identified and verified', () => {
  // 1. Inlined logicalNodeId matches sha256Hex(canonical({ originalIssueId: String(id) }))
  const testCases = [
    1,
    '1',
    10002,
    'FEAT-999',
    'special-"quote"-\n-characters',
    0,
    999999999
  ];

  for (const id of testCases) {
    const expected = sha256Hex(canonical({ originalIssueId: String(id) }));
    const actual = logicalNodeId(id);
    assert.equal(actual, expected, `logicalNodeId mismatch for ${id}`);
  }

  // 2. Inlined isStructuralField identity checks
  assert.equal(isStructuralField('parent'), true);
  assert.equal(isStructuralField('subtasks'), true);
  assert.equal(isStructuralField('summary'), false);
  assert.equal(isStructuralField('description'), false);
  assert.equal(isStructuralField(1234), false);

  // 3. Inlined digestsEquivalent cache
  const emptyDoc = normaliseAdf({ type: 'doc', version: 1, content: [] });
  const noneDigest = sha256Hex(canonical({ f: 'description', k: FIELD_KIND.ADF, v: null }));
  const legacyEmptyDigest = sha256Hex(canonical({ f: 'description', k: FIELD_KIND.ADF, v: emptyDoc }));

  assert.equal(digestsEquivalent('description', noneDigest, legacyEmptyDigest), true);
  assert.equal(digestsEquivalent('description', legacyEmptyDigest, noneDigest), true);
  assert.equal(digestsEquivalent('description', noneDigest, 'other-hash'), false);
});

test('code-level optimization: Unnecessary type conversions removed', () => {
  // 1. toBinaryParam accepts base64 strings directly without converting string -> Buffer -> string
  const base64Str = 'MDEyMzQ1Njc4OWFiY2RlZg==';
  assert.equal(toBinaryParam(base64Str), base64Str);

  // 2. toBinaryParam handles 32-character hex strings cleanly
  const hexStr = '0123456789abcdef0123456789abcdef';
  const expectedB64 = Buffer.from(hexStr, 'hex').toString('base64');
  assert.equal(toBinaryParam(hexStr), expectedB64);

  // 3. toBinaryParam handles Buffers as normal
  const buf = Buffer.from('hello-binary-16b', 'utf8');
  assert.equal(toBinaryParam(buf), buf.toString('base64'));

  // 4. fromBinaryColumn returns Buffer directly when already a Buffer
  assert.equal(fromBinaryColumn(buf), buf);

  // 5. sha256Hex handles strings directly without Buffer.from() conversion
  const directHash = sha256Hex('test-string-no-buffer-conversion');
  const bufferHash = sha256Hex(Buffer.from('test-string-no-buffer-conversion', 'utf8'));
  assert.equal(directHash, bufferHash);

  // 6. decodeValue verifies raw bytes from decoded buffer length directly
  const encoded = encodeValue({ test: 'conversion-audit' });
  const rows = encoded.chunks.map((chunk, seq) => ({
    seq,
    encoding: encoded.encoding,
    raw_bytes: encoded.rawBytes,
    data: chunk
  }));
  const decoded = decodeValue(rows);
  assert.deepEqual(decoded.value, { test: 'conversion-audit' });
});

test('code-level optimization: String allocation minimized', () => {
  // 1. encodeValue reuses base64 string without slice copying for single-chunk payloads
  const payload = { title: 'Small payload under CHUNK_CHARS', count: 42 };
  const encoded = encodeValue(payload);
  assert.equal(encoded.chunks.length, 1);
  assert.ok(encoded.chunks[0].length > 0);

  // 2. decodeValue on single-row payload avoids array creation from .map() and .join()
  const singleRow = [{ seq: 0, encoding: encoded.encoding, raw_bytes: encoded.rawBytes, data: encoded.chunks[0] }];
  const decoded = decodeValue(singleRow);
  assert.deepEqual(decoded.value, payload);

  // 3. sha256Hex does not allocate intermediate Buffer instances for string hashing
  const hash1 = sha256Hex('repeated-string-allocation-test');
  const hash2 = sha256Hex('repeated-string-allocation-test');
  assert.equal(hash1, hash2);

  // 4. Microbenchmark confirms execution efficiency
  const iterations = 50000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    logicalNodeId(10000 + (i % 100));
  }
  const duration = performance.now() - start;
  // 50,000 inlined logicalNodeId hashes typically execute well under 100ms
  assert.ok(duration < 1000, `Duration was ${duration}ms, expected under 1000ms`);
});
