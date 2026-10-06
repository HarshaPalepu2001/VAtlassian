import test from 'node:test';
import assert from 'node:assert/strict';
import { project, changedFields, normaliseAdf, FIELD_KIND } from '../src/lib/content.js';
import { canonical, sha256Hex } from '../src/lib/hash.js';

const DESCRIPTION = [{ field_id: 'description', field_kind: FIELD_KIND.ADF, store_values: false }];
const EMPTY_DOC = { type: 'doc', version: 1, content: [] };
const WITH_TEXT = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

const digestOf = (value) => project({ description: value }, DESCRIPTION).digests.description;

// Jira hands back an empty document, not null, for a rich-text field that was
// once set and then cleared. Nobody typed anything either way, so the two must
// hash the same. Found on VAT-42: a reject restored the description to "nothing",
// Jira read it back as an empty document, and the restore stayed "partly
// restored" with a Critical change on a field with no content.

test('a rich-text field with no content hashes the same as one that was never set', () => {
  assert.equal(digestOf(EMPTY_DOC), digestOf(null));
  assert.equal(digestOf(EMPTY_DOC), digestOf(undefined));
});

test('a rich-text field with text still differs from an empty one', () => {
  assert.notEqual(digestOf(WITH_TEXT), digestOf(null));
  assert.notEqual(digestOf(WITH_TEXT), digestOf(EMPTY_DOC));
});

test('a baseline stored before this rule, from an empty document, is not drift against a never-set field', () => {
  // The digest the old rule produced for an empty document, rebuilt by hand.
  const legacy = sha256Hex(canonical({ f: 'description', k: FIELD_KIND.ADF, v: normaliseAdf(EMPTY_DOC) }));
  assert.notEqual(legacy, digestOf(null), 'precondition: this is a digest the new rule no longer produces');

  assert.deepEqual(changedFields({ description: legacy }, { description: digestOf(null) }, ['description']), []);
  assert.deepEqual(changedFields({ description: digestOf(null) }, { description: legacy }, ['description']), []);
});

test('real content added to a never-set field is still drift', () => {
  assert.deepEqual(changedFields({ description: digestOf(null) }, { description: digestOf(WITH_TEXT) }, ['description']), ['description']);
});
