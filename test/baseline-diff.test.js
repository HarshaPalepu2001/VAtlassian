import test from 'node:test';
import assert from 'node:assert/strict';
import { diffText, isWhitespaceOnly, similarity, tokenise } from '../src/lib/diff/text.js';
import { diffAdf, flatten, BLOCK_OP } from '../src/lib/diff/adf.js';
import { diffField, RESTORABLE } from '../src/lib/diff/fields.js';
import { FIELD_KIND } from '../src/lib/content.js';

const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...paras) => ({ type: 'doc', version: 1, content: paras });

// ─── Word-level text diff ────────────────────────────────────────────────────

test('a one-word edit produces a one-word diff, not a whole-string replacement', () => {
  const ops = diffText('the quick brown fox', 'the quick red fox');
  const inserted = ops.filter((o) => o.op === 'insert').map((o) => o.text).join('');
  const deleted = ops.filter((o) => o.op === 'delete').map((o) => o.text).join('');
  assert.equal(inserted.trim(), 'red');
  assert.equal(deleted.trim(), 'brown');
});

test('diff ops reassemble to the original strings exactly', () => {
  // Whitespace is kept as its own token precisely so this holds. A diff that
  // silently normalised spacing would show phantom changes on untouched text.
  const before = 'alpha  beta\n\ngamma';
  const after = 'alpha beta\n\ndelta';
  const ops = diffText(before, after);
  const rebuiltBefore = ops.filter((o) => o.op !== 'insert').map((o) => o.text).join('');
  const rebuiltAfter = ops.filter((o) => o.op !== 'delete').map((o) => o.text).join('');
  assert.equal(rebuiltBefore, before);
  assert.equal(rebuiltAfter, after);
});

test('whitespace-only changes are recognisable as cosmetic', () => {
  assert.equal(isWhitespaceOnly('a b  c', 'a\nb c'), true);
  assert.equal(isWhitespaceOnly('a b c', 'a b d'), false);
});

test('similarity separates an edited sentence from an unrelated one', () => {
  const edited = similarity(
    'The service must return a 200 response within 300ms',
    'The service must return a 200 response within 500ms'
  );
  const unrelated = similarity(
    'The service must return a 200 response within 300ms',
    'Update the marketing copy on the pricing page'
  );
  assert.ok(edited > 0.5, `edited pair should pair, got ${edited}`);
  assert.ok(unrelated < 0.5, `unrelated pair should not pair, got ${unrelated}`);
});

test('an enormous input falls back to line granularity rather than hanging', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const changed = big.replace('line 4999', 'line 4999 changed');
  const started = Date.now();
  const ops = diffText(big, changed);
  assert.ok(Date.now() - started < 3000, 'fallback should be fast');
  assert.ok(ops.some((o) => o.op !== 'equal'));
});

// ─── ADF ─────────────────────────────────────────────────────────────────────

test('flatten produces one block per paragraph, not per wrapper', () => {
  const nested = doc({
    type: 'blockquote',
    content: [para('inner one'), para('inner two')]
  });
  const blocks = flatten(nested);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'inner one');
});

test('editing one paragraph of three leaves the other two as equal blocks', () => {
  const before = doc(para('First.'), para('Second, unchanged.'), para('Third.'));
  const after = doc(para('First, now edited.'), para('Second, unchanged.'), para('Third.'));
  const result = diffAdf(before, after);

  const modified = result.blocks.filter((b) => b.op === BLOCK_OP.MODIFIED);
  const equal = result.blocks.filter((b) => b.op === BLOCK_OP.EQUAL);
  assert.equal(modified.length, 1);
  assert.equal(equal.length, 2);
  assert.equal(result.semanticChange, true);
});

test('a moved paragraph is ONE op, not a delete plus an insert', () => {
  const before = doc(para('A'), para('B'), para('C'));
  const after = doc(para('C'), para('A'), para('B'));
  const result = diffAdf(before, after);

  const moves = result.blocks.filter((b) => b.op === BLOCK_OP.MOVE);
  assert.ok(moves.length >= 1, 'expected at least one move');
  // The point: no block is reported as both deleted and inserted.
  const deleted = result.blocks.filter((b) => b.op === BLOCK_OP.DELETE).map((b) => b.before.text);
  const inserted = result.blocks.filter((b) => b.op === BLOCK_OP.INSERT).map((b) => b.after.text);
  assert.equal(deleted.filter((t) => inserted.includes(t)).length, 0);
});

test('bolding a word is a markOnly change and is NOT a semantic change', () => {
  // The single most important cosmetic case. Without this, every formatting
  // tweak pages a reviewer and the app gets muted.
  const before = doc(para('Ship the thing'));
  const after = doc({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Ship the thing', marks: [{ type: 'strong' }] }
    ]
  });
  const result = diffAdf(before, after);
  assert.ok(result.blocks.some((b) => b.op === BLOCK_OP.MARK_ONLY));
  assert.equal(result.semanticChange, false);
});

test('re-wrapping whitespace is not a semantic change', () => {
  const before = doc(para('one two three'));
  const after = doc(para('one  two\tthree'));
  assert.equal(diffAdf(before, after).semanticChange, false);
});

test('adding a paragraph is a semantic change', () => {
  const result = diffAdf(doc(para('one')), doc(para('one'), para('two')));
  assert.equal(result.semanticChange, true);
  assert.ok(result.blocks.some((b) => b.op === BLOCK_OP.INSERT));
});

test('an unknown ADF node type still contributes its text rather than vanishing', () => {
  const future = doc({ type: 'someFutureNode', content: [{ type: 'text', text: 'still visible' }] });
  const blocks = flatten(future);
  assert.ok(JSON.stringify(blocks).includes('still visible'));
});

// ─── Field-level ─────────────────────────────────────────────────────────────

test('a field with no retained value reports honestly and is not restorable', () => {
  // "changed (contents not retained)" is the truthful consequence of per-field
  // retention. Rendering it as an empty diff would read as "nothing really
  // changed", which is a different and false claim.
  const result = diffField({
    field: { field_id: 'description', field_name: 'Description', field_kind: FIELD_KIND.ADF, store_values: false },
    before: undefined,
    after: doc(para('new text')),
    retained: false
  });

  assert.equal(result.changed, true);
  assert.equal(result.retained, false);
  assert.equal(result.restorable, RESTORABLE.NOT_RETAINED);
  assert.match(result.summary, /not retained/);
  assert.equal(result.before, null);
});

test('a read-only field is marked unrestorable at diff time, not at rejection time', () => {
  const result = diffField({
    field: {
      field_id: 'customfield_1', field_name: 'Computed', field_kind: FIELD_KIND.TEXT,
      store_values: true, writable: false
    },
    before: 'a',
    after: 'b',
    retained: true
  });
  assert.equal(result.restorable, RESTORABLE.NO);
  assert.match(result.restorableReason, /does not allow this field to be edited/);
});

test('deleted attachments are named as irreversible', () => {
  const result = diffField({
    field: { field_id: 'attachment', field_name: 'Attachment', field_kind: FIELD_KIND.ATTACHMENTS, store_values: true },
    before: [{ id: '1', filename: 'spec.pdf' }],
    after: [],
    retained: true
  });
  assert.equal(result.restorable, RESTORABLE.NO);
  assert.match(result.restorableReason, /cannot be re-uploaded/);
});

test('an attachment swapped for different bytes under the same name is detected', () => {
  const result = diffField({
    field: { field_id: 'attachment', field_name: 'Attachment', field_kind: FIELD_KIND.ATTACHMENTS, store_values: true },
    before: [{ id: '1', filename: 'spec.pdf', contentHash: 'aaa' }],
    after: [{ id: '1', filename: 'spec.pdf', contentHash: 'bbb' }],
    retained: true
  });
  assert.equal(result.changed, true);
  assert.equal(result.replaced.length, 1);
});

test('labels diff as a set, reported as added and removed', () => {
  const result = diffField({
    field: { field_id: 'labels', field_name: 'Labels', field_kind: FIELD_KIND.MULTI, store_values: true },
    before: ['api', 'backend'],
    after: ['api', 'urgent'],
    retained: true
  });
  assert.deepEqual(result.added, ['urgent']);
  assert.deepEqual(result.removed, ['backend']);
});

test('an unrecognised custom field still reports that it changed', () => {
  const result = diffField({
    field: { field_id: 'customfield_99', field_name: 'Mystery', field_kind: 'SOMETHING_NEW', store_values: true },
    before: { a: 1 },
    after: { a: 2 },
    retained: true
  });
  assert.equal(result.changed, true);
  assert.equal(result.kind, 'unknown');
});

const { diffIssue, evidenceHash } = await import('../src/lib/diff/index.js');
const evidenceFixture = (currentFields, changes = {}) => ({
  baseline: { baseline_id: Buffer.from('baseline'), version: 1, transition_at: 100 },
  baselineValues: { summary: 'Approved', labels: ['a'] },
  currentFields,
  controlledFields: [
    { field_id: 'summary', field_name: 'Summary', field_kind: FIELD_KIND.TEXT, store_values: true },
    { field_id: 'labels', field_name: 'Labels', field_kind: FIELD_KIND.MULTI, store_values: true }
  ], driftRows: [], ...changes
});
test('review evidence binds live values before collector events arrive', () => {
  const first = diffIssue(evidenceFixture({ summary: 'First edit', labels: ['a'] }));
  const next = diffIssue(evidenceFixture({ summary: 'Second edit', labels: ['a'] }));
  assert.notEqual(first.evidenceHash, next.evidenceHash);
});
test('review evidence normalization ignores multi-value and field ordering', () => {
  const args = evidenceFixture({ summary: 'Edit', labels: ['a', 'b'] });
  const first = diffIssue(args);
  const next = diffIssue({ ...args, currentFields: { summary: 'Edit', labels: ['b', 'a'] }, controlledFields: [...args.controlledFields].reverse() });
  assert.equal(first.evidenceHash, next.evidenceHash);
});
test('non-retained values bind evidence without being exposed in the diff', () => {
  const options = { controlledFields: [{ field_id: 'secret', field_kind: FIELD_KIND.TEXT, store_values: false }] };
  const first = diffIssue(evidenceFixture({ secret: 'one' }, options));
  const next = diffIssue(evidenceFixture({ secret: 'two' }, options));
  assert.notEqual(first.evidenceHash, next.evidenceHash);
  assert.equal(first.fields[0].after, null);
});
test('collector attribution remains visible when Jira history is unavailable', () => {
  const result = diffIssue(evidenceFixture({ summary: 'Edited', labels: ['a'] }, { driftRows: [
    { key: 'event-1', field_id: 'summary', actor_name: 'Priya', actor_account_id: 'p', occurred_at: 200, source: 'USER', detected_via: 'EVENT' }
  ] }));
  assert.equal(result.fields[0].attribution[0]?.authorName, 'Priya');
  assert.equal(result.fields[0].attribution[0]?.at, 200);
});
test('reconcile collection attribution is marked as detected', () => {
  const result = diffIssue(evidenceFixture({ summary: 'Edited', labels: ['a'] }, { driftRows: [
    { key: 'reconcile-1', field_id: 'summary', occurred_at: 200, source: 'SYSTEM', detected_via: 'RECONCILE' }
  ] }));
  assert.equal(result.fields[0].attribution[0]?.detected, true);
});
test('subtask drift carries work item labels instead of bare Jira ids', () => {
  const result = diffIssue({
    baseline: { baseline_id: Buffer.from('baseline'), version: 1, transition_at: 100, field_digests: { subtasks: 'old' } },
    baselineValues: { subtasks: [] },
    currentFields: { subtasks: [{ id: '66385', key: 'VJIRA-8', fields: { summary: 'Understand the drift' } }] },
    controlledFields: [
      { field_id: 'subtasks', field_name: 'Subtasks', field_kind: FIELD_KIND.MULTI, store_values: true }
    ],
    driftRows: []
  });

  assert.equal(result.fields[0].added[0], '66385');
  assert.equal(result.fields[0].valueLabels['66385'], 'VJIRA-8 - Understand the drift');
});
test('legacy evidenceHash callers still have stable sorted event identity', () => {
  assert.equal(evidenceHash({version: 1}, [{key:'b'}, {key:'a'}]), evidenceHash({version:1}, [{key:'a'}, {key:'b'}]));
});

test('issuelinks drift carries link type and linked issue summary labels instead of bare ids', () => {
  const result = diffIssue({
    baseline: { baseline_id: Buffer.from('baseline'), version: 1, transition_at: 100, field_digests: { issuelinks: 'old' } },
    baselineValues: { issuelinks: [] },
    currentFields: {
      issuelinks: [
        {
          id: '1000',
          type: { id: '10001', name: 'Blocks' },
          inwardIssue: { id: '66382', key: 'VJIRA-8', fields: { summary: 'Security audit logging' } }
        }
      ]
    },
    controlledFields: [
      { field_id: 'issuelinks', field_name: 'Linked Issues', field_kind: FIELD_KIND.LINKS, store_values: true }
    ],
    driftRows: []
  });

  assert.equal(result.fields[0].valueLabels['10001'], 'Blocks');
  assert.equal(result.fields[0].valueLabels['66382'], 'VJIRA-8 - Security audit logging');
});
