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
  // Read once to plan the files, once more to see which copies are live now.
  assert.deepEqual(order, [['files'], ['files'], ['put', COPY]]);
  assert.ok(result.detail.every(d => d.outcome === 'succeeded'), JSON.stringify(result.detail));
});

// ── Gap A: a description nobody edited, showing a file that was deleted ─────

const COPY2 = '9a1c0000-0000-4000-8000-000000000002';
const restoredOnce = { files: new Map([['12090', '12085']]), media: new Map([[COPY, ORIGINAL]]),
  mediaOwner: new Map([[COPY, '12090']]) };

function fakeJira(puts) {
  return { asApp: () => ({ requestJira: async (_path, options) => {
    puts.push(JSON.parse(options.body).fields);
    return { status: 204, ok: true };
  } }) };
}

const filesOnly = targetValue => ({ steps: [
  { fieldId: 'attachment', fieldName: 'Attachment', strategy: 'attachments', targetValue }
], fieldWrites: {}, repoint: [{ fieldId: 'description', fieldName: 'Description', targetValue: doc(ORIGINAL) }] });

const FIELDS = [{ field_id: 'description', field_name: 'Description', field_kind: 'ADF' },
  { field_id: 'attachment', field_name: 'Attachment', field_kind: 'ATTACHMENTS' }];

test('a description that did not change is re-pointed at the file a rejection put back', async () => {
  const { executeRestore } = await import('../src/lib/restore/executor.js');
  const puts = [];
  const attachmentDeps = {
    aliases: async () => restoredOnce.files,
    readCurrent: async () => [{ id: '12090', filename: 'shot.png', size: 1 }],
    vaultedCopies: async () => new Map(),
    identity: async () => restoredOnce
  };
  const result = await executeRestore({ api: fakeJira(puts), plan: filesOnly([{ id: '12085', filename: 'shot.png' }]),
    issueKey: 'VAT-3', issueId: 43903, attachmentDeps, controlledFields: FIELDS });
  assert.equal(puts.length, 1, 'the description is written even though the diff never named it');
  assert.deepEqual(puts[0].description, doc(COPY));
  assert.deepEqual(result.writeIds, ['description']);
});

test('a re-point candidate that shows no restored file is not written at all', async () => {
  const { executeRestore } = await import('../src/lib/restore/executor.js');
  const puts = [];
  const attachmentDeps = {
    aliases: async () => null,
    readCurrent: async () => [{ id: '12085', filename: 'shot.png', size: 1 }],
    vaultedCopies: async () => new Map(),
    identity: async () => null
  };
  const result = await executeRestore({ api: fakeJira(puts), plan: filesOnly([{ id: '12085', filename: 'shot.png' }]),
    issueKey: 'VAT-3', issueId: 43903, attachmentDeps, controlledFields: FIELDS });
  assert.equal(puts.length, 0);
  assert.deepEqual(result.writeIds, []);
});

// ── Gap B: restored, deleted, restored again ───────────────────────────────

test('of two copies of one file, the text shows the one still on the item, whichever was recorded first', () => {
  const twice = { files: new Map([['12090', '12085'], ['12095', '12085']]),
    media: new Map([[COPY, ORIGINAL], [COPY2, ORIGINAL]]),
    mediaOwner: new Map([[COPY, '12090'], [COPY2, '12095']]) };
  const approved = { description: doc(ORIGINAL) };
  assert.deepEqual(pointAtLiveFiles(approved, twice, { liveJiraIds: new Set(['12095']) }).description, doc(COPY2));
  assert.deepEqual(pointAtLiveFiles(approved, twice, { liveJiraIds: new Set(['12090']) }).description, doc(COPY),
    'the newer copy was deleted: the older, live one is shown');
  assert.deepEqual(pointAtLiveFiles(approved, twice).description, doc(COPY2), 'without a live list, the newest wins');
});

// ── A copy whose media id Jira never gave ──────────────────────────────────

test('a restored file with no known media id: the text showing it is named as failed, never sent', async () => {
  const { executeRestore } = await import('../src/lib/restore/executor.js');
  const puts = [];
  const pauses = [];
  let uploaded = false;
  const bytes = Buffer.from('png');
  const { sha256 } = await import('../src/lib/restore/attachments.js');
  const attachmentDeps = {
    aliases: async () => null,
    readCurrent: async () => (uploaded ? [{ id: '12090', filename: 'shot.png' }] : []),
    vaultedCopies: async () => new Map([['12085', { content_hash: sha256(bytes), storage: 'OBJECT_STORE',
      object_key: 'vault/sha256/k', media_id: ORIGINAL, filename: 'shot.png' }]]),
    downloadVaulted: async () => bytes,
    upload: async () => { uploaded = true; return { id: '12090' }; },
    download: async () => bytes,
    mediaIdOf: async () => null,
    sleep: async ms => { pauses.push(ms); },
    recordAlias: async () => {},
    audit: async () => ({}),
    identity: async () => ({ files: new Map([['12090', '12085']]), media: new Map(), mediaOwner: new Map() })
  };
  const plan = { steps: [
    { fieldId: 'attachment', fieldName: 'Attachment', strategy: 'attachments', targetValue: [{ id: '12085', filename: 'shot.png' }] },
    { fieldId: 'description', fieldName: 'Description', strategy: 'field', targetValue: doc(ORIGINAL) },
    { fieldId: 'summary', fieldName: 'Summary', strategy: 'field', targetValue: 'kept' }
  ], fieldWrites: { description: doc(ORIGINAL), summary: 'kept' } };
  const result = await executeRestore({ api: fakeJira(puts), plan, issueKey: 'VAT-3', issueId: 43903, attachmentDeps,
    controlledFields: [...FIELDS, { field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT' }] });
  assert.equal(pauses.length, 2, 'asked three times before the id counts as unknown');
  assert.deepEqual(puts, [{ summary: 'kept' }], 'the description is not sent with a pointer Jira would refuse');
  const description = result.detail.find(d => d.fieldId === 'description');
  assert.equal(description.outcome, 'failed');
  assert.match(description.reason, /did not say which media file the copy is/);
  assert.equal(result.detail.find(d => d.fieldId === 'attachment').outcome, 'succeeded', 'the file itself is back');
});

// ── The reject dialog, and the check a digest cannot make ──────────────────

test('the plan names unchanged rich text that will be re-pointed, only when files come back', async () => {
  const { planRestore } = await import('../src/lib/restore/planner.js');
  const controlledFields = [
    { field_id: 'attachment', field_name: 'Attachment', field_kind: 'ATTACHMENTS', store_values: true },
    { field_id: 'description', field_name: 'Description', field_kind: 'ADF', store_values: true },
    { field_id: 'customfield_1', field_name: 'Notes', field_kind: 'ADF', store_values: true }
  ];
  const baselineValues = { attachment: [{ id: '12085', filename: 'shot.png' }], description: doc(ORIGINAL),
    customfield_1: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no files' }] }] } };
  const editmeta = { attachment: { operations: ['set'] }, description: { operations: ['set'] }, customfield_1: { operations: ['set'] } };
  const removedFile = { fields: [{ fieldId: 'attachment', fieldName: 'Attachment', changed: true, restorable: 'SPECIAL',
    removed: [{ id: '12085', filename: 'shot.png' }], added: [] }] };
  const plan = planRestore({ diff: removedFile, baselineValues, controlledFields, editmeta });
  assert.deepEqual(plan.repoint.map(c => c.fieldId), ['description'], 'only rich text that shows a file');
  assert.deepEqual(plan.preflight.richTextRepoint, ['Description']);

  const nothingRemoved = planRestore({ diff: { fields: [{ fieldId: 'attachment', fieldName: 'Attachment', changed: true,
    restorable: 'SPECIAL', removed: [], added: [{ id: '9', filename: 'x' }] }] }, baselineValues, controlledFields, editmeta });
  assert.deepEqual(nothingRemoved.repoint, [], 'no file comes back, so nothing needs pointing');
});

test('a description pointing at a deleted file is caught, though its digest matches', async () => {
  const { danglingMediaPointers } = await import('../src/lib/attachmentIdentity.js');
  assert.deepEqual(danglingMediaPointers({ description: doc(ORIGINAL) }, restoredOnce, new Set(['12090'])),
    [{ fieldId: 'description', mediaId: ORIGINAL, jiraId: '12085' }]);
  assert.deepEqual(danglingMediaPointers({ description: doc(COPY) }, restoredOnce, new Set(['12090'])), []);
  assert.deepEqual(danglingMediaPointers({ description: doc('elsewhere') }, restoredOnce, new Set()), [],
    'a file the app never restored is not judged');
});

test('verification reports a description whose image points at a deleted file, though its digest matches', async () => {
  const { verifyRestore } = await import('../src/lib/restore/verifier.js');
  const fields = [{ field_id: 'description', field_name: 'Description', field_kind: 'ADF', store_values: true }];
  const digest = project({ description: doc(ORIGINAL) }, fields).digests.description;
  const issue = description => ({ id: '43903', fields: { description, attachment: [{ id: '12090', filename: 'shot.png', size: 1 }] } });
  const apiReturning = body => ({ asApp: () => ({ requestJira: async () => ({ ok: true, json: async () => body }) }) });
  const readIdentity = async () => new Map([[43903, restoredOnce]]);
  const detail = [{ fieldId: 'description', fieldName: 'Description', outcome: 'succeeded', verified: false }];

  const broken = await verifyRestore({ api: apiReturning(issue(doc(ORIGINAL))), issueKey: 'VAT-3', controlledFields: fields,
    baselineDigests: { description: digest }, detail, readIdentity });
  assert.equal(broken.detail[0].outcome, 'failed');
  assert.match(broken.unmatched[0].reason, /no longer on the work item/);

  const fixed = await verifyRestore({ api: apiReturning(issue(doc(COPY))), issueKey: 'VAT-3', controlledFields: fields,
    baselineDigests: { description: digest }, detail, readIdentity });
  assert.equal(fixed.detail[0].verified, true);
  assert.deepEqual(fixed.unmatched, []);
});
