import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAttachments, canonicaliseItems, canonicaliseIssue, recordedAttachments, jiraIdOf } from '../src/lib/attachmentIdentity.js';
import { project, IGNORED_FIELDS, candidateFields, inferFieldKind, FIELD_KIND } from '../src/lib/content.js';

const TRACKED = [{ field_id: 'attachment', field_kind: 'ATTACHMENTS', store_values: true }];
const jiraFile = (id, filename, extra = {}) => ({ id, filename, size: 10, mimeType: 'application/pdf',
  created: '2026-09-01T10:00:00.000+0000', author: { accountId: 'u1', displayName: 'Uma' },
  content: `https://jira/secure/attachment/${id}`, self: `https://jira/rest/api/3/attachment/${id}`, ...extra });

test('attachments can now be tracked, and Jira schema marks them as ATTACHMENTS', () => {
  assert.equal(IGNORED_FIELDS.has('attachment'), false);
  const menu = candidateFields([{ id: 'attachment', name: 'Attachment', schema: { type: 'array', items: 'attachment', system: 'attachment' } }], []);
  assert.deepEqual(menu.map(f => [f.field_id, f.field_kind]), [['attachment', FIELD_KIND.ATTACHMENTS]]);
  assert.equal(inferFieldKind({ type: 'array', items: 'attachment', system: 'attachment' }), FIELD_KIND.ATTACHMENTS);
});

test('attachments hash by id, name and size only: a re-upload changes nothing else that counts', () => {
  const original = project({ attachment: [jiraFile('1', 'spec.pdf')] }, TRACKED);
  const reuploaded = project({ attachment: [jiraFile('1', 'spec.pdf', { created: '2026-09-24T00:00:00.000+0000',
    author: { accountId: 'app' }, mimeType: 'binary/octet-stream' })] }, TRACKED);
  assert.equal(reuploaded.digests.attachment, original.digests.attachment);
  const added = project({ attachment: [jiraFile('1', 'spec.pdf'), jiraFile('2', 'extra.csv')] }, TRACKED);
  assert.notEqual(added.digests.attachment, original.digests.attachment);
  const swapped = project({ attachment: [jiraFile('3', 'spec.pdf')] }, TRACKED);
  assert.notEqual(swapped.digests.attachment, original.digests.attachment, 'same name, new id: a different file');
  const reordered = project({ attachment: [jiraFile('2', 'extra.csv'), jiraFile('1', 'spec.pdf')] }, TRACKED);
  assert.equal(reordered.digests.attachment, added.digests.attachment);
});

test('a restored copy reads under the id of the original it stands for, keeping its real id', () => {
  const [entry] = canonicalAttachments([jiraFile('900', 'spec.pdf')], new Map([['900', '1']]));
  assert.equal(entry.id, '1');
  assert.equal(entry.jiraId, '900');
  assert.equal(jiraIdOf(entry), '900');
  assert.equal(entry.content, undefined, 'Jira URLs are not kept');
  assert.equal(project({ attachment: [entry] }, TRACKED).digests.attachment,
    project({ attachment: [jiraFile('1', 'spec.pdf')] }, TRACKED).digests.attachment);
});

test('canonicalising twice is harmless', () => {
  const once = canonicalAttachments([jiraFile('900', 'spec.pdf')], new Map([['900', '1']]));
  const twice = canonicalAttachments(once, new Map([['1', 'zzz']]));
  assert.deepEqual(twice, once);
});

test('one alias lookup for a whole tree, and none when no item has a file', async () => {
  const lookups = [];
  const read = async ids => { lookups.push(ids); return new Map([[11, new Map([['900', '1']])]]); };
  const nodes = [
    { id: '10', fields: { attachment: [] } },
    { id: '11', fields: { attachment: [jiraFile('900', 'spec.pdf')] } },
    { id: '12', fields: { attachment: [jiraFile('5', 'other.txt')] } },
    { id: '13', fields: { summary: 'no attachment field' } }
  ];
  await canonicaliseItems(nodes, { read });
  assert.deepEqual(lookups, [[11, 12]]);
  assert.equal(nodes[1].fields.attachment[0].id, '1');
  assert.equal(nodes[2].fields.attachment[0].id, '5');
  await canonicaliseItems([{ id: '1', fields: { attachment: [] } }], { read });
  assert.equal(lookups.length, 1, 'no files, no lookup');
});

test('an unreadable alias table fails towards drift: the copy keeps its own id', async () => {
  const issue = { id: '11', fields: { attachment: [jiraFile('900', 'spec.pdf')] } };
  await canonicaliseIssue(issue, { read: async () => { throw new Error('db down'); } });
  assert.equal(issue.fields.attachment[0].id, '900');
});

test('recordedAttachments names exactly what a baseline recorded, or null when it tracks no files', () => {
  const values = { attachment: canonicalAttachments([jiraFile('900', 'spec.pdf'), jiraFile('2', 'b.csv')], new Map([['900', '1']])) };
  assert.deepEqual(recordedAttachments(values, TRACKED), [
    { id: '1', jiraId: '900', filename: 'spec.pdf' }, { id: '2', jiraId: '2', filename: 'b.csv' }]);
  assert.deepEqual(recordedAttachments({ attachment: [] }, TRACKED), []);
  assert.equal(recordedAttachments({ summary: 'x' }, [{ field_id: 'summary', field_kind: 'TEXT' }]), null);
});
