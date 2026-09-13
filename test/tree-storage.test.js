import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRootsForNode,
  beginTreeBaseline,
  publishTreeBaseline,
  readBaselineTree,
  verifyTreeCapture,
  writeTreeCapture
} from '../src/db/baselineTreeStore.js';
import { replaceTreeDrift, readTreeDrift } from '../src/db/treeDriftStore.js';
import { claimRestoreStep, finishRestoreStep, recordReplacement } from '../src/db/restoreTreeStore.js';
import { baselineByVersion, baselineHistory } from '../src/db/baselineStore.js';

test('activeRootsForNode returns only complete active baselines', async (t) => {
  const baselineIdBuffer = Buffer.alloc(16, 1);
  const baselineIdBase64 = baselineIdBuffer.toString('base64');

  const query = async (sql, params) => {
    assert.match(sql, /WHERE c.current_issue_id = \? AND b.state = 'ACTIVE'/);
    assert.deepEqual(params, [20002]);
    return [
      {
        baselineId: baselineIdBase64,
        rootIssueId: 10001,
        rootIssueKey: 'FEAT-1'
      }
    ];
  };

  const roots = await activeRootsForNode(20002, query);
  assert.deepEqual(roots, [{
    baselineId: baselineIdBuffer,
    rootIssueId: 10001,
    rootIssueKey: 'FEAT-1'
  }]);
});

test('baseline readers hide capturing tree rows', async () => {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    return [];
  };

  assert.equal(await baselineByVersion(1, 2, query), null);
  assert.deepEqual(await baselineHistory(1, 20, query), []);
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /state <> 'CAPTURING'/);
  assert.match(queries[1].sql, /state <> 'CAPTURING'/);
});

test('beginTreeBaseline reserves a distinct capturing baseline id', async () => {
  const queries = [];
  const approvalId = Buffer.alloc(16, 7);
  const baseline = {
    issue_id: 1, project_id: 100, issue_type_id: '200', version: 1,
    state: 'CAPTURING', content_hash: 'tree-hash', field_digests: '{}',
    transition_id: '5', from_status_id: '1', to_status_id: '2',
    approved_by: 'user-1', approved_name: 'Reviewer', transition_at: 10,
    captured_at: 11, assurance_level: 'ESIGNATURE', approval_id: approvalId,
    fidelity: 'EXACT', field_count: 2, value_bytes: 0, tree_hash: 'tree-hash',
    node_count: 2, edge_count: 1, total_field_count: 2
  };

  const result = await beginTreeBaseline({
    baseline,
    query: async (sql, params) => { queries.push({ sql, params }); }
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO va_baseline/);
  assert.match(queries[0].sql, /'CAPTURING'/);
  assert.match(queries[0].sql, /captured_at, assurance_level, approval_id/);
  assert.equal((queries[0].sql.match(/\?/g) ?? []).length, queries[0].params.length);
  assert.equal(queries[0].params[14], 'ESIGNATURE');
  assert.equal(queries[0].params[15], approvalId.toString('base64'));
  assert.equal(result.version, 1);
  assert.equal(Buffer.isBuffer(result.baselineId), true);
  assert.notDeepEqual(result.baselineId, approvalId);
});

test('beginTreeBaseline reserves the row with its immutable control provenance', async () => {
  const queries = [];
  await beginTreeBaseline({
    baseline: {
      issue_id: 1, project_id: 100, issue_type_id: '200', version: 1,
      content_hash: 'tree-hash', field_digests: '{}',
      transition_id: '5', from_status_id: '1', to_status_id: '2',
      required_role: 'Quality Reviewer', required_assurance: 'ESIGNATURE',
      controlled_fields_hash: 'c'.repeat(64),
      approved_by: 'user-1', approved_name: 'Reviewer', transition_at: 10,
      captured_at: 11, assurance_level: 'BIOMETRIC', approval_id: Buffer.alloc(16, 7),
      fidelity: 'EXACT', field_count: 2, tree_hash: 'tree-hash'
    },
    query: async (sql, params) => { queries.push({ sql, params }); }
  });

  assert.match(queries[0].sql, /required_role, required_assurance, controlled_fields_hash/);
  assert.equal((queries[0].sql.match(/\?/g) ?? []).length, queries[0].params.length);
  assert.deepEqual(queries[0].params.slice(-3), ['Quality Reviewer', 'ESIGNATURE', 'c'.repeat(64)]);
});

test('beginTreeBaseline resumes the capturing row without inserting another', async () => {
  const baselineId = Buffer.alloc(16, 4);
  const result = await beginTreeBaseline({
    baseline: { version: 3 },
    resume: { baseline_id: baselineId, version: 3, state: 'CAPTURING' },
    query: async () => assert.fail('resume must not insert')
  });
  assert.deepEqual(result, { baselineId, version: 3 });
});

test('writeTreeCapture executes proper queries with treeHash and calculated edgeCount', async () => {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
  };
  
  const baselineId = Buffer.alloc(16, 2);
  const nodes = [
    { logicalNodeId: 'node1', originalIssueId: 1, currentIssueId: 1, issueKey: 'KEY-1', parentLogicalNodeId: null, projectId: 1, issueTypeId: 1, contentHash: 'hash1', fieldDigests: '{}', nodeOrder: 0 },
    { logicalNodeId: 'node2', originalIssueId: 2, currentIssueId: 2, issueKey: 'KEY-2', parentLogicalNodeId: 'node1', projectId: 1, issueTypeId: 1, contentHash: 'hash2', fieldDigests: '{}', nodeOrder: 1 }
  ];
  const values = {
    'node1': { 'field1': 'value1' }
  };
  
  const result = await writeTreeCapture({ baselineId, treeHash: 'fakeTreeHash', nodes, values, query });
  
  // 2 insert node, 1 insert value, 1 update baseline
  assert.equal(queries.length, 4);
  
  const updateQuery = queries[3];
  assert.match(updateQuery.sql, /UPDATE va_baseline/);
  // Params: treeHash, nodeCount, edgeCount, totalFieldCount, bId
  assert.deepEqual(updateQuery.params.slice(0, 4), ['fakeTreeHash', 2, 1, 1]);
  assert.deepEqual(result, { baselineId, valueBytes: 8 });
});

test('verifyTreeCapture proves node, field, and tree metadata are complete', async () => {
  const baselineId = Buffer.alloc(16, 2);
  const result = await verifyTreeCapture({
    baselineId,
    expectedNodeCount: 2,
    expectedFieldCount: 3,
    expectedTreeHash: 'tree-hash',
    query: async (sql) => sql.includes('FROM va_baseline b') ? [{
      state: 'CAPTURING', treeHash: 'tree-hash', nodeCount: 2, totalFieldCount: 3,
      storedNodeCount: 2, storedFieldCount: 3
    }] : [
      { logicalNodeId: 'node-1', fieldId: 'summary', minSeq: 0, maxSeq: 0, chunkCount: 1, encodingCount: 1, rawBytesCount: 1 },
      { logicalNodeId: 'node-1', fieldId: 'description', minSeq: 0, maxSeq: 1, chunkCount: 2, encodingCount: 1, rawBytesCount: 1 },
      { logicalNodeId: 'node-2', fieldId: 'summary', minSeq: 0, maxSeq: 0, chunkCount: 1, encodingCount: 1, rawBytesCount: 1 }
    ]
  });
  assert.equal(result, true);
});

test('verifyTreeCapture fails closed when retained fields are incomplete', async () => {
  await assert.rejects(() => verifyTreeCapture({
    baselineId: Buffer.alloc(16, 2),
    expectedNodeCount: 2,
    expectedFieldCount: 3,
    expectedTreeHash: 'tree-hash',
    query: async () => [{
      state: 'CAPTURING', treeHash: 'tree-hash', nodeCount: 2, totalFieldCount: 2,
      storedNodeCount: 2, storedFieldCount: 2
    }]
  }), error => error.reason === 'CAPTURE_INCOMPLETE');
});

test('verifyTreeCapture fails closed when a retained field is missing a chunk', async () => {
  await assert.rejects(() => verifyTreeCapture({
    baselineId: Buffer.alloc(16, 2),
    expectedNodeCount: 1,
    expectedFieldCount: 1,
    expectedTreeHash: 'tree-hash',
    query: async (sql) => sql.includes('FROM va_baseline b') ? [{
      state: 'CAPTURING', treeHash: 'tree-hash', nodeCount: 1,
      totalFieldCount: 1, storedNodeCount: 1, storedFieldCount: 1
    }] : [{
      logicalNodeId: 'node-1', fieldId: 'description', minSeq: 0, maxSeq: 2,
      chunkCount: 2, encodingCount: 1, rawBytesCount: 1
    }]
  }), error => error.reason === 'CAPTURE_INCOMPLETE');
});

test('publishTreeBaseline activates before superseding older versions', async () => {
  const calls = [];
  await publishTreeBaseline({
    baselineId: Buffer.alloc(16, 2), issueId: 1, version: 3,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return calls.length === 1 ? { affectedRows: 1 } : { affectedRows: 2 };
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /SET state = 'ACTIVE'.*state = 'CAPTURING'/s);
  assert.match(calls[1].sql, /version < \?.*state = 'ACTIVE'/s);
  assert.deepEqual(calls[1].params, [1, 3]);
});

test('publishTreeBaseline cannot activate a row without control provenance', async () => {
  const calls = [];
  await assert.rejects(() => publishTreeBaseline({
    baselineId: Buffer.alloc(16, 2), issueId: 1, version: 3,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { affectedRows: 0 };
    }
  }), error => error.reason === 'CAPTURE_INCOMPLETE');

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /required_role IS NOT NULL/);
  assert.match(calls[0].sql, /required_assurance IS NOT NULL/);
  assert.match(calls[0].sql, /controlled_fields_hash IS NOT NULL/);
});

test('readBaselineTree fetches and decodes nodes and values', async (t) => {
  const { encodeValue } = await import('../src/lib/valuestore.js');
  const encoded = encodeValue('val');
  
  const query = async (sql, params) => {
    if (sql.includes('va_baseline_node_value')) {
      return [{
        logical_node_id: 'node1',
        field_id: 'f1',
        seq: 0,
        encoding: encoded.encoding,
        raw_bytes: encoded.rawBytes,
        data: encoded.chunks[0]
      }];
    } else {
      return [{
        logicalNodeId: 'node1', parentLogicalNodeId: null,
        fieldDigests: JSON.stringify({ f1: 'digest-1' })
      }];
    }
  };
  
  const res = await readBaselineTree(Buffer.alloc(16, 2), query);
  assert.deepEqual(res.nodes, [{
    logicalNodeId: 'node1', parentLogicalNodeId: null,
    fieldDigests: JSON.stringify({ f1: 'digest-1' })
  }]);
  assert.deepEqual(res.nodes[0].digests, { f1: 'digest-1' });
  assert.equal(res.nodes[0].parentLogicalId, null);
  assert.equal(res.values['node1']['f1'], 'val');
});

test('replaceTreeDrift clears old and inserts new drift records', async (t) => {
  const queries = [];
  const query = async (sql, params) => { queries.push({ sql, params }); };
  
  await replaceTreeDrift(Buffer.alloc(16), [{ logicalNodeId: 'node1', fieldId: 'f1', detectedAt: 12345 }], query);
  
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /DELETE FROM va_tree_drift/);
  assert.match(queries[1].sql, /INSERT INTO va_tree_drift/);
});

test('readTreeDrift reads tree drift', async (t) => {
  const query = async (sql, params) => [{ logicalNodeId: 'node1' }];
  const res = await readTreeDrift(Buffer.alloc(16), query);
  assert.deepEqual(res, [{ logicalNodeId: 'node1' }]);
});

test('claimRestoreStep records step start', async (t) => {
  const queries = [];
  const query = async (sql, params) => { queries.push({ sql, params }); };
  
  await claimRestoreStep(Buffer.alloc(16), 'node1', 123, query);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO va_restore_step/);
});

test('finishRestoreStep records step finish', async (t) => {
  const queries = [];
  const query = async (sql, params) => { queries.push({ sql, params }); };
  
  await finishRestoreStep(Buffer.alloc(16), 'node1', true, { error: null }, query);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /UPDATE va_restore_step/);
});

test('recordReplacement records node replacement', async (t) => {
  const queries = [];
  const query = async (sql, params) => { queries.push({ sql, params }); };
  
  await recordReplacement(Buffer.alloc(16), 'node1', 1, 2, query);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO va_restore_replacement/);
});
