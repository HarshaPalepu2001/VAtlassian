import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harnessLog,
  timeAsync,
  withTrace,
  currentTraceId,
  sanitizeHarnessDetails,
  wrapWithHarness,
  HARNESS_CATEGORIES
} from '../src/lib/harnessLogger.js';
import { logAction, inspectIssue } from '../src/resolvers/harness.js';

test('harnessLog outputs structured logs with category tag and active trace', () => {
  const originalLog = console.log;
  let logged = '';
  console.log = msg => { logged = msg; };
  try {
    withTrace('trace-abc-123', () => {
      assert.equal(currentTraceId(), 'trace-abc-123');
      harnessLog('GATE', 'gate:allow', { issueKey: 'TEST-123', value: 42 });
    });
    assert.match(logged, /\[HARNESS:GATE\] gate:allow/);
    assert.match(logged, /"issueKey":"TEST-123"/);
    assert.match(logged, /"traceId":"trace-abc-123"/);
    assert.match(logged, /"value":42/);
  } finally {
    console.log = originalLog;
  }
});

test('sanitizeHarnessDetails redacts secrets and extracts Error metadata', () => {
  const sanitized = sanitizeHarnessDetails({
    code: '123456',
    token: 'secret-token-xyz',
    nested: {
      password: 'supersecret',
      normal: 'public-data'
    },
    error: new Error('Database connection failed')
  });

  assert.equal(sanitized.code, '[REDACTED_LEN_6]');
  assert.equal(sanitized.token, '[REDACTED_LEN_16]');
  assert.equal(sanitized.nested.password, '[REDACTED_LEN_11]');
  assert.equal(sanitized.nested.normal, 'public-data');
  assert.equal(sanitized.error.name, 'Error');
  assert.equal(sanitized.error.message, 'Database connection failed');
  assert.ok(sanitized.error.stack);
});

test('timeAsync profiles execution and emits structured duration log', async () => {
  const originalLog = console.log;
  let logged = '';
  console.log = msg => { logged = msg; };
  try {
    const res = await timeAsync('CAPTURE', 'capture:baseline', { issueKey: 'ENG-10' }, async () => {
      await new Promise(r => setTimeout(r, 10));
      return { baselineVersion: 2 };
    });
    assert.deepEqual(res, { baselineVersion: 2 });
    assert.match(logged, /\[HARNESS:CAPTURE\] capture:baseline/);
    assert.match(logged, /"success":true/);
    assert.match(logged, /"durationMs":/);
  } finally {
    console.log = originalLog;
  }
});

test('timeAsync catches error, logs failure with duration, and rethrows', async () => {
  const originalError = console.error;
  let logged = '';
  console.error = msg => { logged = msg; };
  try {
    await assert.rejects(
      () => timeAsync('RESTORE', 'restore:step', { issueKey: 'ENG-10' }, async () => {
        throw new Error('Jira API 500');
      }),
      /Jira API 500/
    );
    assert.match(logged, /\[HARNESS:RESTORE\] restore:step:failed/);
    assert.match(logged, /"success":false/);
    assert.match(logged, /"error":"Jira API 500"/);
  } finally {
    console.error = originalError;
  }
});

test('wrapWithHarness instruments resolver definitions with metrics', async () => {
  const originalLog = console.log;
  let logged = '';
  console.log = msg => { logged = msg; };
  try {
    const mockDefinitions = async (req) => {
      return { success: true, count: 5 };
    };
    const handler = wrapWithHarness(mockDefinitions, { resolverName: 'testResolver' });

    const result = await handler({
      call: { functionKey: 'test:fetchCount' },
      payload: { issueKey: 'ENG-99', traceId: 'tr-999' },
      context: { accountId: 'user-42' }
    });

    assert.deepEqual(result, { success: true, count: 5 });
    assert.match(logged, /\[HARNESS:RESOLVER\] resolver:test:fetchCount/);
    assert.match(logged, /"resolverName":"testResolver"/);
    assert.match(logged, /"issueKey":"ENG-99"/);
    assert.match(logged, /"accountId":"user-42"/);
    assert.match(logged, /"traceId":"tr-999"/);
    assert.match(logged, /"success":true/);
  } finally {
    console.log = originalLog;
  }
});

test('logAction resolver handles client action telemetry and propagates traceId', async () => {
  const result = await logAction({
    payload: {
      category: 'UI',
      action: 'click:requestChallenge',
      issueKey: 'PROJ-1',
      traceId: 'client-trace-77',
      details: { decision: 'APPROVE' }
    },
    context: { accountId: 'acc-123' }
  });

  assert.deepEqual(result, { ok: true });
});

test('inspectIssue requires issueKey or issueId', async () => {
  const result = await inspectIssue({ payload: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing issueKey/);
});

test('inspectIssue handles unresolvable numeric issue gracefully', async () => {
  const result = await inspectIssue({ payload: { issueKey: 'NONEXISTENT-99999' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not resolve numeric issue id/);
});

/** Every read inspectIssue can make, recorded; the issue itself as the caller sees it. */
function inspectDeps({ issueResponse, rows = {}, config = { enabled: true }, gated = [] }) {
  const reads = [];
  const record = (name, value) => async (...args) => { reads.push(name); return typeof value === 'function' ? value(...args) : value; };
  return {
    reads,
    deps: {
      readIssue: async key => { reads.push(['issue', key]); return issueResponse; },
      getReview: record('review', { state: 'BASELINED', drift_count: 0, version: 4 }),
      activeBaseline: record('baseline', { baseline_id: Buffer.alloc(16, 7), version: 2, approved_name: 'Ada' }),
      approvalHistory: record('approvals', []),
      restoresForIssue: record('restores', []),
      readTreeDrift: record('treeDrift', []),
      projectConfig: record('config', config),
      listGatedTransitions: record('gated', gated),
      query: async sql => {
        reads.push('sql');
        const table = Object.keys(rows).find(name => sql.includes(name));
        return table ? rows[table] : [];
      }
    }
  };
}

test('inspectIssue reads nothing about an issue the caller cannot browse', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps, reads } = inspectDeps({ issueResponse: { ok: false, status: 404 } });
  const result = await inspect({ payload: { issueKey: 'SECRET-1', issueId: 99 }, context: { accountId: 'u1' } }, deps);
  assert.equal(result.ok, false);
  assert.deepEqual(reads, [['issue', 'SECRET-1']], 'no stored record is read for an issue the caller cannot see');
});

test('inspectIssue reports the stored record, vault and controls for a browsable issue', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps } = inspectDeps({
    issueResponse: { ok: true, status: 200, json: async () => ({ id: '42', key: 'VAT-42',
      fields: { summary: 's', status: { name: 'Open' }, issuetype: { name: 'Story' }, project: { id: '10', key: 'VAT' } } }) },
    rows: {
      va_audit: [{ event_type: 'BASELINE_CAPTURED', actor_account_id: 'u1', payload: '{}', occurred_at: 1 }],
      va_vault_attachment: [{ jira_attachment_id: 'a-1', filename: 'spec.pdf', content_hash: 'h', storage: 'OBJECT_STORE', object_key: 'vault/sha256/h', vaulted_at: 6 }]
    },
    config: { enabled: false },
    gated: [{ state: 'ACTIVE', transition_id: '31', from_status_id: '1', to_status_id: '3', required_role: 'QA',
      required_assurance: 'ESIGNATURE', capture_baseline: true }, { state: 'REVOKED', transition_id: '41' }]
  });
  const result = await inspect({ payload: { issueKey: 'VAT-42' }, context: { accountId: 'u1' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.recentAudit.length, 1);
  assert.equal(result.vault.storage, 'OBJECT_STORE');
  assert.equal(result.vault.attachmentCount, 1);
  assert.equal(result.gateSimulation.projectDisabled, true);
  assert.equal(result.gateSimulation.activeControlledTransitions, 1);
  assert.equal(result.baseline.approverName, 'Ada');
});

function typedIssue({ typeId, typeName, statusId = '10034' }) {
  return { ok: true, status: 200, json: async () => ({ id: '44008', key: 'VAT-41',
    fields: { summary: 's', status: { id: statusId, name: 'In Review' }, issuetype: { id: typeId, name: typeName },
      project: { id: '11851', key: 'VAT' } } }) };
}
const taskRule = { state: 'ACTIVE', issue_type_id: '10004', transition_id: '2', from_status_id: '10034', to_status_id: '10000',
  required_role: 'Reviewer', required_assurance: 'BIOMETRIC', capture_baseline: 1 };
const storyRule = { ...taskRule, issue_type_id: '10007', required_assurance: 'ESIGNATURE' };

test('inspectIssue judges the item on the live check, not the stored counter the validator ignores', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps } = inspectDeps({ issueResponse: typedIssue({ typeId: '10007', typeName: 'Story' }), gated: [taskRule, storyRule] });
  deps.activeBaseline = async () => ({ baseline_id: Buffer.alloc(16, 7), version: 5, issue_type_id: '10004',
    required_assurance: 'BIOMETRIC', transition_id: '2' });
  deps.liveDrift = async () => ({
    scope: { source: 'own', issueTypeId: '10007', rootIssueId: 44008 }, issueTypeId: '10007',
    comparison: { changed: ['description', 'issuetype'], diagnostics: { cause: 'DIGEST_MISMATCH', digestSource: 'root-node',
      baselineReadable: true, fields: [{ field: 'description', baseline: 'aaaaaaaaaa', current: 'bbbbbbbbbb' }] } } });
  const result = await inspect({ payload: { issueKey: 'VAT-41' }, context: { accountId: 'u1' } }, deps);

  assert.equal(result.verdict, 'DRIFT_PENDING_REVIEW', 'stored counter 0 no longer reads HEALTHY');
  assert.equal(result.gateSimulation.driftSource, 'LIVE');
  assert.equal(result.gateSimulation.driftCount, 2);
  assert.equal(result.gateSimulation.storedDriftCount, 0);
  assert.equal(result.gateSimulation.counterDisagrees, true);
  assert.equal(result.gateSimulation.holdReason, 'UNDECIDED_DRIFT: DRIFT_OUTSTANDING');
  assert.deepEqual(result.liveDrift.changed, ['description', 'issuetype']);
  assert.equal(result.liveDrift.scope.source, 'own');
  assert.ok(result.remediations.some(text => /stored drift counter says clean/.test(text)));
});

test('inspectIssue names a type change and which rule now applies to the item', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps } = inspectDeps({ issueResponse: typedIssue({ typeId: '10007', typeName: 'Story' }), gated: [taskRule, storyRule] });
  deps.activeBaseline = async () => ({ baseline_id: Buffer.alloc(16, 7), version: 5, issue_type_id: '10004' });
  const result = await inspect({ payload: { issueKey: 'VAT-41' }, context: { accountId: 'u1' } }, deps);

  assert.deepEqual(result.typeCheck, { issueTypeId: '10007', issueTypeName: 'Story', baselineIssueTypeId: '10004',
    typeChangedSinceBaseline: true });
  const [task, story] = result.gateSimulation.applicableTransitions;
  assert.equal(task.requiredAssurance, 'BIOMETRIC');
  assert.equal(task.appliesToThisIssue, false, 'the Task rule does not apply to a Story');
  assert.equal(story.requiredAssurance, 'ESIGNATURE');
  assert.equal(story.appliesToThisIssue, true);
  assert.ok(result.remediations.some(text => /baseline was captured as type 10004/.test(text)));
});

test('an unreadable baseline is called out as a storage problem, not an edit to approve again', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps } = inspectDeps({ issueResponse: typedIssue({ typeId: '10004', typeName: 'Task' }), gated: [taskRule] });
  deps.liveDrift = async () => ({ scope: { source: 'own', issueTypeId: '10004' }, issueTypeId: '10004',
    comparison: { changed: ['description', 'summary'], diagnostics: { cause: 'BASELINE_UNREADABLE',
      digestSource: 'root-node-missing>baseline-row', baselineReadable: false, fields: [] } } });
  const result = await inspect({ payload: { issueKey: 'VAT-41' }, context: { accountId: 'u1' } }, deps);
  assert.equal(result.verdict, 'BASELINE_UNREADABLE');
  assert.ok(result.remediations.some(text => /approving again will not clear it/.test(text)));
});

test('a failing live check is reported, and the verdict says it rests on the stored counter', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps } = inspectDeps({ issueResponse: typedIssue({ typeId: '10004', typeName: 'Task' }), gated: [] });
  deps.liveDrift = async () => { throw new Error('Jira read failed (500)'); };
  const result = await inspect({ payload: { issueKey: 'VAT-41' }, context: { accountId: 'u1' } }, deps);
  assert.equal(result.liveDrift.checked, false);
  assert.equal(result.liveDrift.reason, 'LIVE_CHECK_FAILED');
  assert.equal(result.gateSimulation.driftSource, 'STORED_COUNTER');
  assert.ok(result.remediations.some(text => /live drift check could not run/.test(text)));
});

test('scripts/harness.mjs parser extracts structured event properties', async () => {
  const { parseHarnessEvent, matchesFilter, groupLogEntries, parseCliOptions } = await import('../scripts/harness.mjs');

  const line = '[HARNESS:GATE] gate:deny {"timestamp":"2026-09-26T12:00:00Z","issueKey":"ENG-12","reason":"UNDECIDED_DRIFT","traceId":"tr-456","durationMs":15}';
  const ev = parseHarnessEvent(line);

  assert.equal(ev.isHarness, true);
  assert.equal(ev.category, 'GATE');
  assert.equal(ev.action, 'gate:deny');
  assert.equal(ev.issueKey, 'ENG-12');
  assert.equal(ev.traceId, 'tr-456');
  assert.equal(ev.durationMs, 15);
  assert.equal(ev.level, 'ERROR');

  // Filtering tests
  assert.equal(matchesFilter(ev, { issue: 'ENG-12' }), true);
  assert.equal(matchesFilter(ev, { issue: 'OTHER-99' }), false);
  assert.equal(matchesFilter(ev, { category: 'GATE,RESTORE' }), true);
  assert.equal(matchesFilter(ev, { category: 'VAULT' }), false);
  assert.equal(matchesFilter(ev, { errors: true }), true);
  assert.equal(matchesFilter(ev, { action: '^gate:' }), true);
  assert.equal(matchesFilter(ev, { action: '^restore:' }), false);
  assert.equal(matchesFilter(ev, { trace: 'tr-456' }), true);

  // Grouping multi-line logs
  const rawLines = [
    'ERROR 2026-09-26T12:00:00Z Forge SQL Error',
    '    at Object.run (file:///app/db.js:10:5)',
    '    at process (node:internal:1:1)',
    '[HARNESS:VAULT] vault:copied {"issueKey":"ENG-12","filename":"doc.pdf"}'
  ];
  const groups = groupLogEntries(rawLines);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].level, 'ERROR');
  assert.ok(groups[0].raw.includes('at Object.run'));
  assert.equal(groups[1].category, 'VAULT');
  assert.equal(groups[1].issueKey, 'ENG-12');

  // CLI option parsing
  const opts = parseCliOptions(['tail', '25', '-i', 'ENG-12', '-c', 'GATE,VAULT', '-e', '--json']);
  assert.equal(opts.command, 'tail');
  assert.equal(opts.limit, 40);
  assert.equal(opts.positional[1], '25');
  assert.equal(opts.issue, 'ENG-12');
  assert.equal(opts.category, 'GATE,VAULT');
  assert.equal(opts.errors, true);
  assert.equal(opts.json, true);
});

test('the harness error filter keeps warning logs without a reason field', async () => {
  const { parseHarnessEvent, matchesFilter } = await import('../scripts/harness.mjs');
  const originalWarn = console.warn;
  let line = '';
  console.warn = value => { line = value; };
  try {
    harnessLog('ADMIN', 'workflow:unavailable', { issueKey: 'ENG-12' }, 'WARN');
  } finally {
    console.warn = originalWarn;
  }
  const event = parseHarnessEvent(line);
  assert.equal(event.level, 'WARN');
  assert.equal(matchesFilter(event, { errors: true }), true);
});

test('a truncated harness line does not crash log inspection', async () => {
  const { groupLogEntries } = await import('../scripts/harness.mjs');
  const events = groupLogEntries(['[HARNESS:GATE] ', '[HARNESS:GATE] gate:deny {"issueKey":"ENG-12"}']);
  assert.equal(events.length, 2);
  assert.equal(events[0].action, 'unknown');
  assert.equal(events[1].action, 'gate:deny');
});

// A missing viewer boundary would return protected child keys, digests and worker errors.
test('inspectIssue filters live child diagnostics and opaque restore/audit payloads for the viewer', async () => {
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { logicalNodeId } = await import('../src/lib/tree/model.js');
  const { deps } = inspectDeps({ issueResponse: typedIssue({ typeId: '10004', typeName: 'Task' }), rows: {
    va_baseline_node: [
      { logicalNodeId: logicalNodeId(11), currentIssueId: 11, issueKey: 'VAT-11' },
      { logicalNodeId: logicalNodeId(99), currentIssueId: 99, issueKey: 'SECRET-99' }
    ],
    va_baseline: [{ issue_id: 11, content_hash: 'visible-baseline' }, { issue_id: 99, content_hash: 'hidden-baseline' }],
    va_audit: [{ seq: 1, event_type: 'RESTORE_FAILED', payload: '{"error":"SECRET-99 hidden-value"}', occurred_at: 1 }]
  } });
  deps.filterViewableTree = async tree => ({ ...tree, nodes: tree.nodes.filter(n => String(n.id) === '11') });
  deps.findViewableIssues = async () => [];
  deps.readTreeDrift = async () => [
    { logicalNodeId: logicalNodeId(11), currentDigest: 'visible-current' },
    { logicalNodeId: logicalNodeId(99), currentDigest: 'hidden-current' },
    { logicalNodeId: logicalNodeId(777), issueId: 777, issueKey: 'NEW-777', currentDigest: 'hidden-new-current' }
  ];
  deps.restoresForIssue = async () => [{ restore_id: 'restore', state: 'PARTIAL', total_steps: 3, completed_steps: 1,
    last_error: 'SECRET-99 hidden-error', detail: [{
      unmatched: [{ issueKey: 'VAT-11', actual: 'visible-actual', fieldName: 'Summary' },
        { issueKey: 'SECRET-99', actual: 'hidden-value' }, { issueKey: 'NEW-777', actual: 'hidden-new-value' }],
      refused: [{ issueKey: 'SECRET-99', error: { detail: 'hidden-refusal' } }],
      verification: { changes: [{ logicalNodeId: logicalNodeId(99), to: 'hidden-change' }] },
      plan: { steps: [{ issueKey: 'SECRET-99', values: { summary: 'hidden-plan' } }] }
    }] }];
  const before = JSON.stringify(await deps.restoresForIssue());
  const result = await inspect({ payload: { issueKey: 'VAT-41' }, context: { accountId: 'u1' } }, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.childBaselines.map(row => row.issueId), [11]);
  assert.deepEqual(result.drift.items.map(row => row.currentDigest), ['visible-current']);
  assert.equal(result.restores[0].unmatched[0].actual, 'visible-actual');
  assert.equal(result.restores[0].totalSteps, 3);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-99|NEW-777|hidden-/);
  assert.equal(JSON.stringify(await deps.restoresForIssue()), before, 'projection does not alter authoritative records');
});

test('diagnostics do not expose nested opaque refusal errors or their copied verification reasons', async () => {
  const { opaqueRestoreEvidence, safeVerificationGuidance, assertOpaqueEvidenceHidden } = await import('./helpers/opaque-restore-evidence.js');
  const { inspectIssue: inspect } = await import('../src/usecases/harness.js');
  const { deps } = inspectDeps({ issueResponse: typedIssue({ typeId: '10004', typeName: 'Task' }) });
  const detail = opaqueRestoreEvidence('VAT-41', 44008);
  deps.restoresForIssue = async () => [{ restore_id: 'restore', state: 'PARTIAL', detail }];
  deps.filterViewableTree = async () => ({ nodes: [] });
  deps.findViewableIssues = async () => [];
  const result = await inspect({ payload: { issueKey: 'VAT-41' }, context: { accountId: 'u1' } }, deps);
  assert.equal(result.ok, true);
  assertOpaqueEvidenceHidden(assert, result);
  assert.equal(result.restores[0].unmatched[2].reason, safeVerificationGuidance);
  assert.ok(result.restores[0].refused[0].reason);
});
