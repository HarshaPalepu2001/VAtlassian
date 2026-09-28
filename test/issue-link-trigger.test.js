import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/triggers/issue-link.js';

// A link event used to run the single-issue collector on both ends. Every
// baseline a capture writes is a tree, whose va_baseline row keeps '{}' for
// digests, so that collector compared the item against nothing and recorded
// every tracked field as drift. Both ends now go the way an issue update goes:
// their tree (collectTree) and, for a child with its own record, collect().

test('a link event measures both ends through the tree-aware collector', async () => {
  const seen = [];
  const deps = {
    collectAffectedTrees: async event => { seen.push(String(event.issue.id)); return [{ outcome: 'NO_CHANGE' }]; },
    collect: async () => assert.fail('the single-issue collector must not be called directly'),
    recordReceipt: async () => {}
  };
  await run({ eventId: 'e1', issueLink: { sourceIssueId: 43979, destinationIssueId: 43903 } }, deps);
  assert.deepEqual(seen, ['43979', '43903']);
});

test('an end busy with its own decision asks Forge to redeliver the event', async () => {
  const deps = {
    collectAffectedTrees: async event => [{ outcome: String(event.issue.id) === '43903' ? 'BUSY' : 'NO_CHANGE' }],
    recordReceipt: async () => {}
  };
  const result = await run({ eventId: 'e2', issueLink: { sourceIssueId: 43979, destinationIssueId: 43903 } }, deps);
  assert.equal(result?._retry, true);
});
