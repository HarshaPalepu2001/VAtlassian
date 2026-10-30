import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSIFICATION, buildPayload, heuristicClassify, validate, classifyFields, partitionForBaseline, buildBaselineAuditPayload
} from '../src/lib/aiClassification.js';
import { ALWAYS_CONTROLLED_FIELDS } from '../src/lib/content.js';

const F = (fieldId, fieldName, fieldKind = 'TEXT', schemaType = null) =>
  ({ fieldId, fieldName, fieldKind, schemaType });

// ─── buildPayload ─────────────────────────────────────────────────────────────

test('buildPayload accepts either db-row or camelCase shape and always emits camelCase', () => {
  const out = buildPayload([
    { field_id: 'customfield_1', field_name: 'Batch Number', field_kind: 'TEXT', schema_type: 'string' },
    F('priority', 'Priority', 'SCALAR', 'priority')
  ]);
  assert.deepEqual(out, [
    { fieldId: 'customfield_1', fieldName: 'Batch Number', fieldKind: 'TEXT', schemaType: 'string' },
    { fieldId: 'priority', fieldName: 'Priority', fieldKind: 'SCALAR', schemaType: 'priority' }
  ]);
});

test('buildPayload drops anything with no field id, and caps a runaway batch', () => {
  const out = buildPayload([{ fieldName: 'no id' }, F('a', 'A')]);
  assert.deepEqual(out.map((f) => f.fieldId), ['a']);

  const huge = Array.from({ length: 600 }, (_, i) => F(`f${i}`, `Field ${i}`));
  assert.equal(buildPayload(huge).length, 500);
});

// heuristicClassify provides the deterministic fallback.

test('heuristicClassify pins every ALWAYS_CONTROLLED_FIELDS id as GxP', () => {
  const out = heuristicClassify(ALWAYS_CONTROLLED_FIELDS.map((f) => F(f.field_id, f.field_name)));
  assert.ok(out.every((c) => c.decision === CLASSIFICATION.GXP));
});

test('heuristicClassify flags compliance-shaped names as GxP', () => {
  const out = heuristicClassify([
    F('customfield_10001', 'Acceptance Criteria'),
    F('customfield_10002', 'Validation Protocol'),
    F('duedate', 'Due Date')
  ]);
  assert.ok(out.every((c) => c.decision === CLASSIFICATION.GXP));
});

test('heuristicClassify flags planning-shaped names as non-GxP', () => {
  const out = heuristicClassify([
    F('customfield_10003', 'Sprint'),
    F('customfield_10004', 'Story Points'),
    F('customfield_10005', 'Epic Colour')
  ]);
  assert.ok(out.every((c) => c.decision === CLASSIFICATION.NON_GXP));
});

test('heuristicClassify defaults an unrecognised field to GxP', () => {
  // The opposite default from materiality.js's DEFAULT_LADDER, and deliberately
  // so: that ladder ranks already-tracked fields for alert volume, where
  // over-alerting gets an app muted. This is deciding what enters the baseline
  // in the first place, where the failure that matters is a silently omitted
  // controlled field.
  const [c] = heuristicClassify([F('customfield_99999', 'Something Nobody Has Seen Before')]);
  assert.equal(c.decision, CLASSIFICATION.GXP);
});

// validate enforces schema and classification coverage.

test('validate keeps only classifications for fields actually sent', () => {
  const fields = buildPayload([F('a', 'A'), F('b', 'B')]);
  const parsed = {
    classifications: [
      { fieldId: 'a', decision: CLASSIFICATION.GXP, rationale: 'Tracks release decision' },
      { fieldId: 'ghost-field', decision: CLASSIFICATION.GXP, rationale: 'Fabricated' },
      { fieldId: 'b', decision: CLASSIFICATION.NON_GXP, rationale: 'Sprint bookkeeping only' }
    ]
  };
  const out = validate(parsed, fields);
  assert.deepEqual(out.map((c) => c.fieldId), ['a', 'b']);
});

test('validate uses the heuristic for every field the model left unclassified', () => {
  const fields = buildPayload([F('a', 'A'), F('customfield_1', 'Sprint')]);
  const parsed = { classifications: [{ fieldId: 'a', decision: CLASSIFICATION.GXP, rationale: 'Named explicitly' }] };
  const out = validate(parsed, fields);
  assert.equal(out.length, 2);
  const b = out.find((c) => c.fieldId === 'customfield_1');
  assert.equal(b.decision, CLASSIFICATION.NON_GXP); // heuristic: "Sprint" -> non-GxP
});

test('validate rejects a non-object and a missing classifications array', () => {
  assert.equal(validate(null, []), null);
  assert.equal(validate({}, []), null);
  assert.equal(validate({ classifications: 'nope' }, []), null);
});

test('validate drops a duplicate fieldId, keeping the first', () => {
  const fields = buildPayload([F('a', 'A')]);
  const parsed = {
    classifications: [
      { fieldId: 'a', decision: CLASSIFICATION.GXP, rationale: 'first' },
      { fieldId: 'a', decision: CLASSIFICATION.NON_GXP, rationale: 'second' }
    ]
  };
  const out = validate(parsed, fields);
  assert.equal(out.length, 1);
  assert.equal(out[0].rationale, 'first');
});

test('validate truncates an over-long rationale rather than passing it through unbounded', () => {
  const fields = buildPayload([F('a', 'A')]);
  const long = 'x'.repeat(500);
  const out = validate({ classifications: [{ fieldId: 'a', decision: CLASSIFICATION.GXP, rationale: long }] }, fields);
  assert.ok(out[0].rationale.length <= 200);
});

// classifyFields is the async entry point, tested without network calls.

test('classifyFields short-circuits to the heuristic when AI is disabled for the project', async () => {
  const result = await classifyFields({ fields: [F('a', 'Sprint')], model: 'claude-haiku-4-5-20251001', aiEnabled: false });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'AI_DISABLED');
  assert.equal(result.classifications.length, 1);
});

test('classifyFields returns an empty, non-degraded result for an empty field list, without calling the model', async () => {
  const result = await classifyFields({ fields: [], model: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(result.classifications, []);
  assert.equal(result.degraded, false);
});

test('classifyFields chunks a large batch and still covers every field when the model is unreachable', async () => {
  // No @forge/llm mock is set up here, so the lazy `import('@forge/llm')` inside
  // classifyChunk() throws "Forge runtime not found" exactly as it would for
  // any test importing this module outside a deployed app. This exercises
  // the real failure path (LLM_UNAVAILABLE) across MULTIPLE PARALLEL CHUNKS at
  // once, the scenario a single giant request used to time out on.
  const fields = Array.from({ length: 120 }, (_, i) => F(`customfield_${i}`, `Field ${i}`));
  const result = await classifyFields({ fields, model: 'claude-haiku-4-5-20251001' });

  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, 'LLM_UNAVAILABLE');
  // Full coverage: every field sent comes back classified, regardless of how
  // many chunks it was split across.
  assert.equal(result.classifications.length, 120);
  assert.deepEqual(
    result.classifications.map((c) => c.fieldId).sort(),
    fields.map((f) => f.fieldId).sort()
  );
});

// partitionForBaseline shapes the write without I/O.

test('partitionForBaseline pins ALWAYS_CONTROLLED_FIELDS into tracked no matter what decision arrives for them', () => {
  const classifications = ALWAYS_CONTROLLED_FIELDS.map((f) => ({
    fieldId: f.field_id, decision: CLASSIFICATION.NON_GXP, rationale: 'a hand-edited request said so'
  }));
  const byId = new Map(ALWAYS_CONTROLLED_FIELDS.map((f) => [f.field_id, { fieldName: f.field_name, fieldKind: f.field_kind }]));

  const { tracked, excluded } = partitionForBaseline(classifications, byId);
  assert.equal(excluded.length, 0);
  assert.deepEqual(tracked.map((f) => f.fieldId).sort(), ALWAYS_CONTROLLED_FIELDS.map((f) => f.field_id).sort());
});

test('partitionForBaseline adds a pinned field even if the submitted payload never mentioned it at all', () => {
  const { tracked } = partitionForBaseline([{ fieldId: 'customfield_1', decision: CLASSIFICATION.GXP, rationale: 'r' }], new Map());
  const ids = tracked.map((f) => f.fieldId);
  for (const always of ALWAYS_CONTROLLED_FIELDS) assert.ok(ids.includes(always.field_id));
});

test('partitionForBaseline splits ordinary fields by decision', () => {
  const classifications = [
    { fieldId: 'customfield_1', decision: CLASSIFICATION.GXP, rationale: 'Tracks batch release' },
    { fieldId: 'customfield_2', decision: CLASSIFICATION.NON_GXP, rationale: 'Sprint metadata' }
  ];
  const byId = new Map([
    ['customfield_1', { fieldName: 'Batch', fieldKind: 'TEXT' }],
    ['customfield_2', { fieldName: 'Sprint', fieldKind: 'TEXT' }]
  ]);
  const { tracked, excluded } = partitionForBaseline(classifications, byId);
  assert.deepEqual(tracked.map((f) => f.fieldId).filter((id) => id.startsWith('customfield')), ['customfield_1']);
  assert.deepEqual(excluded.map((f) => f.fieldId), ['customfield_2']);
});

test('partitionForBaseline ignores a duplicate fieldId in the submitted payload, keeping the first decision', () => {
  const classifications = [
    { fieldId: 'customfield_1', decision: CLASSIFICATION.GXP, rationale: 'first' },
    { fieldId: 'customfield_1', decision: CLASSIFICATION.NON_GXP, rationale: 'second' }
  ];
  const byId = new Map([['customfield_1', { fieldName: 'X', fieldKind: 'TEXT' }]]);
  const { tracked, excluded } = partitionForBaseline(classifications, byId);
  assert.equal(tracked.filter((f) => f.fieldId === 'customfield_1').length, 1);
  assert.equal(excluded.filter((f) => f.fieldId === 'customfield_1').length, 0);
});

// buildBaselineAuditPayload enforces compliance metadata.

test('buildBaselineAuditPayload enforces required metadata and maps fields correctly', () => {
  const tracked = [
    { fieldId: 'customfield_1', fieldName: 'Batch', fieldKind: 'TEXT', rationale: 'Tracks batch release', irrelevantInfo: 'dropped' }
  ];
  const excluded = [
    { fieldId: 'customfield_2', fieldName: 'Sprint', fieldKind: 'TEXT', rationale: 'Sprint metadata', anotherKey: 123 }
  ];
  const now = 1680000000000;

  const payload = buildBaselineAuditPayload({
    projectId: 10001,
    issueTypeId: '10002',
    tracked,
    excluded,
    now
  });

  assert.equal(payload.projectId, 10001);
  assert.equal(payload.issueTypeId, '10002');
  assert.equal(payload.aiAssisted, true);
  assert.equal(payload.reviewedByHuman, true);
  assert.equal(payload.timestamp, now);

  // Verifies strict schema for elements in lists (drops extra fields like irrelevantInfo)
  assert.deepEqual(payload.trackedFields, [
    { fieldId: 'customfield_1', fieldName: 'Batch', fieldKind: 'TEXT', rationale: 'Tracks batch release' }
  ]);
  assert.deepEqual(payload.excludedFields, [
    { fieldId: 'customfield_2', fieldName: 'Sprint', fieldKind: 'TEXT', rationale: 'Sprint metadata' }
  ]);
});

test('buildBaselineAuditPayload rejects invalid context variables', () => {
  assert.throws(() => buildBaselineAuditPayload({ issueTypeId: '10002', tracked: [], excluded: [], now: 123 }), /Missing projectId/);
  assert.throws(() => buildBaselineAuditPayload({ projectId: 10001, tracked: [], excluded: [], now: 123 }), /Missing issueTypeId/);
  assert.throws(() => buildBaselineAuditPayload({ projectId: 10001, issueTypeId: '10002', tracked: [], excluded: [] }), /Missing timestamp/);
});
