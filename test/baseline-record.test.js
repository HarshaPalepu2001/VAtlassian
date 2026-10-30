import test from 'node:test';
import assert from 'node:assert/strict';

import { adfText, previewOf, buildRecord } from '../src/lib/record.js';
import { FIELD_KIND } from '../src/lib/content.js';

/**
 * The baseline record remains visible when there is no drift to decide.
 *
 * The panel previously showed only "All good. Unchanged since it was
 * approved by X." Reviewers could not see which fields that statement
 * covered.
 *
 * These tests require the record to list every tracked field, including
 * fields whose values were not retained. An absent value must never appear
 * as an empty value.
 */

const FIELDS = [
  { field_id: 'summary', field_name: 'Summary', field_kind: FIELD_KIND.TEXT, store_values: true, materiality: 'MAJOR' },
  { field_id: 'description', field_name: 'Description', field_kind: FIELD_KIND.ADF, store_values: true, materiality: 'CRITICAL' },
  { field_id: 'customfield_1', field_name: 'Approver', field_kind: FIELD_KIND.SCALAR, store_values: false, materiality: 'CRITICAL' }
];

const BASELINE = {
  version: 3,
  approved_by: '557058:abc',
  approved_name: 'A reviewer',
  transition_at: 1_700_000_000_000,
  captured_at: 1_700_000_005_000,
  fidelity: 'EXACT',
  content_hash: 'f'.repeat(64),
  from_status_id: '10001',
  to_status_id: '10002',
  transition_id: '31'
};

// ── ADF flattening ───────────────────────────────────────────────────────────

test('adfText pulls readable text out of a document', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'The first line.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'The second line.' }] }
    ]
  };
  const text = adfText(doc);
  assert.match(text, /The first line\./);
  assert.match(text, /The second line\./);
});

test('adfText keeps blocks on separate lines rather than running them together', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }
    ]
  };
  // "OneTwo" would read as a single word and misrepresent the content.
  assert.doesNotMatch(adfText(doc), /OneTwo/);
});

test('adfText survives the shapes ADF actually contains', () => {
  assert.equal(adfText(null), '');
  assert.equal(adfText(undefined), '');
  assert.equal(adfText({ type: 'doc' }), '');
  assert.equal(adfText({ type: 'hardBreak' }), '');
  assert.equal(adfText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b');
});

// ── Previews ─────────────────────────────────────────────────────────────────

test('an absent value is empty, not an empty string', () => {
  // These are different facts. A field approved with no value is worth showing;
  // a preview that failed to render is a bug. Collapsing them means the panel
  // cannot tell the reviewer which one they are looking at.
  const preview = previewOf(FIELD_KIND.TEXT, null);
  assert.equal(preview.empty, true);
  assert.equal(preview.text, null);
});

test('whitespace-only content counts as empty', () => {
  assert.equal(previewOf(FIELD_KIND.TEXT, '   \n  ').empty, true);
  assert.equal(previewOf(FIELD_KIND.ADF, { type: 'doc', content: [] }).empty, true);
});

test('a long value is clipped and says so', () => {
  const preview = previewOf(FIELD_KIND.TEXT, 'word '.repeat(200));
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.length < 300, 'a preview that is not shorter than the value is not a preview');
});

test('a short value is not marked truncated', () => {
  const preview = previewOf(FIELD_KIND.TEXT, 'Short enough.');
  assert.equal(preview.truncated, false);
  assert.equal(preview.text, 'Short enough.');
});

test('a clipped preview does not end mid-word when a boundary is near', () => {
  const preview = previewOf(FIELD_KIND.TEXT, `${'a'.repeat(200)} ${'b'.repeat(200)}`);
  assert.equal(preview.truncated, true);
  assert.doesNotMatch(preview.text, /\s$/, 'no trailing space before the ellipsis the UI adds');
});

test('multi-valued fields report what was not shown instead of dropping it', () => {
  const values = Array.from({ length: 12 }, (_, i) => `label-${i}`);
  const preview = previewOf(FIELD_KIND.MULTI, values);
  assert.equal(preview.truncated, true);
  assert.equal(preview.more, 4, 'the count of hidden members has to be available or the list looks complete');
  assert.equal(preview.items.length, 12, 'the full set is still carried for anyone who wants it');
});

test('attachments preview by filename, not by opaque id', () => {
  const preview = previewOf(FIELD_KIND.ATTACHMENTS, [
    { id: '10001', filename: 'contract.pdf' },
    { id: '10002', filename: 'appendix.docx' }
  ]);
  assert.match(preview.text, /contract\.pdf/);
  assert.match(preview.text, /appendix\.docx/);
});

test('links are counted rather than named, because their ids are not readable', () => {
  // normaliseLinks stores immutable numeric ids because issue keys change
  // when an item moves project. The numeric id alone does not identify the issue to a reviewer.
  const preview = previewOf(FIELD_KIND.LINKS, [{ type: '10000', outward: '10432' }]);
  assert.equal(preview.text, '1 linked work item');
  assert.doesNotMatch(preview.text, /10432/);
});

test('an empty collection is empty, not "0 items"', () => {
  assert.equal(previewOf(FIELD_KIND.MULTI, []).empty, true);
  assert.equal(previewOf(FIELD_KIND.ATTACHMENTS, []).empty, true);
  assert.equal(previewOf(FIELD_KIND.LINKS, []).empty, true);
});

// ── The record ───────────────────────────────────────────────────────────────

test('every tracked field appears, retained or not', () => {
  const record = buildRecord({
    baseline: BASELINE,
    controlledFields: FIELDS,
    baselineValues: { summary: 'A title', description: { type: 'doc', content: [] } },
    digests: { summary: 'a'.repeat(64), description: 'b'.repeat(64), customfield_1: 'c'.repeat(64) }
  });

  assert.equal(record.fieldCount, 3);
  assert.equal(record.retainedCount, 2);
  // The unretained field remains tracked because its digest detects a change.
  // Omitting it would understate the tracked field set.
  assert.ok(record.fields.some((f) => f.fieldId === 'customfield_1'));
});

test('a field with no retained contents carries a digest and no preview', () => {
  const record = buildRecord({
    baseline: BASELINE,
    controlledFields: FIELDS,
    baselineValues: {},
    digests: { customfield_1: 'c'.repeat(64) }
  });

  const field = record.fields.find((f) => f.fieldId === 'customfield_1');
  assert.equal(field.retained, false);
  assert.equal(field.preview, null, 'there is no value to preview, and inventing one would be a lie');
  assert.equal(field.digest, 'c'.repeat(64), 'the digest is what makes the claim verifiable');
});

test('the assurance of the approving signature is carried, not flattened to a tick', () => {
  const record = buildRecord({
    baseline: BASELINE,
    controlledFields: FIELDS,
    approval: { assurance_level: 'ESIGNATURE', signed_at: 1_700_000_000_000 }
  });
  assert.equal(record.assurance, 'ESIGNATURE');
});

test('a baseline with no signature reports no assurance rather than claiming one', () => {
  const record = buildRecord({ baseline: BASELINE, controlledFields: FIELDS });
  assert.equal(record.assurance, null);
  assert.equal(record.signedAt, null);
});

test('fields come back in a stable, human order', () => {
  const record = buildRecord({ baseline: BASELINE, controlledFields: FIELDS });
  const names = record.fields.map((f) => f.fieldName);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('no baseline means no record, not an empty one', () => {
  // An empty record would render as "0 tracked fields", which is a statement
  // about a baseline that does not exist.
  assert.equal(buildRecord({ baseline: null, controlledFields: FIELDS }), null);
  assert.equal(buildRecord({}), null);
});

test('provenance survives intact', () => {
  const record = buildRecord({ baseline: BASELINE, controlledFields: [] });
  assert.equal(record.version, 3);
  assert.equal(record.approvedName, 'A reviewer');
  assert.equal(record.fidelity, 'EXACT');
  assert.equal(record.contentHash, 'f'.repeat(64));
  assert.equal(record.approvedAt, 1_700_000_000_000);
});
