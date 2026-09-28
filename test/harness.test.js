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
