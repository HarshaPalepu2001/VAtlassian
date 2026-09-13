/**
 * The admin transition picker's server-side discovery.
 *
 * admin:listWorkflowTransitions reads Jira's live workflow for one project +
 * work item type and hands back one row per real, exact edge, so the console
 * can offer a transition id instead of a from/to status guess (see
 * adminDirectory.js#listWorkflowTransitions and transitionsValidation.js's
 * "exact Jira transition" doc for why two transitions can share a
 * destination and must never collapse into one option).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { request } from './admin-fixture.js';
import { randomBytes } from 'node:crypto';

const APP_ID = 'app-under-test';
const gate = (extra = {}) => ({
  ruleKey: 'forge:expression-validator',
  parameters: { key: `ari:cloud:ecosystem::extension/${APP_ID}/env-1/static/va-gate`, ...extra }
});

/** A minimal fixture that bypasses adminDependencies entirely (adminRuntime.js
 *  returns `overrides` as-is when provided), so only the deps this resolver
 *  actually reads need to exist. */
function deps({ workflow, statuses = new Map(), unauthorized = false } = {}) {
  const calls = [];
  return {
    calls,
    runtimeAppId: () => APP_ID,
    lookupStatuses: async () => statuses,
    readWorkflowForPair: async (pair) => { calls.push(pair); return workflow; },
    executeQuery: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT account_id FROM va_admin WHERE account_id =')) {
        return { result: true, data: unauthorized ? [] : [{ account_id: params[0] }] };
      }
      return { result: true, data: [] };
    }
  };
}

const statusMap = () => new Map([
  ['10004', { id: '10004', name: 'To Do' }],
  ['3', { id: '3', name: 'In Progress' }],
  ['10006', { id: '10006', name: 'Done' }]
]);

test('the admin resolver rechecks admin authority rather than trusting the request', async () => {
  const result = await admin.listWorkflowTransitions(
    request({ projectId: '1', issueTypeId: '2' }),
    deps({ unauthorized: true, workflow: { id: 'wf', transitions: [] } })
  );
  assert.equal(result.success, false);
});

test('an exact project and work item type are required, not a wildcard', async () => {
  const d = deps({ workflow: { id: 'wf', transitions: [] } });
  for (const payload of [{ projectId: '1', issueTypeId: '*' }, { projectId: '', issueTypeId: '2' }, {}]) {
    const result = await admin.listWorkflowTransitions(request(payload), d);
    assert.equal(result.success, false);
  }
});

test('a failed live read is reported, never masqueraded as zero transitions', async () => {
  const result = await admin.listWorkflowTransitions(
    request({ projectId: '1', issueTypeId: '2' }),
    deps({ workflow: null })
  );
  assert.equal(result.success, false);
});

test('two transitions sharing a destination status remain two separate options', async () => {
  const workflow = {
    id: 'wf', name: 'Software workflow',
    transitions: [
      { id: '2', name: 'Done', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }], validators: [] },
      { id: '3', name: 'Sign', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '3' }], validators: [] }
    ]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  assert.equal(result.success, true);
  assert.equal(result.transitions.length, 2);
  assert.deepEqual(result.transitions.map(t => t.transitionId).sort(), ['2', '3']);
  assert.ok(result.transitions.every(t => t.toStatusId === '10006' && t.toStatusName === 'Done'));
});

test('a GLOBAL Jira transition is represented with fromStatusId "*"', async () => {
  const workflow = {
    id: 'wf', name: 'Software workflow',
    transitions: [{ id: '4', name: 'Any', type: 'GLOBAL', toStatusReference: '10004', links: [], validators: [] }]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  assert.equal(result.success, true);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].fromStatusId, '*');
  assert.equal(result.transitions[0].fromStatusName, 'Any status');
  assert.equal(result.transitions[0].global, true);
});

test('a DIRECTED transition reachable from two statuses becomes two exact edges', async () => {
  const workflow = {
    id: 'wf', name: 'wf',
    transitions: [{
      id: '9', name: 'Reopen', type: 'DIRECTED', toStatusReference: '10004',
      links: [{ fromStatusReference: '10006' }, { fromStatusReference: '3' }], validators: []
    }]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  assert.equal(result.transitions.length, 2);
  assert.deepEqual(result.transitions.map(t => t.fromStatusId).sort(), ['10006', '3'].sort());
  assert.ok(result.transitions.every(t => t.transitionId === '9'));
});

test('INITIAL transitions are never offered — issue creation has no from-status', async () => {
  const workflow = {
    id: 'wf', name: 'wf',
    transitions: [{ id: '1', name: 'Create', type: 'INITIAL', toStatusReference: '10004', links: [], validators: [] }]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  assert.equal(result.transitions.length, 0);
});

test('an edge with a screen reports hasScreen; one without does not', async () => {
  const workflow = {
    id: 'wf', name: 'wf',
    transitions: [
      { id: '2', name: 'Done', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }], validators: [], transitionScreen: { id: '10' } },
      { id: '3', name: 'Sign', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '3' }], validators: [] }
    ]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  assert.equal(result.transitions.find(t => t.transitionId === '2').hasScreen, true);
  assert.equal(result.transitions.find(t => t.transitionId === '3').hasScreen, false);
});

test('validatorAttached is true only for an enabled va-gate belonging to this app', async () => {
  const workflow = {
    id: 'wf', name: 'wf',
    transitions: [
      { id: '2', name: 'Ours, enabled', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }], validators: [gate()] },
      { id: '3', name: 'Ours, disabled', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '3' }], validators: [gate({ disabled: 'true' })] },
      { id: '4', name: 'Absent', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }], validators: [] },
      {
        id: '5', name: 'Someone else\'s', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }],
        validators: [{ ruleKey: 'forge:expression-validator', parameters: { key: 'ari:cloud:ecosystem::extension/other-app/env/static/va-gate' } }]
      }
    ]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  const byId = id => result.transitions.find(t => t.transitionId === id);
  assert.equal(byId('2').validatorAttached, true);
  assert.equal(byId('3').validatorAttached, false);
  assert.equal(byId('4').validatorAttached, false);
  assert.equal(byId('5').validatorAttached, false);
});

test('jiraRules summarizes other rules on the edge without hiding our own validator inside the count', async () => {
  const workflow = {
    id: 'wf', name: 'wf',
    transitions: [{
      id: '2', name: 'Done', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }],
      validators: [gate(), { ruleKey: 'system:check-permission-validator', parameters: {} }],
      conditions: { conditions: [{ ruleKey: 'system:permission' }] },
      postFunctions: [{ ruleKey: 'system:update-issue-status' }]
    }]
  };
  const result = await admin.listWorkflowTransitions(request({ projectId: '1', issueTypeId: '2' }), deps({ workflow, statuses: statusMap() }));
  const row = result.transitions[0];
  assert.equal(row.jiraRules.conditions, true);
  assert.equal(row.jiraRules.otherValidators, 1);
  assert.equal(row.jiraRules.postFunctions, 1);
});

test('a live read is scoped to exactly the requested project and work item type', async () => {
  const d = deps({ workflow: { id: 'wf', transitions: [] } });
  await admin.listWorkflowTransitions(request({ projectId: '7', issueTypeId: '42' }), d);
  assert.deepEqual(d.calls[1], { projectId: '7', issueTypeId: '42' });
});
