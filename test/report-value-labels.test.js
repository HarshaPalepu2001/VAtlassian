import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload } from '../src/lib/report.js';

const field = extra => ({ driftIds: ['d1'], fieldName: 'Priority', fieldId: 'priority', kind: 'scalar', materiality: 'CRITICAL',
  semanticChange: true, attribution: [], summary: 'Priority changed', ...extra });

// The differ compares Jira identifiers, so a priority change reaches the report
// as "4" → "1". The panel resolves them through valueLabels; the AI summary was
// given the bare ids and told reviewers "priority raised from 4 to 1".
test('the AI summary is given the names behind identifiers, with the identifiers kept', () => {
  const payload = buildPayload({ issue: { key: 'VAT-69', fields: {} }, baseline: { version: 5 }, diff: { timeline: [],
    fields: [field({ before: '4', after: '1', valueLabels: { 4: 'Low', 1: 'Highest' } })] } });
  assert.equal(payload.changes[0].before, 'Low (id 4)');
  assert.equal(payload.changes[0].after, 'Highest (id 1)');
});

test('lists of identifiers are named item by item, and unlabelled values are unchanged', () => {
  const payload = buildPayload({ issue: { key: 'VAT-1', fields: {} }, baseline: { version: 1 }, diff: { timeline: [],
    fields: [field({ fieldName: 'Components', fieldId: 'components', kind: 'set', before: ['10', '11'], after: ['10'],
      valueLabels: { 10: 'API' } }), field({ fieldName: 'Summary', fieldId: 'summary', kind: 'text', before: 'old', after: 'new' })] } });
  assert.equal(payload.changes[0].before, '["API (id 10)","11"]');
  assert.equal(payload.changes[1].after, 'new');
});
