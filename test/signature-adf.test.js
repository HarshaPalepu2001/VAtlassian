import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText } from '../src/lib/adf.js';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t) => ({ type: 'text', text: t });

test('empty and absent documents are reported as empty, not as blank text', () => {
  for (const input of [null, undefined, doc(), doc(para()), '   ']) {
    const result = adfToText(input);
    assert.equal(result.empty, true, `expected empty for ${JSON.stringify(input)}`);
    assert.equal(result.text, '');
  }
});

test('paragraphs are separated, not run together', () => {
  const result = adfToText(doc(para(text('First line.')), para(text('Second line.'))));
  assert.equal(result.text, 'First line.\nSecond line.');
  assert.equal(result.empty, false);
});

test('marks and nested formatting keep their text', () => {
  const bold = { type: 'text', text: 'urgent', marks: [{ type: 'strong' }] };
  const result = adfToText(doc(para(text('This is '), bold, text('.'))));
  assert.equal(result.text, 'This is urgent.');
});

test('lists keep one item per line', () => {
  const item = (t) => ({ type: 'listItem', content: [para(text(t))] });
  const result = adfToText(doc({ type: 'bulletList', content: [item('one'), item('two')] }));
  assert.equal(result.text, 'one\ntwo');
});

test('mentions render as their display text, not as an account id', () => {
  const mention = { type: 'mention', attrs: { id: '557058:abc', text: '@Priya' } };
  const result = adfToText(doc(para(text('cc '), mention)));
  assert.equal(result.text, 'cc @Priya');
});

test('attachments are announced rather than silently dropped', () => {
  const media = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x', type: 'file' } }] };
  const result = adfToText(doc(para(text('See below.')), media));
  assert.match(result.text, /\[attachment\]/);
});

test('an unknown node type degrades to its children instead of disappearing', () => {
  // The signer seeing LESS than the record contains is the failure that
  // matters, so a node type that did not exist when adf.js was written must
  // still surrender its text.
  const future = { type: 'someNodeInventedLater', content: [para(text('still readable'))] };
  const result = adfToText(doc(future));
  assert.equal(result.text, 'still readable');
});

test('hard breaks become newlines', () => {
  const result = adfToText(doc(para(text('a'), { type: 'hardBreak' }, text('b'))));
  assert.equal(result.text, 'a\nb');
});

test('long text is truncated, flagged, and cut on a word boundary', () => {
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel '.repeat(40);
  const result = adfToText(doc(para(text(words))), { maxLength: 100 });
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 101, `expected <=101 chars, got ${result.text.length}`);
  assert.ok(result.text.endsWith('…'));
  // Word boundary: the character before the ellipsis is not mid-word unless
  // the word itself was longer than the slack window.
  assert.ok(!/\s…$/.test(result.text), 'should not leave a dangling space before the ellipsis');
});

test('text exactly at the limit is not truncated', () => {
  const exact = 'x'.repeat(100);
  const result = adfToText(doc(para(text(exact))), { maxLength: 100 });
  assert.equal(result.truncated, false);
  assert.equal(result.text, exact);
});

test('a plain string description (legacy / imported data) is handled', () => {
  const result = adfToText('Just a string.');
  assert.equal(result.text, 'Just a string.');
  assert.equal(result.empty, false);
});

test('empty paragraphs do not become blank lines', () => {
  // Vertical space is scarce in a transition dialog: two blank paragraphs in
  // the description must not push the code box below the fold.
  const result = adfToText(doc(para(text('a')), para(), para(), para(text('b'))));
  assert.equal(result.text, 'a\nb');
});

test('nested blocks contribute one break, not one per level', () => {
  const quoted = { type: 'blockquote', content: [para(text('quoted'))] };
  const result = adfToText(doc(quoted, para(text('after'))));
  assert.equal(result.text, 'quoted\nafter');
});
