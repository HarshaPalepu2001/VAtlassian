import test from 'node:test';
import assert from 'node:assert/strict';
import { tally, OUTCOME, RESTORE_STATE } from '../src/lib/restore/outcome.js';

test('a verified write with no unmatched fields is COMPLETE', () => {
  const { counters, state } = tally(
    [{ fieldId: 'summary', outcome: OUTCOME.SUCCEEDED, verified: true }],
    []
  );
  assert.equal(state, RESTORE_STATE.COMPLETE);
  assert.equal(counters.unmatched, 0);
});

test('a tracked field that still does not match blocks COMPLETE', () => {
  const { counters, state } = tally(
    [{ fieldId: 'summary', outcome: OUTCOME.SUCCEEDED, verified: true }],
    [{ fieldId: 'duedate', fieldName: 'Due date', expected: 'a', actual: 'b' }]
  );
  assert.notEqual(state, RESTORE_STATE.COMPLETE);
  assert.equal(state, RESTORE_STATE.PARTIAL);
  assert.equal(counters.unmatched, 1);
});

test('unmatched fields alone, with nothing written, is not COMPLETE either', () => {
  const { state } = tally([], [{ fieldId: 'x', fieldName: 'X', expected: 'a', actual: 'b' }]);
  assert.notEqual(state, RESTORE_STATE.COMPLETE);
});

test('tally without an unmatched argument keeps the old behaviour', () => {
  const { state } = tally([{ fieldId: 's', outcome: OUTCOME.SUCCEEDED, verified: true }]);
  assert.equal(state, RESTORE_STATE.COMPLETE);
});
