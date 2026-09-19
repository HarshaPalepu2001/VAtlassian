import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessLog } from '../src/lib/harnessLogger.js';
import { logAction, inspectIssue } from '../src/resolvers/harness.js';

test('harnessLog outputs structured logs with category tag', () => {
  const originalLog = console.log;
  let logged = '';
  console.log = msg => { logged = msg; };
  try {
    harnessLog('TEST', 'testAction', { issueKey: 'TEST-123', value: 42 });
    assert.match(logged, /\[HARNESS:TEST\] testAction/);
    assert.match(logged, /"issueKey":"TEST-123"/);
    assert.match(logged, /"value":42/);
  } finally {
    console.log = originalLog;
  }
});

test('logAction resolver handles client action telemetry', async () => {
  const result = await logAction({
    payload: {
      category: 'UI',
      action: 'click:requestChallenge',
      issueKey: 'PROJ-1',
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
