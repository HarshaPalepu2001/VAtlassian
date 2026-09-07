import test from 'node:test';
import assert from 'node:assert/strict';
import { planRestore, writeShape, canRestoreAnything } from '../src/lib/restore/planner.js';
// From ./outcome.js, not ./executor.js: the executor imports @forge/api, which
// does not resolve outside the Forge runtime. The pure rules live apart from
// the I/O precisely so a test can reach them.
import { digestOf, tally, OUTCOME, RESTORE_STATE } from '../src/lib/restore/outcome.js';
import { RESTORABLE } from '../src/lib/diff/fields.js';
import { project, FIELD_KIND } from '../src/lib/content.js';
import { encodeValue, decodeValue } from '../src/lib/valuestore.js';

// ─── Write shapes: one test per Jira field type a restore has to write ───────

const cases = [
  ['ADF is written verbatim', { type: 'doc' }, { type: 'doc', content: [] }, { type: 'doc', content: [] }],
  ['string', { type: 'string' }, 'hello', 'hello'],
  ['number', { type: 'number' }, 5, 5],
  ['date keeps only YYYY-MM-DD', { type: 'date' }, '2026-03-01T00:00:00.000Z', '2026-03-01'],
  ['user becomes { accountId }', { type: 'user' }, { accountId: 'abc' }, { accountId: 'abc' }],
  ['priority becomes { id }', { type: 'priority' }, { id: '1', name: 'Highest' }, { id: '1' }],
  ['option becomes { id }', { type: 'option' }, { id: '10' }, { id: '10' }],
  ['resolution becomes { id }', { type: 'resolution' }, { id: '3' }, { id: '3' }],
  ['security level becomes { id }', { type: 'securitylevel' }, { id: '7' }, { id: '7' }]
];

for (const [name, schema, input, expected] of cases) {
  test(`write shape: ${name}`, () => {
    const result = writeShape({
      field: { field_id: 'f', field_kind: FIELD_KIND.SCALAR },
      value: input,
      editmeta: { f: { schema } }
    });
    assert.deepEqual(result, expected);
  });
}

test('write shape: labels are bare strings, not { id } objects', () => {
  const result = writeShape({
    field: { field_id: 'labels', field_kind: FIELD_KIND.MULTI },
    value: ['a', 'b'],
    editmeta: { labels: { schema: { type: 'array', items: 'string' } } }
  });
  assert.deepEqual(result, ['a', 'b']);
});

test('write shape: entity-backed arrays become [{ id }]', () => {
  const result = writeShape({
    field: { field_id: 'components', field_kind: FIELD_KIND.MULTI },
    value: [{ id: '1', name: 'API' }, { id: '2', name: 'UI' }],
    editmeta: { components: { schema: { type: 'array', items: 'component' } } }
  });
  assert.deepEqual(result, [{ id: '1' }, { id: '2' }]);
});

test('write shape: multi-user arrays become [{ accountId }]', () => {
  const result = writeShape({
    field: { field_id: 'watchers', field_kind: FIELD_KIND.MULTI },
    value: [{ accountId: 'a' }],
    editmeta: { watchers: { schema: { type: 'array', items: 'user' } } }
  });
  assert.deepEqual(result, [{ accountId: 'a' }]);
});

test('write shape: clearing an array field sends [] and clearing a scalar sends null', () => {
  // Sending null to an array field is a 400, and this is exactly the sort of
  // thing that only shows up on a customer's most important rejection.
  assert.deepEqual(
    writeShape({ field: { field_id: 'labels', field_kind: FIELD_KIND.MULTI }, value: null, editmeta: { labels: { schema: { type: 'array', items: 'string' } } } }),
    []
  );
  assert.equal(
    writeShape({ field: { field_id: 'duedate', field_kind: FIELD_KIND.SCALAR }, value: null, editmeta: { duedate: { schema: { type: 'date' } } } }),
    null
  );
});

// ─── Planning ────────────────────────────────────────────────────────────────

function diffOf(fields) {
  return { issueId: 1, baselineId: Buffer.from('b'), baselineVersion: 1, fields };
}

test('the preflight names what cannot be restored, with a reason', () => {
  // The rule the whole reject dialog exists to enforce: no reviewer discovers
  // AFTER confirming that two fields were quietly left drifted.
  const plan = planRestore({
    diff: diffOf([
      {
        fieldId: 'summary', fieldName: 'Summary', semanticChange: true,
        restorable: RESTORABLE.YES, restorableReason: null
      },
      {
        fieldId: 'description', fieldName: 'Description', semanticChange: true,
        restorable: RESTORABLE.NOT_RETAINED, restorableReason: 'contents not retained'
      },
      {
        fieldId: 'attachment', fieldName: 'Attachment', semanticChange: true,
        restorable: RESTORABLE.NO, restorableReason: 'cannot be re-uploaded'
      }
    ]),
    baselineValues: { summary: 'approved title' },
    controlledFields: [
      { field_id: 'summary', field_kind: FIELD_KIND.TEXT },
      { field_id: 'description', field_kind: FIELD_KIND.ADF },
      { field_id: 'attachment', field_kind: FIELD_KIND.ATTACHMENTS }
    ],
    editmeta: { summary: { schema: { type: 'string' } } }
  });

  assert.deepEqual(plan.preflight.willRestore, ['Summary']);
  assert.equal(plan.preflight.cannotRestore.length, 2);
  assert.ok(plan.preflight.cannotRestore.every((c) => c.reason));
  assert.equal(canRestoreAnything(plan), true);
});

test('a formatting-only change is left alone by a restore', () => {
  // Reverting a bolded word is not what "restore the approved state" means to
  // anybody, and doing it would fill the item's history with uninvited edits.
  const plan = planRestore({
    diff: diffOf([{ fieldId: 'description', fieldName: 'Description', semanticChange: false, restorable: RESTORABLE.YES }]),
    baselineValues: { description: {} },
    controlledFields: [{ field_id: 'description', field_kind: FIELD_KIND.ADF }],
    editmeta: {}
  });
  assert.equal(plan.steps.length, 0);
  assert.equal(canRestoreAnything(plan), false);
});

test('a plan that can restore nothing is reported as such, so the button can be disabled', () => {
  const plan = planRestore({
    diff: diffOf([{ fieldId: 'description', fieldName: 'Description', semanticChange: true, restorable: RESTORABLE.NOT_RETAINED, restorableReason: 'not retained' }]),
    baselineValues: {},
    controlledFields: [{ field_id: 'description', field_kind: FIELD_KIND.ADF }],
    editmeta: {}
  });
  assert.equal(canRestoreAnything(plan), false);
  assert.match(plan.summary, /cannot be restored/);
});

test('the plan writes the RAW baseline value, not the normalised one', () => {
  // Normalisation sorts multi-values; writing the sorted form back would be a
  // silent second edit to a field we are supposed to be returning exactly.
  const plan = planRestore({
    diff: diffOf([{ fieldId: 'labels', fieldName: 'Labels', semanticChange: true, restorable: RESTORABLE.YES }]),
    baselineValues: { labels: ['zebra', 'apple'] },
    controlledFields: [{ field_id: 'labels', field_kind: FIELD_KIND.MULTI }],
    editmeta: { labels: { schema: { type: 'array', items: 'string' } } }
  });
  assert.deepEqual(plan.fieldWrites.labels, ['zebra', 'apple']);
});

// ─── The digest contract between restore and drift detection ─────────────────

test('THE SUPPRESSION CONTRACT: executor.digestOf matches content.js project()', () => {
  // If these two ever disagree, a restore is recorded as fresh drift and the
  // reviewer's own reversion lands back in their queue. A loop. This test is
  // the thing that keeps the two formulas in step.
  const field = { field_id: 'summary', field_kind: FIELD_KIND.TEXT };
  const value = 'the approved title';

  const fromExecutor = digestOf(field, value);
  const fromProjection = project({ summary: value }, [field]).digests.summary;

  assert.equal(fromExecutor, fromProjection);
});

test('the suppression contract holds for every field kind', () => {
  const samples = [
    [{ field_id: 'summary', field_kind: FIELD_KIND.TEXT }, 'text'],
    [{ field_id: 'description', field_kind: FIELD_KIND.ADF }, { type: 'doc', content: [] }],
    [{ field_id: 'labels', field_kind: FIELD_KIND.MULTI }, ['b', 'a']],
    [{ field_id: 'priority', field_kind: FIELD_KIND.SCALAR }, { id: '1' }],
    [{ field_id: 'attachment', field_kind: FIELD_KIND.ATTACHMENTS }, []],
    [{ field_id: 'issuelinks', field_kind: FIELD_KIND.LINKS }, []]
  ];

  for (const [field, value] of samples) {
    const projected = project({ [field.field_id]: value }, [field]).digests[field.field_id];
    assert.equal(digestOf(field, value), projected, `mismatch for ${field.field_kind}`);
  }
});

// ─── Tally: success has to be earned ─────────────────────────────────────────

test('a written-but-unverified field counts as FAILED, never as succeeded', () => {
  // The whole value of the verification pass is that "succeeded" means
  // something. There is deliberately no soft middle state.
  const { counters, state } = tally([
    { fieldId: 'a', outcome: OUTCOME.SUCCEEDED, verified: true },
    { fieldId: 'b', outcome: OUTCOME.SUCCEEDED, verified: false }
  ]);
  assert.equal(counters.succeeded, 1);
  assert.equal(counters.failed, 1);
  assert.equal(state, RESTORE_STATE.PARTIAL);
});

test('all verified is COMPLETE', () => {
  const { state } = tally([
    { fieldId: 'a', outcome: OUTCOME.SUCCEEDED, verified: true },
    { fieldId: 'b', outcome: OUTCOME.SUCCEEDED, verified: true }
  ]);
  assert.equal(state, RESTORE_STATE.COMPLETE);
});

test('nothing verified is FAILED, not PARTIAL', () => {
  const { state } = tally([{ fieldId: 'a', outcome: OUTCOME.FAILED, verified: false }]);
  assert.equal(state, RESTORE_STATE.FAILED);
});

test('an irreversible field makes an otherwise clean restore PARTIAL', () => {
  const { state, counters } = tally([
    { fieldId: 'a', outcome: OUTCOME.SUCCEEDED, verified: true },
    { fieldId: 'attachment', outcome: OUTCOME.IRREVERSIBLE, verified: false }
  ]);
  assert.equal(counters.irreversible, 1);
  assert.equal(state, RESTORE_STATE.PARTIAL);
});

// ─── The value codec ─────────────────────────────────────────────────────────

test('encode/decode round-trips every value shape without loss', () => {
  const samples = [
    null,
    'plain text',
    42,
    ['a', 'b'],
    { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
    { nested: { deeply: { value: [1, 2, 3] } } }
  ];
  for (const value of samples) {
    const { encoding, chunks } = encodeValue(value);
    const rows = chunks.map((data, seq) => ({ seq, encoding, data }));
    const { present, value: back } = decodeValue(rows);
    assert.equal(present, true);
    assert.deepEqual(back, value);
  }
});

test('a value larger than one chunk round-trips across rows', () => {
  const big = { text: 'x'.repeat(500_000) };
  const { encoding, chunks } = encodeValue(big);
  assert.ok(chunks.length >= 1);
  const rows = chunks.map((data, seq) => ({ seq, encoding, data }));
  assert.deepEqual(decodeValue(rows).value, big);
});

test('chunks reassemble correctly even when the rows arrive out of order', () => {
  // Guards against a missing ORDER BY producing corrupt JSON, which would
  // surface as "this baseline is unreadable" — a scary and misleading message.
  const big = { text: 'y'.repeat(500_000) };
  const { encoding, chunks } = encodeValue(big);
  const rows = chunks.map((data, seq) => ({ seq, encoding, data })).reverse();
  assert.deepEqual(decodeValue(rows).value, big);
});

test('no rows means "never retained", which is different from "empty"', () => {
  const { present, value } = decodeValue([]);
  assert.equal(present, false);
  assert.equal(value, null);
});

test('a tiny value is stored uncompressed rather than made bigger by gzip', () => {
  const { encoding } = encodeValue('a');
  assert.equal(encoding, 'PLAIN_B64');
});
