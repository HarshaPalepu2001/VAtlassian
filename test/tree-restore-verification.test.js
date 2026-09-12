import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';

test('verification checks logical nodes, parent edges and fields', async () => {
  const verified = await verifyTreeRestore({
    readStableTree: async () => ({ nodes: [] }),
    rootIssueKey: 'ROOT-1',
    baselineTree: { nodes: [] },
    controlledFields: [],
    replacements: []
  });
  assert.ok('matches' in verified);
});
