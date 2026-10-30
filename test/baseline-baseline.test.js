import test from 'node:test';
import assert from 'node:assert/strict';
import { rewind, planCapture, worstFidelity, textToAdf, FIDELITY } from '../src/lib/baseline.js';
import { FIELD_KIND } from '../src/lib/content.js';

const FIELDS = [
  { field_id: 'summary', field_kind: FIELD_KIND.TEXT, store_values: true },
  { field_id: 'description', field_kind: FIELD_KIND.ADF, store_values: true },
  { field_id: 'priority', field_kind: FIELD_KIND.SCALAR, store_values: true },
  { field_id: 'labels', field_kind: FIELD_KIND.MULTI, store_values: true }
];

const TRANSITION_AT = 1_000_000;

function entry(at, items) {
  return { changelogId: String(at), at, authorId: 'u1', authorName: 'Someone', source: 'USER', items };
}

// ─── The window this whole module exists to close ────────────────────────────

test('nothing changed after the transition: the read IS the approved state, graded EXACT', () => {
  // The trigger runs within a second or two in the common case.
  const result = rewind({
    issueFields: { summary: 'Ship it' },
    controlledFields: FIELDS,
    changelogEntries: [entry(TRANSITION_AT - 5000, [{ fieldId: 'summary' }])],
    transitionAt: TRANSITION_AT
  });
  assert.equal(result.fidelity, FIDELITY.EXACT);
  assert.deepEqual(result.rewoundFields, []);
});

test('an edit landing in the async gap is REWOUND, not absorbed into the approved state', () => {
  // The bug most implementations ship with: the transitioned trigger is
  // asynchronous, so an edit made between the transition committing and the
  // capture running would silently become part of what "was approved".
  const result = rewind({
    issueFields: { summary: 'Ship it TOMORROW' },
    controlledFields: FIELDS,
    changelogEntries: [
      entry(TRANSITION_AT + 500, [
        { fieldId: 'summary', fromString: 'Ship it', toString: 'Ship it TOMORROW' }
      ])
    ],
    transitionAt: TRANSITION_AT
  });

  assert.equal(result.fields.summary, 'Ship it');
  assert.deepEqual(result.rewoundFields, ['summary']);
  assert.equal(result.fidelity, FIDELITY.EXACT);
});

test('rewinding several changes lands on the value before the FIRST of them', () => {
  // Taking the newest entry's `from` would stop one step short.
  const result = rewind({
    issueFields: { priority: { id: '1' } },
    controlledFields: FIELDS,
    changelogEntries: [
      entry(TRANSITION_AT + 100, [{ fieldId: 'priority', from: '3', to: '2' }]),
      entry(TRANSITION_AT + 200, [{ fieldId: 'priority', from: '2', to: '1' }])
    ],
    transitionAt: TRANSITION_AT
  });
  assert.equal(result.fields.priority, '3');
});

test('rich text rewound from a lossy changelog is graded RECONSTRUCTED, never EXACT', () => {
  // The changelog carries only a flattened string for ADF, so the rewound value
  // is text-faithful and structure-lossy. The panel shows the grade; the app
  // never claims a fidelity it does not have.
  const result = rewind({
    issueFields: { description: { type: 'doc', content: [] } },
    controlledFields: FIELDS,
    changelogEntries: [
      entry(TRANSITION_AT + 100, [
        { fieldId: 'description', fromString: 'the approved text', toString: 'something else' }
      ])
    ],
    transitionAt: TRANSITION_AT
  });

  assert.equal(result.fidelity, FIDELITY.RECONSTRUCTED);
  assert.equal(result.fields.description.type, 'doc');
  assert.equal(result.fields.description.content[0].content[0].text, 'the approved text');
});

test('attachments and links cannot be rewound, so the baseline is graded PARTIAL', () => {
  const fields = [{ field_id: 'attachment', field_kind: FIELD_KIND.ATTACHMENTS, store_values: true }];
  const result = rewind({
    issueFields: { attachment: [] },
    controlledFields: fields,
    changelogEntries: [entry(TRANSITION_AT + 100, [{ fieldId: 'attachment', from: null, to: '9' }])],
    transitionAt: TRANSITION_AT
  });
  assert.equal(result.fidelity, FIDELITY.PARTIAL);
  // Keep the current value when the earlier value is unknown.
  assert.deepEqual(result.rewoundFields, []);
});

test('an unreadable changelog means we cannot claim the read is the approved state', () => {
  const result = rewind({
    issueFields: { summary: 'whatever' },
    controlledFields: FIELDS,
    changelogEntries: [],
    transitionAt: TRANSITION_AT,
    changelogFailed: true
  });
  assert.equal(result.fidelity, FIDELITY.PARTIAL);
  assert.equal(result.reason, 'CHANGELOG_UNAVAILABLE');
});

test('a multi-value is rewound from the comma-separated changelog rendering', () => {
  const result = rewind({
    issueFields: { labels: ['urgent'] },
    controlledFields: FIELDS,
    changelogEntries: [
      entry(TRANSITION_AT + 100, [{ fieldId: 'labels', fromString: 'api, backend', toString: 'urgent' }])
    ],
    transitionAt: TRANSITION_AT
  });
  assert.deepEqual(result.fields.labels, ['api', 'backend']);
});

test('clearing a multi-value rewinds to an empty array, not to null', () => {
  const result = rewind({
    issueFields: { labels: ['x'] },
    controlledFields: FIELDS,
    changelogEntries: [entry(TRANSITION_AT + 100, [{ fieldId: 'labels', fromString: '', toString: 'x' }])],
    transitionAt: TRANSITION_AT
  });
  assert.deepEqual(result.fields.labels, []);
});

// ─── Grading ─────────────────────────────────────────────────────────────────

test('the worst grade wins: a baseline is only as good as its weakest field', () => {
  assert.equal(worstFidelity([FIDELITY.EXACT, FIDELITY.EXACT]), FIDELITY.EXACT);
  assert.equal(worstFidelity([FIDELITY.EXACT, FIDELITY.RECONSTRUCTED]), FIDELITY.RECONSTRUCTED);
  assert.equal(worstFidelity([FIDELITY.RECONSTRUCTED, FIDELITY.PARTIAL]), FIDELITY.PARTIAL);
});

test('textToAdf produces a well-formed document, one paragraph per line', () => {
  const doc = textToAdf('one\ntwo');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].content[0].text, 'one');
});

// ─── planCapture ─────────────────────────────────────────────────────────────

test('planCapture records writability per field, from editmeta', () => {
  // Precisely the set a future restore can put back. Knowing it now is what
  // lets the admin console warn "this field is read-only and could never be
  // restored" at configuration time rather than mid-rejection.
  const plan = planCapture({
    issueId: 1, issueKey: 'ABC-1', projectId: 10, issueTypeId: '1', version: 1,
    controlledFields: FIELDS,
    issueFields: { summary: 'a', description: null, priority: { id: '3' }, labels: [] },
    editmetaFields: { summary: {}, labels: {} },
    transitionAt: TRANSITION_AT, capturedAt: TRANSITION_AT + 10,
    actorId: 'u1', actorName: 'Ana'
  });

  assert.equal(plan.writable.summary, true);
  assert.equal(plan.writable.labels, true);
  assert.equal(plan.writable.description, false);
  assert.equal(plan.writable.priority, false);
});

test('planCapture retains values only for opted-in fields and keeps raw for restore', () => {
  const plan = planCapture({
    issueId: 1, issueKey: 'ABC-1', projectId: 10, issueTypeId: '1', version: 1,
    controlledFields: [
      { field_id: 'summary', field_kind: FIELD_KIND.TEXT, store_values: true },
      { field_id: 'labels', field_kind: FIELD_KIND.MULTI, store_values: false }
    ],
    issueFields: { summary: 'a', labels: ['z', 'a'] },
    editmetaFields: {},
    transitionAt: TRANSITION_AT, capturedAt: TRANSITION_AT,
    actorId: 'u1', actorName: 'Ana'
  });

  assert.deepEqual(Object.keys(plan.raw), ['summary']);
  // Both fields are still digested, so drift is still detected for labels.
  assert.equal(Object.keys(plan.digests).length, 2);
  assert.equal(plan.baseline.field_count, 2);
});

test('planCapture stamps the approver name at approval time, not by later lookup', () => {
  // A live lookup would silently rewrite history when somebody changes their
  // display name.
  const plan = planCapture({
    issueId: 1, issueKey: 'ABC-1', projectId: 10, issueTypeId: '1', version: 3,
    controlledFields: FIELDS,
    issueFields: {},
    editmetaFields: {},
    transitionAt: TRANSITION_AT, capturedAt: TRANSITION_AT,
    actorId: 'acc-1', actorName: 'Ana Rivera',
    fromStatusId: '10001', toStatusId: '10002', transitionId: '31'
  });

  assert.equal(plan.baseline.approved_by, 'acc-1');
  assert.equal(plan.baseline.approved_name, 'Ana Rivera');
  assert.equal(plan.baseline.version, 3);
  assert.equal(plan.baseline.state, 'ACTIVE');
  // transition_at, not captured_at: the drift epoch is the moment of the
  // transition, not the moment we got round to recording it.
  assert.equal(plan.baseline.transition_at, TRANSITION_AT);
});
