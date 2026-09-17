import test from 'node:test';
import assert from 'node:assert/strict';
import { listGateFindings } from '../src/usecases/adminAlerts.js';
import { fixture, request } from './admin-fixture.js';

/**
 * CONTROL HEALTH — an active controlled transition with no exact transition id.
 *
 * gatedTransition() now matches on transition_id exactly (see
 * db/configStore.js), so a va_controlled_transition row saved before that id
 * was required can never match a live Jira transition again. It does not fail
 * loudly — it is simply never selected, which reads exactly like "nothing is
 * gated here" to everyone downstream. That is a silent configuration gap, not
 * a workflow drift finding gatecheck's diff already covers, so
 * listGateFindings() surfaces it directly from the table rather than waiting
 * to be told by a workflow comparison.
 */

test('an active controlled transition with no exact Jira transition id surfaces as a blocking health finding', async () => {
  const deps = fixture({
    query: (sql) => {
      if (sql.includes('FROM va_controlled_transition')) {
        return { result: true, data: [{ ct_id: 'aGVsbG8=', project_id: '1', issue_type_id: '10004',
          from_status_id: '3', to_status_id: '5', created_at: 1000 }] };
      }
      if (sql.includes('FROM va_gate_finding')) return { result: true, data: [] };
      return { result: true, data: [] };
    }
  });

  const result = await listGateFindings(request({}), deps);

  assert.equal(result.success, true);
  const finding = result.findings.find((f) => f.type === 'MISSING_TRANSITION_ID');
  assert.ok(finding, 'a controlled transition missing an exact transition id must be reported');
  assert.equal(finding.severity, 'CRITICAL');
  assert.equal(finding.projectKey, 'ONE');
});

test('a fully configured controlled transition does not surface a missing-transition-id finding', async () => {
  const deps = fixture({
    query: (sql) => {
      if (sql.includes('FROM va_controlled_transition')) return { result: true, data: [] };
      if (sql.includes('FROM va_gate_finding')) return { result: true, data: [] };
      return { result: true, data: [] };
    }
  });

  const result = await listGateFindings(request({}), deps);

  assert.equal(result.success, true);
  assert.equal(result.findings.some((f) => f.type === 'MISSING_TRANSITION_ID'), false);
});

test('a drift recall an administrator has to fix surfaces through the same admin health list', async () => {
  // db/incidentStore.js's recordRecallFinding() writes RECALL_* rows into
  // va_gate_finding using the same dedupe-key/last-seen shape gatecheck.js's
  // own findings use, specifically so a stuck recall shows up here without
  // adminAlerts.js needing to know anything about recall at all.
  const deps = fixture({
    query: (sql) => {
      if (sql.includes('FROM va_controlled_transition')) return { result: true, data: [] };
      if (sql.includes('FROM va_gate_finding')) {
        return { result: true, data: [{
          finding_key: 'RECALL:abc123:4:AMBIGUOUS_ROUTE', finding_type: 'RECALL_AMBIGUOUS_ROUTE', severity: 'WARNING',
          project_id: '1', issue_type_id: '10004', workflow_id: null, transition_id: null,
          from_status_id: '10426', to_status_id: '3',
          detail: JSON.stringify({ issueId: 42, offeredTransitionIds: ['301', '302'], hasScreen: false, jiraResponse: null }),
          first_seen_at: 1, last_seen_at: 2, cleared_at: null
        }] };
      }
      return { result: true, data: [] };
    }
  });

  const result = await listGateFindings(request({}), deps);

  assert.equal(result.success, true);
  const finding = result.findings.find((f) => f.type === 'RECALL_AMBIGUOUS_ROUTE');
  assert.ok(finding, 'a stuck recall must be reported as a health finding');
  assert.equal(finding.severity, 'WARNING');
  assert.equal(finding.findingKey, 'RECALL:abc123:4:AMBIGUOUS_ROUTE');
  assert.equal(JSON.parse(finding.detail).offeredTransitionIds.length, 2);
});

test('gatecheck workflow findings and missing-transition-id findings are both reported together', async () => {
  const deps = fixture({
    query: (sql) => {
      if (sql.includes('FROM va_controlled_transition')) {
        return { result: true, data: [{ ct_id: 'aGVsbG8=', project_id: '1', issue_type_id: '10004',
          from_status_id: '3', to_status_id: '5', created_at: 1000 }] };
      }
      if (sql.includes('FROM va_gate_finding')) {
        return { result: true, data: [{ finding_key: 'k1', finding_type: 'GATE_ABSENT', severity: 'CRITICAL',
          project_id: '1', issue_type_id: '10004', workflow_id: 'wf-1', transition_id: '101',
          from_status_id: '3', to_status_id: '4', detail: 'Missing validator', first_seen_at: 1, last_seen_at: 2, cleared_at: null }] };
      }
      return { result: true, data: [] };
    }
  });

  const result = await listGateFindings(request({}), deps);

  assert.equal(result.success, true);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map((f) => f.type).sort(), ['GATE_ABSENT', 'MISSING_TRANSITION_ID']);
});

test('wildcard workflow findings render all work item types', async () => {
  const deps = fixture({ query: sql => ({ result: true, data: sql.includes('FROM va_gate_finding') ? [{
    finding_key: 'k', finding_type: 'GATE_ABSENT', severity: 'CRITICAL', project_id: '1', issue_type_id: '*', workflow_id: 'wf', transition_id: '1',
    from_status_id: '*', to_status_id: '2', detail: 'missing', first_seen_at: 1, last_seen_at: 1, cleared_at: null
  }] : [] }) });
  const result = await listGateFindings(request({}), deps);
  assert.equal(result.findings[0].issueTypeName, 'All work item types');
});
