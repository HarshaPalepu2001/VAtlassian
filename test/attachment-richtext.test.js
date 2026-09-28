import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseItems, rewriteAdfMedia, adfMediaIds } from '../src/lib/attachmentIdentity.js';
import { pointAtLiveFiles, explainRichTextRefusal } from '../src/lib/restore/attachments.js';
import { mediaIdFromLocation } from '../src/lib/mediaIdentity.js';
import { explainRefusals } from '../src/lib/tree/restoreVerifier.js';
import { project } from '../src/lib/content.js';

// VAT-3 as Jira returned it on 2026-09-24: the description points at 12085
// only by media id, with no Jira id and no file name.
const doc = mediaId => ({ type: 'doc', version: 1, content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Explore more ways to put agents to work.' }] },
  { type: 'mediaSingle', attrs: { layout: 'center', width: 738 }, content: [
    { type: 'media', attrs: { type: 'file', id: mediaId, collection: '', localId: '6140b94269ae', width: 738, height: 624 } }] }
] });
const ORIGINAL = '5786f451-ef72-45c6-b665-ed9ac2400db3';
const COPY = '9a1c0000-0000-4000-8000-000000000001';
const DESCRIPTION = [{ field_id: 'description', field_kind: 'ADF', store_values: true }];

test('the media id comes from the download redirect, exactly as probed live', () => {
  assert.equal(mediaIdFromLocation(`https://api.media.atlassian.com/file/${ORIGINAL}/binary?token=x&dl=true`), ORIGINAL);
  assert.equal(mediaIdFromLocation(null), null);
  assert.equal(mediaIdFromLocation('https://example.com/elsewhere'), null);
});

test('a restored copy\'s pointer reads as the original: the approved description matches byte for byte', async () => {
  const issue = { id: '43903', fields: { description: doc(COPY), attachment: [{ id: '12090', filename: 'shot.png', size: 1 }] } };
  await canonicaliseItems([issue], { read: async () => new Map([[43903, {
    files: new Map([['12090', '12085']]), media: new Map([[COPY, ORIGINAL]]) }]]) });
  assert.deepEqual(issue.fields.description, doc(ORIGINAL));
  assert.equal(project(issue.fields, DESCRIPTION).digests.description, project({ description: doc(ORIGINAL) }, DESCRIPTION).digests.description);
});

test('the approved description is written pointing at the copy, and nothing else in it changes', () => {
  const written = pointAtLiveFiles({ description: doc(ORIGINAL), summary: 'kept' }, { media: new Map([[COPY, ORIGINAL]]) });
  assert.deepEqual(written.description, doc(COPY));
  assert.equal(written.summary, 'kept');
});

test('where the original file survived, the description goes back untouched: byte for byte', () => {
  const approved = { description: doc(ORIGINAL) };
  assert.equal(pointAtLiveFiles(approved, null), approved);
  assert.equal(pointAtLiveFiles(approved, { media: new Map() }), approved);
  const value = doc(ORIGINAL);
  assert.equal(rewriteAdfMedia(value, new Map([['unrelated', 'x']])), value, 'the very same object: nothing rewritten');
});

test('media pointers are found wherever they sit, inline media too', () => {
  const value = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mediaInline', attrs: { id: 'a' } }] }, doc('b')] };
  assert.deepEqual(adfMediaIds(value), ['a', 'b']);
});

test('Jira refusing rich text that shows a missing file is explained, and the result says Jira refused', () => {
  assert.match(explainRichTextRefusal('ATTACHMENT_VALIDATION_ERROR'), /no longer on the work item/);
  assert.equal(explainRichTextRefusal('Summary is required'), 'Summary is required');
  const [entry] = explainRefusals(
    [{ logicalNodeId: 'n1', kind: 'FIELD_CHANGED', fieldId: 'description', reason: 'Jira accepted the restore but …' }],
    [{ logicalNodeId: 'n1', kind: 'RESTORE_FIELDS', error: { detail: 'ATTACHMENT_VALIDATION_ERROR' } }]);
  assert.match(entry.reason, /^Jira refused to write it: ATTACHMENT_VALIDATION_ERROR/);
});

test('a single-issue rejection puts files back BEFORE it writes the description, then points it at the copy', async () => {
  const { executeRestore } = await import('../src/lib/restore/executor.js');
  const order = [];
  const api = { asApp: () => ({ requestJira: async (_path, options) => {
    order.push(['put', JSON.parse(options.body).fields.description.content[1].content[0].attrs.id]);
    return { status: 204, ok: true };
  } }) };
  const attachmentDeps = {
    aliases: async () => null,
    readCurrent: async () => { order.push(['files']); return [{ id: '12085', filename: 'shot.png', size: 1 }]; },
    vaultedCopies: async () => new Map(),
    identity: async () => ({ media: new Map([[COPY, ORIGINAL]]) })
  };
  const plan = { steps: [
    { fieldId: 'attachment', fieldName: 'Attachment', strategy: 'attachments', targetValue: [{ id: '12085', filename: 'shot.png' }] },
    { fieldId: 'description', fieldName: 'Description', strategy: 'field', targetValue: doc(ORIGINAL) }
  ], fieldWrites: { description: doc(ORIGINAL) } };
  const result = await executeRestore({ api, plan, issueKey: 'VAT-3', issueId: 43903, attachmentDeps,
    controlledFields: [{ field_id: 'description', field_kind: 'ADF' }, { field_id: 'attachment', field_kind: 'ATTACHMENTS' }] });
  assert.deepEqual(order, [['files'], ['put', COPY]]);
  assert.ok(result.detail.every(d => d.outcome === 'succeeded'), JSON.stringify(result.detail));
});
