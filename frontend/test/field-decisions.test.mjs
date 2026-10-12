import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, reset, swipe, key, summary, canSave, payload, blocked, prune } from '../src/review/fieldDecisions.ts';

const f = (fieldId, extra = {}) => ({ fieldId, restorable: 'YES', retained: true, ...extra });
const a = f('n1:a'), b = f('n1:b'), c = f('n2:c');
const FIELDS = [a, b, c];
const ready = { fields: FIELDS, mixed: { eligible: true, reason: null }, loading: false, error: '', held: false, eligible: true };

test('left to right rejects, right to left approves', () => {
  assert.deepEqual(swipe({}, a, 'ltr'), { 'n1:a': 'REJECT' });
  assert.deepEqual(swipe({}, a, 'rtl'), { 'n1:a': 'APPROVE' });
});

test('keyboard does what the swipe does: ArrowRight rejects, ArrowLeft approves, Escape and Backspace reset', () => {
  assert.deepEqual(key({}, a, 'ArrowRight'), swipe({}, a, 'ltr'));
  assert.deepEqual(key({}, a, 'ArrowLeft'), swipe({}, a, 'rtl'));
  assert.deepEqual(key({ 'n1:a': 'REJECT', 'n1:b': 'APPROVE' }, a, 'Escape'), { 'n1:b': 'APPROVE' });
  assert.deepEqual(key({ 'n1:a': 'REJECT' }, a, 'Backspace'), {});
  // Enter and Space only re-confirm a choice already made; they never invent one.
  assert.deepEqual(key({}, a, 'Enter'), {});
  assert.deepEqual(key({}, a, ' '), {});
  assert.deepEqual(key({ 'n1:a': 'APPROVE' }, a, 'Enter'), { 'n1:a': 'APPROVE' });
});

test('deciding is idempotent, does not mutate its input, and resetting an undecided field is a no-op', () => {
  const start = Object.freeze({ 'n1:a': 'APPROVE' });
  assert.deepEqual(decide(start, a, 'APPROVE'), { 'n1:a': 'APPROVE' });
  assert.deepEqual(decide(start, a, 'REJECT'), { 'n1:a': 'REJECT' });
  assert.deepEqual(reset(start, b), { 'n1:a': 'APPROVE' });
  assert.deepEqual(start, { 'n1:a': 'APPROVE' });
});

test('a field that cannot be put back cannot be rejected, but can be approved', () => {
  const kept = f('n1:k', { restorable: 'NOT_RETAINED', retained: false });
  const jira = f('n1:j', { restorable: 'NO' });
  assert.deepEqual(decide({}, kept, 'REJECT'), {}, 'state is unchanged');
  assert.deepEqual(swipe({}, jira, 'ltr'), {});
  assert.deepEqual(key({}, kept, 'ArrowRight'), {});
  assert.deepEqual(decide({}, kept, 'APPROVE'), { 'n1:k': 'APPROVE' });
  assert.match(blocked(kept), /not kept/i);
  assert.match(blocked(jira), /Jira/);
  assert.equal(blocked(a), null);
});

test('the summary counts every field and reads in words', () => {
  assert.deepEqual(summary(FIELDS, {}), { approve: 0, reject: 0, undecided: 3, text: '0 approve · 0 reject · 3 undecided' });
  const s = summary(FIELDS, { 'n1:a': 'APPROVE', 'n1:b': 'REJECT', 'n2:c': 'APPROVE' });
  assert.equal(s.text, '2 approve · 1 reject · 0 undecided');
  assert.equal(summary(FIELDS, { ghost: 'APPROVE' }).undecided, 3, 'a decision for a field no longer shown counts for nothing');
});

test('Save is enabled only when every field is decided and nothing else stands in the way', () => {
  const all = { 'n1:a': 'APPROVE', 'n1:b': 'REJECT', 'n2:c': 'APPROVE' };
  assert.equal(canSave({ ...ready, state: all }).enabled, true);
  const why = (over, state = all) => canSave({ ...ready, state, ...over });
  assert.match(why({}, { 'n1:a': 'APPROVE' }).reason, /2 fields? still need/);
  assert.equal(why({ loading: true }).enabled, false);
  assert.match(why({ error: 'boom' }).reason, /could not be loaded/i);
  assert.equal(why({ held: true }).enabled, false);
  assert.equal(why({ eligible: false }).enabled, false);
  assert.match(why({ mixed: { eligible: false, reason: 'STRUCTURE_CHANGED' } }).reason, /added, removed or moved/i);
  assert.match(why({ mixed: undefined }).reason, /not available/i);
  assert.equal(why({ fields: [] }, {}).enabled, false, 'nothing to decide');
});

test('Save refuses a rejection of a field that cannot be restored even if one slipped into the state', () => {
  const kept = f('n1:k', { restorable: 'NOT_RETAINED', retained: false });
  const result = canSave({ ...ready, fields: [kept], state: { 'n1:k': 'REJECT' } });
  assert.equal(result.enabled, false);
  assert.match(result.reason, /cannot be restored/i);
});

test('the payload is sorted exactly as the server sorts it, whatever order choices were made in', () => {
  const state = {}; // built in a scrambled order
  state['n2:c'] = 'REJECT'; state['n1:b'] = 'APPROVE'; state['n1:a'] = 'REJECT'; state.ghost = 'APPROVE';
  assert.deepEqual(payload(FIELDS, state), [
    { fieldId: 'n1:a', decision: 'REJECT' }, { fieldId: 'n1:b', decision: 'APPROVE' }, { fieldId: 'n2:c', decision: 'REJECT' }]);
  const upper = [f('B:x'), f('a:x')];
  assert.deepEqual(payload(upper, { 'B:x': 'APPROVE', 'a:x': 'APPROVE' }).map(d => d.fieldId), ['B:x', 'a:x'],
    'code-unit order, not locale order: it must equal the server\'s comparison');
  assert.deepEqual(payload(FIELDS, {}), [], 'an undecided field is never sent');
});

test('prune drops decisions for fields that are no longer in the review', () => {
  assert.deepEqual(prune({ 'n1:a': 'APPROVE', ghost: 'REJECT' }, FIELDS), { 'n1:a': 'APPROVE' });
});
