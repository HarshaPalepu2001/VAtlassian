import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRootsForNode, writeTreeCapture, readBaselineTree } from '../src/db/baselineTreeStore.js';
import { replaceTreeDrift, readTreeDrift } from '../src/db/treeDriftStore.js';
import { claimRestoreStep, finishRestoreStep, recordReplacement } from '../src/db/restoreTreeStore.js';

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

test('writeTreeCapture executes proper queries with treeHash and calculated edgeCount', async (t) => {
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
  
  await writeTreeCapture(baselineId, 1, 'KEY-1', 'fakeTreeHash', nodes, values, query);
  
  // 2 insert node, 1 insert value, 1 update baseline
  assert.equal(queries.length, 4);
  
  const updateQuery = queries[3];
  assert.match(updateQuery.sql, /UPDATE va_baseline/);
  // Params: treeHash, nodeCount, edgeCount, totalFieldCount, bId
  assert.deepEqual(updateQuery.params.slice(0, 4), ['fakeTreeHash', 2, 1, 1]);
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
      return [{ logicalNodeId: 'node1' }];
    }
  };
  
  const res = await readBaselineTree(Buffer.alloc(16, 2), query);
  assert.deepEqual(res.nodes, [{ logicalNodeId: 'node1' }]);
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
