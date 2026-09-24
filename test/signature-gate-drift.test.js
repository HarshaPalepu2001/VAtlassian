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
import { pairsToCheck } from '../src/jobs/gatecheck.js';

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

/** A validator as saved by its setup screen: its configuration records the
 *  transition it sits on. Leaves an explicitly supplied config alone. */
const savedOn = (validator, transitionId) => {
  if (!validator) return validator;
  const config = JSON.parse(validator.parameters.config ?? '{}');
  if (config.transitionId !== undefined) return validator;
  return { ...validator, parameters: { ...validator.parameters, config: JSON.stringify({ ...config, transitionId }) } };
};

/** AP's workflow: To Do (10004), In Progress (3), Done (10006). The validator
 *  sits on every transition — on the two global ones only as the drift hold. */
function apWorkflow({ doneGate = sigGate(), signGate = sigGate(), anyGate = sigGate(), progressGate = sigGate(),
  extra = [] } = {}) {
  [doneGate, signGate, anyGate, progressGate] = [savedOn(doneGate, '2'), savedOn(signGate, '3'), savedOn(anyGate, '4'), savedOn(progressGate, '5')];
  return {
    id: '74043c15-3171-404f-9514-d05af2c12857',
    name: 'Software Simplified Workflow for Project AP',
    transitions: [
      { id: '4', name: 'Any', type: 'GLOBAL', toStatusReference: '10004', links: [], validators: anyGate ? [anyGate] : [] },
      { id: '5', name: 'In Progress', type: 'GLOBAL', toStatusReference: '3', links: [], validators: progressGate ? [progressGate] : [] },
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

test('a second DIRECTED route into a controlled status is a warning', () => {
  const sideDoor = {
    id: '8', name: 'Shortcut', type: 'DIRECTED',
    toStatusReference: '10006',
    links: [{ fromStatusReference: '99999' }],
    validators: [sigGate()]
  };
  const findings = diff(bothRows, apWorkflow({ extra: [sideDoor] }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_BYPASS_PATH);
  assert.equal(findings[0].severity, SEVERITY.WARNING);
});

test('an ungated side door is both unsigned and does not hold drift', () => {
  const sideDoor = {
    id: '8', name: 'Shortcut', type: 'DIRECTED',
    toStatusReference: '10006',
    links: [{ fromStatusReference: '99999' }],
    validators: []
  };
  const findings = diff(bothRows, apWorkflow({ extra: [sideDoor] }));

  assert.deepEqual(findings.map((f) => f.type).sort(), [FINDING.GATE_BYPASS_PATH, FINDING.HOLD_ABSENT]);
});

// --- the drift hold: the validator on every transition -------------------

test('a transition with no controlled row and no validator does not hold drift', () => {
  const findings = diff(bothRows, apWorkflow({ progressGate: null }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.HOLD_ABSENT);
  assert.equal(findings[0].severity, SEVERITY.CRITICAL);
  assert.equal(findings[0].transitionId, '5');
  assert.match(findings[0].detail, /does not carry the VAtlassian validator/);
});

test('a disabled validator on an uncontrolled transition does not hold drift either', () => {
  const findings = diff(bothRows, apWorkflow({ anyGate: sigGate({ disabled: 'true' }) }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.HOLD_ABSENT);
  assert.equal(findings[0].transitionId, '4');
  assert.match(findings[0].detail, /attached but disabled/);
});

test('a validator on a transition with no controlled row is the drift hold, not an orphan', () => {
  // Only To Do -> Done is controlled. Sign still carries the validator, which
  // there holds drift and asks for no signature. It is still an unsigned route
  // into a controlled status, which is what the admin needs to hear about.
  const findings = diff([row('10004', '10006')], apWorkflow());

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_BYPASS_PATH);
  assert.equal(findings[0].transitionId, '3');
});

test('an issue type with no controlled rows is not judged at all', () => {
  assert.deepEqual(diff([], apWorkflow({ anyGate: null, progressGate: null })), []);
});

test('INITIAL transitions never need the drift hold', () => {
  const findings = diff(bothRows, apWorkflow());
  assert.ok(!findings.some((f) => f.transitionId === '1'));
});

// --- rows with nothing behind them ---------------------------------------

test('a controlled row naming an edge the workflow no longer has is GATE_ORPHANED', () => {
  const findings = diff([row('10004', '55555')], apWorkflow());

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, FINDING.GATE_ORPHANED);
  assert.equal(findings[0].transitionId, null);
  assert.equal(findings[0].toStatusId, '55555');
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

// --- a pair with baselines but no controlled rows left --------------------
//
// Deleting every controlled transition does not release baselined items: the
// validator still holds them on drift, so the pair is still judged, for the
// drift hold alone.

const AP_PAIR = { project_id: 10001, issue_type_id: '10007' };

test('no rows but a scope: a transition without the validator is HOLD_ABSENT for that pair', () => {
  const findings = diffWorkflow({
    rows: [], scope: AP_PAIR, workflow: apWorkflow({ doneGate: null }), appId: APP_ID
  });

  assert.deepEqual(findings.map((f) => [f.type, f.transitionId]), [[FINDING.HOLD_ABSENT, '2']]);
  assert.equal(findings[0].severity, SEVERITY.CRITICAL);
  assert.equal(findings[0].projectId, 10001);
  assert.equal(findings[0].issueTypeId, '10007');
  assert.ok(!findings[0].key.includes('undefined'), findings[0].key);
});

test('no rows but a scope: a disabled validator is HOLD_ABSENT, and INITIAL is never judged', () => {
  const findings = diffWorkflow({
    rows: [], scope: AP_PAIR, workflow: apWorkflow({ anyGate: sigGate({ disabled: 'true' }) }), appId: APP_ID
  });
  assert.deepEqual(findings.map((f) => [f.type, f.transitionId]), [[FINDING.HOLD_ABSENT, '4']]);
});

test('no rows but a scope: nothing is controlled, so no GATE_ABSENT or GATE_BYPASS_PATH', () => {
  const findings = diffWorkflow({
    rows: [], scope: AP_PAIR, workflow: apWorkflow({ doneGate: null, signGate: null }), appId: APP_ID
  });
  assert.deepEqual(findings.map((f) => f.type), [FINDING.HOLD_ABSENT, FINDING.HOLD_ABSENT]);
  assert.deepEqual(findings.map((f) => f.transitionId), ['2', '3']);
});

test('no rows, a scope, and every transition carrying the validator: clean', () => {
  assert.deepEqual(diffWorkflow({ rows: [], scope: AP_PAIR, workflow: apWorkflow(), appId: APP_ID }), []);
});

test('no rows, a scope, and no workflow read: no findings', () => {
  assert.deepEqual(diffWorkflow({ rows: [], scope: AP_PAIR, workflow: null, appId: APP_ID }), []);
});

test('a scope missing half the pair yields nothing rather than an "undefined" key', () => {
  assert.deepEqual(diffWorkflow({
    rows: [], scope: { project_id: 10001 }, workflow: apWorkflow({ doneGate: null }), appId: APP_ID
  }), []);
});

test('a hold finding keeps its key when the controlled rows are deleted', () => {
  // Sign (3) is uncontrolled with only To Do -> Done controlled; its missing
  // validator is the same finding before and after that row goes away.
  const wf = apWorkflow({ signGate: null });
  const before = diff([row('10004', '10006')], wf).find((f) => f.type === FINDING.HOLD_ABSENT);
  const after = diffWorkflow({ rows: [], scope: AP_PAIR, workflow: wf, appId: APP_ID });
  assert.equal(after.length, 1);
  assert.equal(after[0].key, before.key);
});

test('with rows present, a scope changes nothing', () => {
  const wf = apWorkflow({ doneGate: null, anyGate: null });
  assert.deepEqual(
    diffWorkflow({ rows: bothRows, scope: { project_id: 999, issue_type_id: 'x' }, workflow: wf, appId: APP_ID }),
    diff(bothRows, wf)
  );
});

// --- which pairs the Health check reads ---------------------------------

test('pairsToCheck: rows only groups like groupByPair, with snake_case ids too', () => {
  const pairs = pairsToCheck({ rows: [row('10004', '10006'), row('3', '10006')], baselinePairs: [] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].projectId, 10001);
  assert.equal(pairs[0].issueTypeId, '10007');
  assert.equal(pairs[0].project_id, 10001);
  assert.equal(pairs[0].issue_type_id, '10007');
  assert.equal(pairs[0].rows.length, 2);
});

test('pairsToCheck: baselines only still yields a pair to check, with no rows', () => {
  const pairs = pairsToCheck({ rows: [], baselinePairs: [AP_PAIR, { project_id: 10002, issue_type_id: '10008' }] });
  assert.deepEqual(pairs, [
    { projectId: 10001, issueTypeId: '10007', project_id: 10001, issue_type_id: '10007', rows: [] },
    { projectId: 10002, issueTypeId: '10008', project_id: 10002, issue_type_id: '10008', rows: [] }
  ]);
});

test('pairsToCheck: a pair with both rows and baselines is read once, keeping its rows', () => {
  const pairs = pairsToCheck({
    rows: [row('10004', '10006'), row('3', '10006')],
    // The same project arriving as a string from the other table is the same pair.
    baselinePairs: [AP_PAIR, { project_id: '10001', issue_type_id: '10007' }, { project_id: 10002, issue_type_id: '10007' }]
  });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].rows.length, 2);
  assert.deepEqual(pairs[1].rows, []);
  assert.equal(pairs[1].project_id, 10002);
});

test('pairsToCheck: nothing controlled and nothing baselined means nothing to read', () => {
  assert.deepEqual(pairsToCheck({ rows: [], baselinePairs: [] }), []);
});

// --- the transition id saved by the validator's setup screen --------------

test('a validator whose saved id names another transition is a critical mismatch', () => {
  const findings = diff(bothRows, apWorkflow({ signGate: sigGate({ config: '{"transitionId":"2"}' }) }));
  assert.deepEqual(findings.map((f) => [f.type, f.transitionId, f.severity]),
    [[FINDING.GATE_CONFIG_MISMATCH, '3', SEVERITY.CRITICAL]]);
});

test('a missing saved id is reported only where a sibling shares start and destination', () => {
  const sibling = { id: '6', name: 'Done (fast)', type: 'DIRECTED', toStatusReference: '10006',
    links: [{ fromStatusReference: '10004' }], validators: [savedOn(sigGate(), '6')] };
  const unsaved = sigGate({ config: '{"transitionId":null}' });   // attached before ids were saved
  const findings = diff([...bothRows, row('10004', '10006')], apWorkflow({ doneGate: unsaved, extra: [sibling] }));
  assert.deepEqual(findings.map((f) => [f.type, f.transitionId, f.severity]),
    [[FINDING.GATE_CONFIG_MISSING, '2', SEVERITY.WARNING]]);
  // Sign also ends in Done but starts elsewhere: an unsaved id there changes nothing.
  assert.deepEqual(diff(bothRows, apWorkflow({ signGate: unsaved })), []);
});

test('a global transition is a sibling of every transition into the same status', () => {
  const global = { id: '7', name: 'Force done', type: 'GLOBAL', toStatusReference: '10006', links: [],
    validators: [sigGate({ config: '{}' })] };
  const findings = diff(bothRows, apWorkflow({ extra: [global] }));
  assert.ok(findings.some((f) => f.type === FINDING.GATE_CONFIG_MISSING && f.transitionId === '7'));
});

test('saved ids are read from the JSON Jira returns, and unreadable ones count as absent', async () => {
  const { savedTransitionId } = await import('../src/lib/gateDrift.js');
  assert.equal(savedTransitionId(sigGate({ config: '{"transitionId":"31"}' })), '31');
  assert.equal(savedTransitionId(sigGate({ config: '{"transitionId":31}' })), '31');
  for (const config of ['{}', 'not json', undefined, '{"transitionId":""}']) {
    assert.equal(savedTransitionId(sigGate({ config })), null, String(config));
  }
});
