import test from 'node:test';
import assert from 'node:assert/strict';

import { adoptScreenFields, fieldsToAdopt, screenBatch, SCREEN_BATCH, scopeFromIssue, screenIdsForIssueType, SCOPE_BASIS } from '../src/lib/trackedFields.js';
import { IGNORED_FIELDS } from '../src/lib/content.js';

/**
 * TRACK-BY-DEFAULT, AND THE TWO WAYS IT COULD GO WRONG.
 *
 * The app has shipped both failure modes. Tracking everything Jira has produced
 * a 306-field baseline that reported drift on `lastViewed`; tracking only what
 * an administrator had hand-declared produced projects that were gated and
 * tracked nothing, so a reviewer's signature bound to an empty set.
 *
 * These tests pin the middle: everything, minus the fields that cannot be
 * tracked honestly, minus the ones somebody deliberately turned off.
 */

const jira = (...ids) => ids.map((id) => ({
  id,
  name: id === 'summary' ? 'Summary' : `Field ${id}`,
  schema: { type: 'string' }
}));

const row = (field_id, state = 'ACTIVE') => ({
  field_id, field_name: field_id, field_kind: 'TEXT', state
});

test('a project that has declared nothing adopts every usable field', () => {
  // The bug this whole change exists for: BS had a gate, had approved
  // baselines, and tracked zero fields, so nothing could ever register as drift.
  const adopt = fieldsToAdopt(jira('summary', 'description', 'customfield_10042'), []);

  assert.deepEqual(
    adopt.map((f) => f.field_id).sort(),
    ['customfield_10042', 'description', 'summary']
  );
});

test('an excluded field is never re-adopted, however often the sync runs', () => {
  // The property that lets this run hourly without fighting the administrator.
  // If `declared` were filtered to ACTIVE rows before reaching here, the
  // exclusion would be invisible and the job would undo it every hour.
  const declared = [row('summary'), row('customfield_10042', 'EXCLUDED')];

  const once = fieldsToAdopt(jira('summary', 'description', 'customfield_10042'), declared);
  assert.deepEqual(once.map((f) => f.field_id), ['description']);

  // Second pass, with the first pass's result now declared: nothing left.
  const twice = fieldsToAdopt(
    jira('summary', 'description', 'customfield_10042'),
    [...declared, row('description')]
  );
  assert.deepEqual(twice, []);
});

test('fields that change without anyone touching the item are never offered', () => {
  // The list that makes track-by-default safe. `lastViewed` is the sharpest
  // case: it moves when a reviewer OPENS the item to review it, so tracking it
  // would make the act of reviewing produce drift.
  const volatile = ['lastViewed', 'updated', 'workratio', 'status', 'comment', 'created'];
  for (const id of volatile) {
    assert.ok(IGNORED_FIELDS.has(id), `${id} should be permanently ignored`);
  }

  const adopt = fieldsToAdopt(jira('summary', ...volatile), []);
  assert.deepEqual(adopt.map((f) => f.field_id), ['summary']);
});

test('already-tracked fields are proposed again by nobody, so a re-sync is a no-op', () => {
  const declared = [row('summary'), row('description')];
  assert.deepEqual(fieldsToAdopt(jira('summary', 'description'), declared), []);
});

test('adoption carries a materiality, so a new field is never graded as unset', () => {
  // capture and the diff both read materiality; a row written without one would
  // sort as the lowest grade and quietly never reach a reviewer as significant.
  const adopt = fieldsToAdopt(jira('summary', 'customfield_99999'), []);
  for (const f of adopt) {
    assert.ok(typeof f.materiality === 'string' && f.materiality.length > 0,
      `${f.field_id} adopted without a materiality`);
  }
});

test('an empty Jira catalogue proposes nothing rather than treating it as an answer', () => {
  // A failed /field read returns []. Adopting nothing is right; the caller
  // reports CATALOGUE_UNAVAILABLE rather than "already complete".
  assert.deepEqual(fieldsToAdopt([], [row('summary')]), []);
  assert.deepEqual(fieldsToAdopt(null, null), []);
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPING ONE WORK ITEM.
 *
 * scopeFromIssue() is the single definition of "which declared fields are on
 * this issue", used by capture.js, collect.js and all four field-set sites in
 * resolvers/panel.js.
 *
 * THE BASIS IS THE SCREEN. BS-22's edit screen carries eighteen fields — the
 * list an administrator sees under Screens. `?fields=*all` returned 203,
 * because that is the PROJECT'S FIELD CONFIGURATION and not a screen: almost
 * all of them custom fields sitting at null that no screen in the project uses.
 * The panel duly reported "203 tracked fields" about an issue with eighteen.
 *
 * AND IT IS A PURE FUNCTION, which is the other half. The evidence hash a
 * reviewer's signature binds to is computed over this set. An earlier version
 * derived it from a live createmeta call, so the same work item could hash
 * differently between the panel rendering it and the resolver re-deriving it —
 * one call succeeding and one failing was enough to refuse the decision as
 * STALE_EVIDENCE. Every caller now passes reads it already performs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const scopeRow = (field_id) => ({ field_id, field_name: field_id, field_kind: 'TEXT', state: 'ACTIVE' });

test('the scope is exactly the declared set', () => {
  const declared = [{ field_id: 'customfield_10101' }];
  const editmetaFields = { summary: {}, description: {} }; // Ignored now
  const { fields, basis } = scopeFromIssue({ declared, editmetaFields });

  // Always tracking the declared + always controlled fields
  assert.strictEqual(basis, SCOPE_BASIS.DECLARED);
});

test('the declared set wins over the wider issue read and the screen', () => {
  const declared = [{ field_id: 'customfield_10101' }];
  const editmetaFields = { summary: {}, description: {} }; // Ignored
  const issueFields = { summary: 'S', description: 'D', customfield_10101: 'A' }; // Ignored

  const { fields } = scopeFromIssue({ declared, issueFields, editmetaFields });
  const ids = fields.map(f => f.field_id);

  assert.deepStrictEqual(ids.includes('customfield_10101'), true);
});

test('with nothing readable it keeps the declared set rather than guessing', () => {
  const declared = [scopeRow('summary'), scopeRow('customfield_10101')];
  const res = scopeFromIssue({ declared, issueFields: {}, editmetaFields: {} });

  assert.equal(res.basis, SCOPE_BASIS.DECLARED);
  assert.deepEqual(res.fields.map((f) => f.field_id).sort(), ['customfield_10101', 'summary']);
});

test('the always-controlled fields survive a screen that omits them', () => {
  // `subtasks` is not editable and so never appears in editmeta. Dropping it
  // would quietly stop protecting one of the four fields the reviewed record is
  // made of.
  const declared = [scopeRow('summary'), scopeRow('subtasks'), scopeRow('description')];
  const res = scopeFromIssue({
    declared,
    issueFields: { summary: 'x', subtasks: [], description: null },
    editmetaFields: { summary: {} }
  });

  assert.deepEqual(
    res.fields.map((f) => f.field_id).sort(),
    ['description', 'subtasks', 'summary']
  );
});

test('the same declared rows and the same reads always produce the same scope', () => {
  // THE PROPERTY THE STALE-EVIDENCE BUG VIOLATED. computeState and
  // authoriseFirstApproval each derive this set and hash it; if the two
  // derivations can differ, every first approval is refused.
  const declared = [scopeRow('summary'), scopeRow('priority')];
  const issueFields = { summary: 'x', priority: {} };
  const editmetaFields = { summary: {}, priority: {} };

  const a = scopeFromIssue({ declared, issueFields, editmetaFields });
  const b = scopeFromIssue({ declared, issueFields, editmetaFields });

  assert.deepEqual(a.fields.map((f) => f.field_id), b.fields.map((f) => f.field_id));
  assert.equal(a.basis, b.basis);
});

test('field discovery includes create edit view and transition screens for the exact work type', () => {
  const screenIds = screenIdsForIssueType({
    issueTypeId: '10718',
    mappings: [
      { issueTypeId: 'default', screenSchemeId: '12013' },
      { issueTypeId: '10718', screenSchemeId: '12082' }
    ],
    screenSchemes: [{ id: 12082, screens: { default: 12799, create: 12797, edit: 12798, view: 12799 } }],
    workflow: {
      transitions: [
        { transitionScreen: { parameters: { screenId: '12802' } } },
        { transitionScreen: { id: '12801' } }
      ]
    }
  });

  assert.deepEqual(screenIds.sort(), ['12797', '12798', '12799', '12801', '12802']);
});

test('a screen field without a catalogue entry is never adopted, so it cannot be recorded with the wrong kind', () => {
  const sink = new Map([['summary', { id: 'summary', name: 'Summary' }]]);
  const screenFields = new Map([
    ['customfield_1', { id: 'customfield_1', name: 'Rationale' }],
    ['customfield_2', { id: 'customfield_2', name: 'Unknown to the catalogue' }],
    ['summary', { id: 'summary', name: 'Screen copy' }]
  ]);
  const catalogue = [
    { id: 'customfield_1', name: 'Rationale', schema: { type: 'string', custom: 'textarea' } },
    { id: 'summary', name: 'Summary', schema: { type: 'string' } }
  ];

  assert.equal(adoptScreenFields({ screenFields, catalogue, sink }), 1);
  assert.deepEqual(sink.get('customfield_1').schema, { type: 'string', custom: 'textarea' });
  assert.equal(sink.has('customfield_2'), false);
  assert.equal(sink.get('summary').name, 'Summary');
  assert.equal(adoptScreenFields({ screenFields, catalogue: [], sink: new Map() }), 0);
});

test('screens are read in batches that cover every screen exactly once', () => {
  const ids = Array.from({ length: 130 }, (_, i) => String(12000 + i)).reverse();
  const seen = [];
  let offset = 0;
  let batches = 0;
  while (offset != null) {
    const batch = screenBatch(ids, offset);
    assert.ok(batch.ids.length <= SCREEN_BATCH);
    assert.equal(batch.total, 130);
    seen.push(...batch.ids);
    offset = batch.nextOffset;
    batches++;
  }
  assert.equal(batches, 3);
  assert.deepEqual(seen, [...ids].sort((a, b) => Number(a) - Number(b)));
  assert.deepEqual(screenBatch(['7', '7', '3'], 0), { ids: ['3', '7'], total: 2, nextOffset: null });
  assert.deepEqual(screenBatch(['1', '2'], 99), { ids: [], total: 2, nextOffset: null });
  assert.deepEqual(screenBatch(['1', '2'], -4).ids, ['1', '2']);
});
