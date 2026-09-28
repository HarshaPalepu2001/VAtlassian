import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';
import { createRestoreAdapters } from '../src/lib/tree/restoreAdapters.js';
import { planRestore } from '../src/lib/restore/planner.js';
import { diffField } from '../src/lib/diff/fields.js';

const FIELDS = [
  { field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true },
  { field_id: 'attachment', field_name: 'Attachment', field_kind: 'ATTACHMENTS', store_values: true }
];
const spec = { id: '1', jiraId: '1', filename: 'spec.pdf' };
const added = { id: '3', jiraId: '3', filename: 'added.txt' };

test('a single issue\'s rejection names the files it deletes and the ones it re-uploads', () => {
  const attachment = diffField({ field: FIELDS[1], before: [spec], after: [added], retained: true });
  const plan = planRestore({ diff: { fields: [attachment] }, baselineValues: { attachment: [spec] },
    controlledFields: FIELDS, editmeta: {} });
  assert.deepEqual(plan.steps.map(s => [s.fieldId, s.strategy]), [['attachment', 'attachments']],
    'a dedicated handler, and no edit-screen check: files are not a field write');
  assert.deepEqual(plan.steps[0].targetValue, [spec]);
  assert.deepEqual(plan.fieldWrites, {});
  assert.deepEqual(plan.preflight.attachments, {
    willDelete: [{ id: '3', filename: 'added.txt' }], willRestore: [{ id: '1', filename: 'spec.pdf' }] });
});

function trees({ removeChild = false } = {}) {
  const baselineTree = {
    nodes: [
      { logicalNodeId: 'root', originalIssueId: 1, issueKey: 'T-1', parentLogicalId: null, digests: { summary: 's', attachment: 'A' } },
      { logicalNodeId: 'child', originalIssueId: 2, issueKey: 'T-2', parentLogicalId: 'root', digests: { summary: 's', attachment: 'B' } }
    ],
    values: { root: { summary: 's', attachment: [spec] }, child: { summary: 's', attachment: [{ id: '7', filename: 'child.pdf' }] } }
  };
  const currentTree = {
    nodes: [
      { logicalNodeId: 'root', currentIssueId: 1, issueKey: 'T-1', parentLogicalId: null, digests: { summary: 's', attachment: 'CHANGED' } },
      ...(removeChild ? [] : [{ logicalNodeId: 'child', currentIssueId: 2, issueKey: 'T-2', parentLogicalId: 'root', digests: { summary: 's', attachment: 'B' } }])
    ],
    values: { root: { summary: 's', attachment: [added] }, child: { summary: 's', attachment: [{ id: '7', filename: 'child.pdf' }] } }
  };
  return { baselineTree, currentTree, controlledFields: FIELDS };
}

test('a tree rejection restores files as their own step, never as a field write', () => {
  const plan = planTreeRestore(trees());
  assert.deepEqual(plan.steps.map(s => [s.kind, s.logicalNodeId]), [['RESTORE_ATTACHMENTS', 'root']]);
  assert.deepEqual(plan.steps[0].attachments, [spec]);
  assert.equal('current' in plan.steps[0], false, 'the live list is not persisted with the plan');
  assert.deepEqual(plan.preflight.attachments, {
    willDelete: [{ logicalNodeId: 'root', issueKey: 'T-1', id: '3', filename: 'added.txt' }],
    willRestore: [{ logicalNodeId: 'root', issueKey: 'T-1', id: '1', filename: 'spec.pdf' }] });
});

test('a recreated work item gets its files from the vault, then its fields', () => {
  const plan = planTreeRestore(trees({ removeChild: true }));
  const child = plan.steps.filter(s => s.logicalNodeId === 'child');
  assert.deepEqual(child.map(s => s.kind), ['CREATE_REPLACEMENT', 'RESTORE_ATTACHMENTS', 'RESTORE_FIELDS'],
    'files before fields: rich text that shows a file needs the file first');
  assert.deepEqual(Object.keys(child[2].fields), ['summary']);
  assert.deepEqual(plan.preflight.attachments.willRestore.map(f => `${f.issueKey}:${f.filename}`), ['T-1:spec.pdf', 'T-2:child.pdf']);
});

function journal(overrides = {}) {
  const state = { actions: [], replacements: overrides.replacements ?? [], attachmentCalls: [], ledger: [] };
  const adapters = {
    checkPermissions: async () => true,
    readRestoreActions: async () => state.actions.map(a => ({ ...a })),
    claimRestoreAction: async (_r, step) => { state.actions.push({ stepKey: step.stepKey, kind: step.kind, state: 'RUNNING' }); return true; },
    finishRestoreAction: async (_r, stepKey, success, detail) => {
      Object.assign(state.actions.find(a => a.stepKey === stepKey), { state: success ? 'COMPLETE' : 'FAILED', detail });
      return true;
    },
    readReplacements: async () => state.replacements,
    recordReplacement: async () => {},
    createIssue: async () => ({ newIssueId: 99, newIssueKey: 'T-99' }),
    editIssue: async () => {},
    restoreAttachments: async args => {
      state.attachmentCalls.push(args);
      if (overrides.attachmentError) throw overrides.attachmentError;
    },
    appendLedger: async (eventType) => state.ledger.push(eventType)
  };
  return { state, adapters };
}

test('the tree executor restores a recreated item\'s files onto the new item, from the original\'s vault', async () => {
  const { state, adapters } = journal({ replacements: [{ logicalNodeId: 'child', oldIssueId: 2, newIssueId: 99, newIssueKey: 'T-99' }] });
  const t = trees({ removeChild: true });
  const result = await executeTreeRestore({ restoreId: 'r1', rootIssueKey: 'T-1', ...t, fieldsFor: () => FIELDS, adapters });
  assert.equal(result.state, 'READY_TO_VERIFY');
  const childCall = state.attachmentCalls.find(c => c.issueKey === 'T-99');
  assert.deepEqual({ ...childCall, target: childCall.target.map(a => a.id) },
    { issueKey: 'T-99', issueId: 99, sourceIssueId: 2, target: ['7'] });
});

test('files the vault cannot supply are settled as refused, and the rest of the tree carries on', async () => {
  const refusal = Object.assign(new Error('spec.pdf: No copy of this file is in the vault'), { status: 422, detail: 'spec.pdf: No copy' });
  const { state, adapters } = journal({ attachmentError: refusal });
  const result = await executeTreeRestore({ restoreId: 'r1', rootIssueKey: 'T-1', ...trees(), fieldsFor: () => FIELDS, adapters });
  assert.equal(result.state, 'READY_TO_VERIFY', 'verification decides the outcome, and it will name the field');
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].kind, 'RESTORE_ATTACHMENTS');
  assert.equal(state.actions[0].detail.refused, true);
});

test('a system failure while restoring files stops the batch so the queue retries it', async () => {
  const { adapters } = journal({ attachmentError: Object.assign(new Error('Jira down'), { status: 503 }) });
  const result = await executeTreeRestore({ restoreId: 'r1', rootIssueKey: 'T-1', ...trees(), fieldsFor: () => FIELDS, adapters });
  assert.equal(result.stopped, true);
  assert.equal(result.remaining, 1);
});

test('a recreated work item is created without its attachment list, which Jira would refuse', async () => {
  let body;
  const api = { asApp: () => ({ requestJira: async (_path, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ id: '99', key: 'T-99' }) };
  } }) };
  const adapters = createRestoreAdapters({ api, route: (s, ...v) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '') });
  await adapters.createIssue('T-1', { projectId: 1, issueTypeId: '5' }, { summary: 's', attachment: [spec] });
  assert.equal('attachment' in body.fields, false);
  assert.equal(body.fields.summary, 's');
});
