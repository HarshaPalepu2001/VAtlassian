import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, needsDecision, maxMateriality, MATERIALITY, DEFAULT_LADDER
} from '../src/lib/materiality.js';

// ─── Cosmetic suppression: the thing that stops the app being muted ──────────

test('a formatting-only change is COSMETIC and needs no decision', () => {
  const level = classify('description', null, 'x', 'x', { semanticChange: false });
  assert.equal(level, MATERIALITY.COSMETIC);
  assert.equal(needsDecision(level), false);
});

// ─── The ladder ──────────────────────────────────────────────────────────────

test('scope fields default to CRITICAL', () => {
  for (const field of ['description', 'duedate', 'priority', 'security']) {
    assert.equal(DEFAULT_LADDER[field], MATERIALITY.CRITICAL, field);
  }
});

test('an unrecognised custom field defaults to MINOR, not MAJOR', () => {
  // Defaulting unknown fields high is the other reliable way to get an app
  // muted: an unrecognised custom field is far more likely to be a team's own
  // bookkeeping than a scope control.
  assert.equal(classify('customfield_12345', null, 'a', 'b'), MATERIALITY.MINOR);
});

test("an admin's explicit setting overrides the ladder", () => {
  assert.equal(classify('description', MATERIALITY.MINOR, 'a', 'b'), MATERIALITY.MINOR);
});

// ─── Direction ───────────────────────────────────────────────────────────────

test('priority RISING after approval stays critical; falling is demoted', () => {
  // Jira priority ids sort with 1 as the highest, so a numerically LOWER id is
  // an increase in urgency. Check the direction of that comparison.
  const raised = classify('priority', null, { id: '3' }, { id: '1' });
  const lowered = classify('priority', null, { id: '1' }, { id: '3' });
  assert.equal(raised, MATERIALITY.CRITICAL);
  assert.equal(lowered, MATERIALITY.MAJOR);
});

test('a due date pushed OUT stays critical; pulled in is demoted', () => {
  const pushedOut = classify('duedate', null, '2026-01-01', '2026-03-01');
  const pulledIn = classify('duedate', null, '2026-03-01', '2026-01-01');
  assert.equal(pushedOut, MATERIALITY.CRITICAL);
  assert.equal(pulledIn, MATERIALITY.MAJOR);
});

test('an estimate that shrank is demoted; one that grew is not', () => {
  const grew = classify('timeoriginalestimate', null, 3600, 7200);
  const shrank = classify('timeoriginalestimate', null, 7200, 3600);
  assert.equal(grew, MATERIALITY.MAJOR);
  assert.equal(shrank, MATERIALITY.MINOR);
});

test('direction rules cannot raise materiality above the configured level', () => {
  // A rule that could promote past an explicit setting would make the
  // configuration screen a lie.
  const configured = classify('priority', MATERIALITY.MINOR, { id: '3' }, { id: '1' });
  assert.equal(configured, MATERIALITY.MINOR);
});

test('unparseable values fall back to the base level rather than throwing', () => {
  assert.equal(classify('duedate', null, 'not-a-date', 'also-not'), MATERIALITY.CRITICAL);
  assert.equal(classify('priority', null, null, null), MATERIALITY.CRITICAL);
});

// ─── Aggregation ─────────────────────────────────────────────────────────────

test('maxMateriality picks the highest level present', () => {
  assert.equal(maxMateriality(['MINOR', 'CRITICAL', 'MAJOR']), MATERIALITY.CRITICAL);
  assert.equal(maxMateriality(['COSMETIC', 'MINOR']), MATERIALITY.MINOR);
  assert.equal(maxMateriality([]), MATERIALITY.COSMETIC);
});

test('every non-cosmetic change needs a decision, whatever its level', () => {
  for (const level of [MATERIALITY.MINOR, MATERIALITY.MAJOR, MATERIALITY.CRITICAL]) {
    assert.equal(needsDecision(level), true, level);
  }
});
