import test from 'node:test';
import assert from 'node:assert/strict';
import { diffAdf, flatten, BLOCK_OP } from '../src/lib/diff/adf.js';
import { diffField } from '../src/lib/diff/fields.js';
import { FIELD_KIND, normaliseAdf } from '../src/lib/content.js';
import { canonical } from '../src/lib/hash.js';

// The diff has to understand every byte the hash does. content.js hashes the
// whole normalised document — attrs, containers, mark attributes — so a change
// there is drift. Until this suite, the differ compared only a block's type,
// text and mark names, and every one of the edits below was either invisible
// (reported as EQUAL) or shown with nothing to say what had changed.

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (t) => ({ type: 'paragraph', content: [text(t)] });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const task = (t, state = 'TODO', localId = 'x') => ({
  type: 'taskItem', attrs: { localId, state }, content: [text(t)]
});
const taskList = (...items) => ({ type: 'taskList', attrs: { localId: 'list' }, content: items });
const panel = (panelType, ...content) => ({ type: 'panel', attrs: { panelType }, content });

const changedBlocks = (result) => result.blocks.filter((b) => b.op !== BLOCK_OP.EQUAL);
const notes = (result) => changedBlocks(result).flatMap((b) => (b.structureChange ?? []).map((c) => c.text));

// ─── The two edits found live on VAT-14 and VAT-10 ──────────────────────────

test('a checklist item turned into a plain statement is shown as exactly that', () => {
  const before = doc(taskList(task('Report job deployed'), task('Runs for 5 consecutive days without failure')));
  const after = doc(taskList(task('Report job deployed')), para('Runs for 5 consecutive days without failure'));
  const result = diffAdf(before, after);

  const [block] = changedBlocks(result);
  assert.equal(changedBlocks(result).length, 1);
  assert.equal(block.op, BLOCK_OP.STRUCTURE);
  const said = notes(result).join(' | ');
  assert.match(said, /Checklist item/);
  assert.match(said, /Paragraph/);
  assert.equal(result.semanticChange, true, 'a criterion that stopped being a checkbox is not cosmetic');
});

test('a warning panel turned into an info panel is detected, named, and material', () => {
  const before = doc(panel('warning', para('Regulated scope: re-review required.')));
  const after = doc(panel('info', para('Regulated scope: re-review required.')));
  const result = diffAdf(before, after);

  assert.equal(changedBlocks(result).length, 1, 'the panel paragraph must not compare as equal');
  assert.match(notes(result).join(' | '), /warning.*info/);
  assert.equal(result.semanticChange, true);

  const field = diffField({
    field: { field_id: 'description', field_kind: FIELD_KIND.ADF, field_name: 'Description', store_values: true },
    before: normaliseAdf(before), after: normaliseAdf(after), retained: true
  });
  assert.equal(field.changed, true, 'a restore skips fields reported unchanged');
  assert.equal(field.semanticChange, true, 'semanticChange:false demotes the drift to COSMETIC');
});

// ─── The rest of what attrs and containers carry ────────────────────────────

test('ticking a checklist item is a change', () => {
  const result = diffAdf(doc(taskList(task('Ship it', 'TODO'))), doc(taskList(task('Ship it', 'DONE'))));
  assert.equal(changedBlocks(result).length, 1);
  assert.match(notes(result).join(' | '), /ticked/i);
  assert.equal(result.semanticChange, true);
});

test('a bulleted list renumbered as an ordered list is a change', () => {
  const item = (t) => ({ type: 'listItem', content: [para(t)] });
  const before = doc({ type: 'bulletList', content: [item('one'), item('two')] });
  const after = doc({ type: 'orderedList', attrs: { order: 1 }, content: [item('one'), item('two')] });
  const result = diffAdf(before, after);
  assert.equal(changedBlocks(result).length, 2);
  assert.match(notes(result).join(' | '), /Bulleted list.*Numbered list/);
});

test('a heading level change is a change', () => {
  const h = (level) => ({ type: 'heading', attrs: { level }, content: [text('Scope')] });
  const result = diffAdf(doc(h(2)), doc(h(3)));
  assert.equal(changedBlocks(result).length, 1);
  assert.match(notes(result).join(' | '), /level.*2.*3/i);
});

test('a code block language change is a change', () => {
  const code = (language) => ({ type: 'codeBlock', attrs: { language }, content: [text('a: 1')] });
  const result = diffAdf(doc(code('yaml')), doc(code('json')));
  assert.match(notes(result).join(' | '), /yaml.*json/);
});

test('a status lozenge or a date changing is visible even though no text node moved', () => {
  const status = (t, color) => doc({ type: 'paragraph', content: [text('State: '),
    { type: 'status', attrs: { text: t, color, localId: 's' } }] });
  const statusResult = diffAdf(status('ON TRACK', 'green'), status('ON TRACK', 'red'));
  assert.equal(changedBlocks(statusResult).length, 1);
  assert.match(notes(statusResult).join(' | '), /green.*red/);

  const date = (ts) => doc({ type: 'paragraph', content: [text('Due '), { type: 'date', attrs: { timestamp: ts } }] });
  const dateResult = diffAdf(date('1790000000000'), date('1795000000000'));
  assert.equal(changedBlocks(dateResult).length, 1);
  assert.ok(flatten(date('1790000000000'))[0].text.includes('2026'), 'a date renders as a date, not as nothing');
});

test('text colour is a formatting change: visible, but not semantic', () => {
  const coloured = (color) => doc({ type: 'paragraph', content: [text('Hot', [{ type: 'textColor', attrs: { color } }])] });
  const result = diffAdf(coloured('#ff5630'), coloured('#36b37e'));
  const [block] = changedBlocks(result);
  assert.equal(block.op, BLOCK_OP.MARK_ONLY);
  assert.notDeepEqual(block.markChange.from, block.markChange.to);
  assert.equal(result.semanticChange, false);
});

test('bold is still cosmetic, and localId churn is still no change at all', () => {
  const bold = diffAdf(doc(para('Ship')), doc({ type: 'paragraph', content: [text('Ship', [{ type: 'strong' }])] }));
  assert.equal(bold.semanticChange, false);

  const churn = diffAdf(doc(taskList(task('Ship', 'TODO', 'aaa'))), doc(taskList(task('Ship', 'TODO', 'bbb'))));
  assert.equal(changedBlocks(churn).length, 0);
});

// ─── The invariant ──────────────────────────────────────────────────────────

test('whenever the hashed bytes differ, the diff reports a change — never "equal"', () => {
  const base = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Goal')] },
    panel('warning', para('Careful.')),
    taskList(task('One'), task('Two')),
    { type: 'rule' },
    { type: 'bulletList', content: [{ type: 'listItem', content: [para('b')] }] },
    { type: 'expand', attrs: { title: 'More' }, content: [para('hidden')] }
  );
  const mutations = [
    (d) => { d.content[0].attrs.level = 3; },
    (d) => { d.content[1].attrs.panelType = 'note'; },
    (d) => { d.content[2].content[1].attrs.state = 'DONE'; },
    (d) => { d.content[3] = { type: 'rule', attrs: { width: 50 } }; },
    (d) => { d.content[4].type = 'orderedList'; },
    (d) => { d.content[5].attrs.title = 'Less'; },
    (d) => { d.content[0].marks = [{ type: 'alignment', attrs: { align: 'center' } }]; },
    (d) => { d.content.splice(3, 1); }
  ];
  for (const [i, mutate] of mutations.entries()) {
    const after = structuredClone(base);
    mutate(after);
    assert.notEqual(canonical(normaliseAdf(base)), canonical(normaliseAdf(after)), `mutation ${i} is a real change`);
    const result = diffAdf(base, after);
    assert.ok(changedBlocks(result).length > 0, `mutation ${i} was reported as no change`);
  }
  assert.equal(changedBlocks(diffAdf(base, structuredClone(base))).length, 0);
});

test('media blocks resolve media UUIDs to filenames when mediaMap is provided', () => {
  const mediaDoc = doc({
    type: 'mediaSingle',
    content: [{ type: 'media', attrs: { id: '369ed59c-f385-4a4a-b1d9-535cfd9b4575', type: 'file' } }]
  });
  const emptyDoc = doc(para('No media'));

  // Without mediaMap: fallback to UUID
  const unmappedBlocks = flatten(mediaDoc);
  assert.equal(unmappedBlocks[0].text, '[attachment 369ed59c-f385-4a4a-b1d9-535cfd9b4575]');

  // With mediaMap: resolves to filename
  const mediaMap = new Map([['369ed59c-f385-4a4a-b1d9-535cfd9b4575', 'Salesforce CDC POC.png']]);
  const mappedBlocks = flatten(mediaDoc, { mediaMap });
  assert.equal(mappedBlocks[0].text, '[attachment: Salesforce CDC POC.png]');

  // In diffField:
  const field = { field_id: 'description', field_name: 'Description', field_kind: FIELD_KIND.ADF, store_values: true };
  const diff = diffField({ field, before: mediaDoc, after: emptyDoc, retained: true, mediaMap });
  assert.equal(diff.blocks[0].before.text, '[attachment: Salesforce CDC POC.png]');
});
