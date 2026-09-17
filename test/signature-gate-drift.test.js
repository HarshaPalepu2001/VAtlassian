/**
 * Gate drift detection.
 *
 * The workflow fixture below is the real shape returned by
 * POST /rest/api/3/workflows from a non-production Jira site,
 * captured 2026-08-31 — including the two GLOBAL transitions, which are the
 * part a naive comparison gets wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffWorkflow, groupByPair, isOurGate, isDisabled,
  transitionCovers, FINDING, SEVERITY, ANY_STATUS
} from '../src/lib/gateDrift.js';

const APP_ID = '62c59525-24c4-4af8-a821-0c7e3e0d185e';
const ENV_ID = '6a839a34-7d53-4334-b7d9-9ce97f4042cb';

const sigGate = (extra = {}) => ({
  ruleKey: 'forge:expression-validator',
  parameters: {
    key: `ari:cloud:ecosystem::extension/${APP_ID}/${ENV_ID}/static/va-gate`,
    config: '{"meaning":"Enforced"}',
    id: 'bd23b993-0359-45c1-b609-c285ce237ebe',
    ...extra
  }
});

const permissionValidator = {
  ruleKey: 'system:check-permission-validator',
  parameters: { permissionKey: 'CREATE_ISSUES' }
};

/** AP's workflow: To Do (10004), In Progress (3), Done (10006). */
function apWorkflow({ doneGate = sigGate(), signGate = sigGate(), extra = [] } = {}) {
  return {
    id: '74043c15-3171-404f-9514-d05af2c12857',
    name: 'Software Simplified Workflow for Project AP',
    transitions: [
      { id: '4', name: 'Any', type: 'GLOBAL', toStatusReference: '10004', links: [], validators: [] },
      { id: '5', name: 'In Progress', type: 'GLOBAL', toStatusReference: '3', links: [], validators: [] },
      { id: '1', name: 'Create', type: 'INITIAL', toStatusReference: '10004', links: [], validators: [permissionValidator] },
      {
        id: '2', name: 'Done', type: 'DIRECTED', toStatusReference: '10006',
        links: [{ fromStatusReference: '10004' }],
        validators: doneGate ? [doneGate] : []
      },
      {
        id: '3', name: 'Sign', type: 'DIRECTED', toStatusReference: '10006',
        links: [{ fromStatusReference: '3' }],
        validators: signGate ? [signGate] : []
      },
      ...extra
    ]
  };
}

const row = (from, to) => ({
  project_id: 10001, issue_type_id: '10007',
  from_status_id: from, to_status_id: to,
  required_role: 'QA', meaning: 'Enforced'
});

const bothRows = [row('10004', '10006'), row('3', '10006')];
const diff = (rows, workflow) => diffWorkflow({ rows, workflow, appId: APP_ID });

// --- identity ------------------------------------------------------------

test('our gate is recognised by app id and module key, ignoring environment', () => {
  assert.equal(isOurGate(sigGate(), { appId: APP_ID }), true);

  const otherEnv = {
    ruleKey: 'forge:expression-validator',
    parameters: { key: `ari:cloud:ecosystem::extension/${APP_ID}/a-different-env/static/va-gate` }
  };
  assert.equal(isOurGate(otherEnv, { appId: APP_ID }), true, 'a staging deploy of ourselves is still ours');
});

test('another vendor\'s Forge validator is not our gate', () => {
  const theirs = {
    ruleKey: 'forge:expression-validator',
    parameters: { key: 'ari:cloud:ecosystem::extension/99999999-0000-0000-0000-000000000000/env/static/their-rule' }
  };
  assert.equal(isOurGate(theirs, { appId: APP_ID }), false);
});

test('a different module of OUR app is not the gate', () => {
  const otherModule = {
    ruleKey: 'forge:expression-validator',
    parameters: { key: `ari:cloud:ecosystem::extension/${APP_ID}/${ENV_ID}/static/some-other-rule` }
  };
  assert.equal(isOurGate(otherModule, { appId: APP_ID }), false);
});

test('disabled is the string "true", and absent means enabled', () => {
  assert.equal(isDisabled(sigGate()), false, 'Jira omits the key entirely when enabled');
  assert.equal(isDisabled(sigGate({ disabled: 'false' })), false);
  assert.equal(isDisabled(sigGate({ disabled: 'true' })), true);
  assert.equal(isDisabled(sigGate({ disabled: true })), true);
});

// --- the healthy case ----------------------------------------------------

test('AP as it stands today produces no findings', () => {
  assert.deepEqual(diff(bothRows, apWorkflow()), []);
});

// --- the failure this whole job exists for -------------------------------

test('a detached validator is reported as GATE_ABSENT', () => {
  const findings = diff(bothRows, apWorkflow({ doneGate: null }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_ABSENT);
  assert.equal(findings[0].severity, SEVERITY.CRITICAL);
  assert.equal(findings[0].transitionId, '2');
});

test('a gate that is attached but switched off is CRITICAL, not clean', () => {
  const findings = diff(bothRows, apWorkflow({ signGate: sigGate({ disabled: 'true' }) }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_DISABLED);
  assert.equal(findings[0].severity, SEVERITY.CRITICAL);
  assert.equal(findings[0].transitionId, '3');
});

test('detaching both gates reports both edges, not just the first', () => {
  const findings = diff(bothRows, apWorkflow({ doneGate: null, signGate: null }));

  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.transitionId).sort(), ['2', '3']);
});

// --- the one a naive comparison misses -----------------------------------

test('an ungated GLOBAL transition into a controlled status is caught', () => {
  // A global transition can be taken from ANY status, so it is a route into
  // Done from the controlled origin and needs a gate regardless of from-status.
  const sneaky = {
    id: '9', name: 'Force done', type: 'GLOBAL',
    toStatusReference: '10006', links: [], validators: []
  };
  const findings = diff(bothRows, apWorkflow({ extra: [sneaky] }));

  assert.equal(findings.length, 2, 'one per controlled row the global route satisfies');
  assert.ok(findings.every((f) => f.type === FINDING.GATE_ABSENT));
  assert.ok(findings.every((f) => f.transitionId === '9'));
});

test('a second ungated DIRECTED route into a controlled status is a warning', () => {
  const sideDoor = {
    id: '8', name: 'Shortcut', type: 'DIRECTED',
    toStatusReference: '10006',
    links: [{ fromStatusReference: '99999' }],
    validators: []
  };
  const findings = diff(bothRows, apWorkflow({ extra: [sideDoor] }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_BYPASS_PATH);
  assert.equal(findings[0].severity, SEVERITY.WARNING);
});

// --- gates with nothing behind them --------------------------------------

test('a gate on an edge with no controlled row is GATE_ORPHANED', () => {
  // Only the To Do -> Done edge is controlled, but Sign still carries a gate.
  const findings = diff([row('10004', '10006')], apWorkflow());

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_ORPHANED);
  assert.equal(findings[0].transitionId, '3');
});

test('a controlled row naming an edge the workflow no longer has is GATE_ORPHANED', () => {
  // The row points at a status this workflow does not contain. That orphans
  // the ROW (no transition can satisfy it, transitionId null) and, because it
  // was the only ACTIVE row for this pair, it also orphans the two gates that
  // are still attached to Done and Sign — both of which would now deny with
  // NOT_CONFIGURED. All three are true and all three are worth telling the
  // admin, so assert the shape rather than a bare count.
  const findings = diff([row('10004', '55555')], apWorkflow());

  assert.ok(findings.every((f) => f.type === FINDING.GATE_ORPHANED));

  const staleRow = findings.filter((f) => f.transitionId === null);
  assert.equal(staleRow.length, 1, 'the unsatisfiable row itself');
  assert.equal(staleRow[0].toStatusId, '55555');

  const strandedGates = findings.filter((f) => f.transitionId !== null);
  assert.deepEqual(strandedGates.map((f) => f.transitionId).sort(), ['2', '3']);
});

// --- wildcards -----------------------------------------------------------

test('a wildcard row requires a gate on every route into the target', () => {
  const findings = diff([row(ANY_STATUS, '10006')], apWorkflow({ doneGate: null }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_ABSENT);
  assert.equal(findings[0].transitionId, '2');
});

test('INITIAL transitions are never controlled edges', () => {
  // Create lands on To Do; a wildcard row targeting To Do must not demand a
  // gate on issue creation, which has no from-status to control.
  const findings = diff([row(ANY_STATUS, '10004')], apWorkflow());
  assert.ok(!findings.some((f) => f.transitionId === '1'));
});

test('transitionCovers is false for a directed edge starting elsewhere', () => {
  const t = { id: '2', type: 'DIRECTED', toStatusReference: '10006', links: [{ fromStatusReference: '10004' }] };
  assert.equal(transitionCovers(t, row('3', '10006')), false);
  assert.equal(transitionCovers(t, row('10004', '10006')), true);
});

// --- keys and grouping ---------------------------------------------------

test('finding keys are stable across runs so first_seen_at survives', () => {
  const a = diff(bothRows, apWorkflow({ doneGate: null }));
  const b = diff(bothRows, apWorkflow({ doneGate: null }));
  assert.equal(a[0].key, b[0].key);
});

test('different edges produce different keys', () => {
  const findings = diff(bothRows, apWorkflow({ doneGate: null, signGate: null }));
  assert.equal(new Set(findings.map((f) => f.key)).size, 2);
});

test('rows group into one entry per project and issue type pair', () => {
  const groups = groupByPair([
    row('10004', '10006'),
    row('3', '10006'),
    { ...row('10004', '10006'), issue_type_id: '10008' },
    { ...row('10004', '10006'), project_id: 10002 }
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0].rows.length, 2, 'both AP/Task rows share one call');
});

test('an empty workflow read yields no findings rather than false alarms', () => {
  assert.deepEqual(diffWorkflow({ rows: bothRows, workflow: null, appId: APP_ID }), []);
});
