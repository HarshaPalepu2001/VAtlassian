import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRootsForNode } from '../src/db/baselineTreeStore.js';

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
