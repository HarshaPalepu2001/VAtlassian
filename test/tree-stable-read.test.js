import test from 'node:test';
import assert from 'node:assert';
import { readStableTree, FailClosed } from '../src/lib/tree/stableRead.js';

function sixteenFieldIds() {
  return Array.from({ length: 16 }, (_, i) => `field_${i}`);
}

test('stable read retries when a child is added between reads', async () => {
  let callCount = 0;
  function changingReader() {
    return async (rootIssueKey, fieldIds) => {
      callCount++;
      if (callCount === 1) { 
        return { nodes: [{ id: '1', key: 'FEAT-1', fields: { parent: null } }, { id: '2', key: 'STORY-1', fields: { parent: { id: '1' } } }] };
      } else if (callCount === 2) { 
        return { nodes: [{ id: '1', key: 'FEAT-1', fields: { parent: null } }, { id: '2', key: 'STORY-1', fields: { parent: { id: '1' } } }, { id: '3', key: 'SUB-1', fields: { parent: { id: '2' } } }] };
      } else if (callCount === 3) { 
        return { nodes: [{ id: '1', key: 'FEAT-1', fields: { parent: null } }, { id: '2', key: 'STORY-1', fields: { parent: { id: '1' } } }, { id: '3', key: 'SUB-1', fields: { parent: { id: '2' } } }] };
      } else if (callCount === 4) { 
        return { nodes: [{ id: '1', key: 'FEAT-1', fields: { parent: null } }, { id: '2', key: 'STORY-1', fields: { parent: { id: '1' } } }, { id: '3', key: 'SUB-1', fields: { parent: { id: '2' } } }] };
      }
      return { nodes: [] };
    };
  }

  const result = await readStableTree({
    readTree: changingReader(), rootIssueKey: 'FEAT-1', fieldIds: sixteenFieldIds()
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.tree.nodes.length, 3);
});

test('stable read fails closed when tree keeps changing', async () => {
  let callCount = 0;
  function changingReader() {
    return async (rootIssueKey, fieldIds) => {
      callCount++;
      return { nodes: [{ id: '1', key: 'FEAT-1' }, { id: callCount.toString(), key: 'STORY-1', fields: { parent: { id: '1' } } }] };
    };
  }

  try {
    await readStableTree({
      readTree: changingReader(), rootIssueKey: 'FEAT-1', fieldIds: sixteenFieldIds()
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof FailClosed);
    assert.equal(err.reason, 'TREE_CHANGED_DURING_CAPTURE');
  }
});
