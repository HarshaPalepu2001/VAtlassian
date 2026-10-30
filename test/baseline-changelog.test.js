import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySource, attributionByField, timeline, lastTouchByField, highestChangelogId,
  fetchChangelog, SOURCE
} from '../src/lib/changelog.js';

/** A fake Jira changelog response, in the shape the API actually returns. */
function page(values, total = values.length) {
  return {
    ok: true,
    json: async () => ({ values, total, startAt: 0, maxResults: 100 })
  };
}

function history(id, created, author, items) {
  return { id: String(id), created, author, items };
}

const ANA = { accountId: 'ana', displayName: 'Ana Rivera', accountType: 'atlassian' };
const AUTOMATION = { accountId: 'auto', displayName: 'Automation for Jira', accountType: 'app' };
const OTHER_APP = { accountId: 'app1', displayName: 'Some Integration', accountType: 'app' };

// ─── Source classification ───────────────────────────────────────────────────

test('an automation is distinguished from a person and from another app', () => {
  // "An app did it" is a materially different answer from "a colleague did it",
  // and it is the reviewer's first question about an unexpected change.
  assert.equal(classifySource(ANA), SOURCE.USER);
  assert.equal(classifySource(AUTOMATION), SOURCE.AUTOMATION);
  assert.equal(classifySource(OTHER_APP), SOURCE.APP);
  assert.equal(classifySource({ accountType: 'customer' }), SOURCE.CUSTOMER);
  assert.equal(classifySource(null), SOURCE.UNKNOWN);
});

test('accountType takes precedence and a display name alone cannot imply AUTOMATION', () => {
  // A display name is user-visible text a site admin can change and another app
  // could imitate, so it only ever REFINES an already-app account type.
  assert.equal(classifySource({ displayName: 'Automation for Jira', accountType: 'atlassian' }), SOURCE.USER);
});

// ─── Fetching ────────────────────────────────────────────────────────────────

test('entries are sorted oldest-first regardless of what the API returned', () => {
  // Documented as oldest-first, but a single out-of-order page would silently
  // corrupt every "who changed it last" answer, and sorting costs nothing.
  const request = async () => page([
    history(3, '2026-03-03T00:00:00.000Z', ANA, []),
    history(1, '2026-03-01T00:00:00.000Z', ANA, [])
  ]);
  return fetchChangelog(request).then(({ entries }) => {
    assert.deepEqual(entries.map((e) => e.changelogId), ['1', '3']);
  });
});

test('a failed fetch reports failure rather than an empty history', () => {
  // An empty history and an unreadable one mean completely different things:
  // one says nothing changed, the other says we do not know.
  return fetchChangelog(async () => ({ ok: false, status: 500 })).then((result) => {
    assert.equal(result.failed, true);
    assert.equal(result.truncated, true);
  });
});

test('a thrown request is handled, not propagated', () => {
  return fetchChangelog(async () => { throw new Error('network'); }).then((result) => {
    assert.equal(result.failed, true);
  });
});

test('sinceMs filters out entries from before the baseline', () => {
  const request = async () => page([
    history(1, '2026-03-01T00:00:00.000Z', ANA, []),
    history(2, '2026-03-05T00:00:00.000Z', ANA, [])
  ]);
  return fetchChangelog(request, { sinceMs: Date.parse('2026-03-03T00:00:00.000Z') })
    .then(({ entries }) => {
      assert.deepEqual(entries.map((e) => e.changelogId), ['2']);
    });
});

// ─── Attribution ─────────────────────────────────────────────────────────────

const ENTRIES = [
  {
    changelogId: '1', at: 100, authorId: 'auto', authorName: 'Automation for Jira', source: SOURCE.AUTOMATION,
    items: [{ fieldId: 'priority', fieldName: 'Priority', fromString: 'High', toString: 'Highest' }]
  },
  {
    changelogId: '2', at: 200, authorId: 'ana', authorName: 'Ana Rivera', source: SOURCE.USER,
    items: [
      { fieldId: 'priority', fieldName: 'Priority', fromString: 'Highest', toString: 'High' },
      { fieldId: 'summary', fieldName: 'Summary', fromString: 'a', toString: 'b' }
    ]
  },
  {
    changelogId: '3', at: 300, authorId: 'sam', authorName: 'Sam Okafor', source: SOURCE.USER,
    items: [{ fieldId: 'priority', fieldName: 'Priority', fromString: 'High', toString: 'Highest' }]
  }
];

test('the per-field timeline is what turns a diff into an account of what happened', () => {
  // "Priority went from High to Highest" is a diff. "Raised by automation,
  // lowered by Ana, raised again by Sam" names the actors and sequence,
  // and only the changelog can supply it.
  const byField = attributionByField(ENTRIES, ['priority']);
  assert.equal(byField.priority.length, 3);
  assert.deepEqual(byField.priority.map((t) => t.authorName), [
    'Automation for Jira', 'Ana Rivera', 'Sam Okafor'
  ]);
});

test('fields nobody asked about are dropped', () => {
  const byField = attributionByField(ENTRIES, ['priority']);
  assert.equal(byField.summary, undefined);
});

test('lastTouchByField reports who touched it last, and how many times', () => {
  const touched = lastTouchByField(ENTRIES, ['priority']);
  assert.equal(touched.priority.authorName, 'Sam Okafor');
  assert.equal(touched.priority.occurrences, 3);
  assert.equal(touched.priority.firstAt, 100);
  assert.deepEqual(touched.priority.authors.sort(), ['ana', 'auto', 'sam']);
});

test('the timeline groups one save touching two fields into one action', () => {
  // Presenting it as two separate changes overstates how much happened.
  const rows = timeline(ENTRIES, ['priority', 'summary']);
  const anaRow = rows.find((r) => r.authorName === 'Ana Rivera');
  assert.equal(anaRow.fields.length, 2);
  assert.equal(rows.length, 3);
});

test('highestChangelogId is the reconcile watermark, and survives a non-numeric id', () => {
  assert.equal(highestChangelogId(ENTRIES), '3');
  assert.equal(highestChangelogId([{ changelogId: 'abc', at: 1 }]), null);
  assert.equal(highestChangelogId([]), null);
});
