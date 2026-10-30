import test from 'node:test';
import assert from 'node:assert/strict';
import {
  project, changedFields, normaliseAdf, normaliseMulti, normaliseText,
  withAlwaysControlled, inferFieldKind, FIELD_KIND
} from '../src/lib/content.js';

const F = (id, kind, store = false) => ({ field_id: id, field_kind: kind, store_values: store });

test('the content hash is computed from digests alone, so toggling retention never invalidates a baseline', () => {
  // This is the property that lets an administrator turn value retention on or
  // off without every standing baseline on the site drifting against itself.
  const fields = { summary: 'Ship the thing', description: null };
  const off = project(fields, [F('summary', FIELD_KIND.TEXT, false)]);
  const on = project(fields, [F('summary', FIELD_KIND.TEXT, true)]);

  assert.equal(off.contentHash, on.contentHash);
  assert.deepEqual(off.values, {});
  assert.deepEqual(on.values, { summary: 'Ship the thing' });
});

test('values are stored only for fields that opted in', () => {
  const result = project(
    { summary: 'a', description: { type: 'doc', content: [] }, labels: ['x'] },
    [
      F('summary', FIELD_KIND.TEXT, true),
      F('description', FIELD_KIND.ADF, false),
      F('labels', FIELD_KIND.MULTI, false)
    ]
  );

  assert.deepEqual(Object.keys(result.values), ['summary']);
  assert.deepEqual(Object.keys(result.raw), ['summary']);
  // Every field is still digested, so drift is still DETECTED for all three.
  assert.deepEqual(Object.keys(result.digests).sort(), ['description', 'labels', 'summary']);
});

test('raw values are kept alongside normalised ones, because a restore must write raw', () => {
  // Normalisation sorts multi-values; writing the sorted form back into Jira
  // would be a silent second edit.
  const result = project({ labels: ['zebra', 'apple'] }, [F('labels', FIELD_KIND.MULTI, true)]);
  assert.deepEqual(result.values.labels, ['apple', 'zebra']);
  assert.deepEqual(result.raw.labels, ['zebra', 'apple']);
});

test('ADF localId and version are volatile and never affect the hash', () => {
  const a = { type: 'doc', version: 1, content: [{ type: 'paragraph', localId: 'x1' }] };
  const b = { type: 'doc', version: 2, content: [{ type: 'paragraph', localId: 'x2' }] };
  assert.deepEqual(normaliseAdf(a), normaliseAdf(b));
});

test('normaliseAdf walks iteratively: exact byte-for-byte output, captured before the recursion was removed', () => {
  // Expected strings below are JSON.stringify(normaliseAdf(fixture)) captured
  // from the original recursive implementation. They pin both structure AND
  // key insertion order, not just deep-equal shape.
  const nested = {
    type: 'doc', version: 1, localId: 'root',
    content: [
      { type: 'bulletList', localId: 'l1', content: [
        { type: 'listItem', localId: 'i1', content: [
          { type: 'paragraph', localId: 'p1', content: [
            { type: 'text', text: 'alpha', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'beta' }
          ] }
        ] },
        { type: 'listItem', localId: 'i2', content: [] }
      ] },
      { type: 'table', localId: 't1', content: [
        { type: 'tableRow', content: [
          { type: 'tableCell', attrs: { colspan: 1, rowspan: 2 }, content: [{ type: 'paragraph', content: [] }] }
        ] }
      ] }
    ]
  };
  assert.equal(
    JSON.stringify(normaliseAdf(nested)),
    '{"content":[{"content":[{"content":[{"content":[{"marks":[{"type":"strong"}],"text":"alpha","type":"text"},{"text":"beta","type":"text"}],"type":"paragraph"}],"type":"listItem"},{"content":[],"type":"listItem"}],"type":"bulletList"},{"content":[{"content":[{"attrs":{"colspan":1,"rowspan":2},"content":[{"content":[],"type":"paragraph"}],"type":"tableCell"}],"type":"tableRow"}],"type":"table"}],"type":"doc"}'
  );
  assert.equal(JSON.stringify(normaliseAdf([{ type: 'text', text: 'z', localId: 'q' }, { type: 'text', text: 'a' }])),
    '[{"text":"z","type":"text"},{"text":"a","type":"text"}]');
  assert.equal(normaliseAdf('just a string'), 'just a string');
  assert.equal(normaliseAdf(null), null);
});

test('normaliseAdf has no recursion depth limit after the overflow around 2,000 levels', () => {
  // One nesting level per loop iteration, not per call frame.
  const deepNest = (n) => {
    let node = { type: 'text', text: 'leaf' };
    for (let i = 0; i < n; i++) node = { type: 'paragraph', localId: `p${i}`, content: [node] };
    return { type: 'doc', version: 1, content: [node] };
  };
  const leafOf = (node) => {
    let cur = node;
    while (cur && typeof cur === 'object' && Array.isArray(cur.content) && cur.content.length) cur = cur.content[0];
    return cur;
  };

  // 2,000 levels reliably crashed the old recursive implementation with
  // "Maximum call stack size exceeded"; 10,000 is well beyond that.
  const result = normaliseAdf(deepNest(10000));
  assert.deepEqual(leafOf(result), { text: 'leaf', type: 'text' });
});

test('reordering a multi-value is not a change', () => {
  assert.deepEqual(normaliseMulti(['b', 'a']), normaliseMulti(['a', 'b']));
});

test('trailing whitespace and line endings are normalised out of plain text', () => {
  assert.equal(normaliseText('a  \r\nb'), 'a\nb');
});

test('summary, description, issuelinks, and subtasks are always controlled, and always added with retention ON', () => {
  const result = withAlwaysControlled([]);
  assert.strictEqual(result.length, 4);

  const desc = result.find(f => f.field_id === 'description');
  assert.strictEqual(desc.store_values, true);
  assert.strictEqual(desc.state, 'ACTIVE');
});

test('withAlwaysControlled corrects field_kind but retains user preferences like store_values OFF', () => {
  const declared = [{
    field_id: 'description',
    field_kind: 'TEXT',
    store_values: false
  }];
  const result = withAlwaysControlled(declared);
  const desc = result.find(f => f.field_id === 'description');

  assert.strictEqual(desc.field_kind, 'ADF');
  assert.strictEqual(desc.store_values, false);
});

test('changedFields reports exactly the fields whose digests moved', () => {
  assert.deepEqual(changedFields({ a: '1', b: '2' }, { a: '1', b: '3' }), ['b']);
  assert.deepEqual(changedFields({ a: '1' }, { a: '1', b: '2' }), ['b']);
  assert.deepEqual(changedFields({ a: '1' }, { a: '1' }), []);
});

/**
 * Drift describes changes to a work item's tracked content.
 *
 * These regressions cover 302 false drift rows on BS-21 and 14 on BS-11.
 * The items had not changed, but the reviewer saw "this work item changed
 * while you were reading it".
 *
 * changedFields unioned the baseline and current key sets. Comparing a
 * baseline of 302 fields with a projection of 4 reported the 298 missing
 * keys as changed because `digest !== null` was true. Excluding a field in
 * configuration or removing it from the issue type therefore created drift.
 *
 * observe() already passed in-scope field ids as a third argument, but
 * changedFields accepted two arguments and ignored it.
 */
test('a field that left the tracked set is not drift on the work item', () => {
  // The baseline covered `legacy`; the current scope does not. Nobody edited
  // this item. The tracked set narrowed. That is a configuration change and
  // belongs in the ledger, not on the reviewer's screen as a changed field.
  assert.deepEqual(
    changedFields({ summary: '1', legacy: '2' }, { summary: '1' }, ['summary']),
    []
  );
});

test('a newly tracked field is not drift until a baseline covers it', () => {
  // `added` has no approved value to have drifted FROM. Counting it would mean
  // that installing an app which adds a custom field marks every approved item
  // in the tenant as drifted, the failure trackedFields.js was
  // written to avoid.
  assert.deepEqual(
    changedFields({ summary: '1' }, { summary: '1', added: '9' }, ['summary', 'added']),
    []
  );
});

test('a real edit inside the scope is still drift', () => {
  // The guard above must not be able to swallow the thing this app exists for.
  assert.deepEqual(
    changedFields({ summary: '1', legacy: '2' }, { summary: 'CHANGED' }, ['summary']),
    ['summary']
  );
});

test('scoping never widens the comparison beyond the scope it was given', () => {
  // A digest pair that differs is still ignored when the field is out of scope,
  // in both directions.
  assert.deepEqual(
    changedFields({ a: '1', b: '1' }, { a: '2', b: '2' }, ['b']),
    ['b']
  );
});

test('an unknown field schema infers a hashable kind rather than throwing', () => {
  assert.equal(inferFieldKind({ type: 'doc' }), FIELD_KIND.ADF);
  assert.equal(inferFieldKind({ type: 'array', items: 'option' }), FIELD_KIND.MULTI);
  assert.equal(inferFieldKind({ type: 'something-new' }), FIELD_KIND.SCALAR);
  assert.equal(inferFieldKind(undefined), FIELD_KIND.SCALAR);
});
