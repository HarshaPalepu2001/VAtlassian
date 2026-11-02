import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../src/gate.js';
const payload = { issue: { key: 'VAT-1' }, transition: { from: { id: '1' }, to: { id: '2' }, id: '11' } };
function gate(closureGuard) {
  return createGate({ now: () => 10, log() {}, audit: async () => ({}), pending: async () => null,
    load: async () => ({ issueId: 1, projectId: 100, issueTypeId: '7', driftCount: 0, item: {}, closureGuard }) });
}
for (const closureGuard of [{ error: true }, { verdict: 'DENIED', evaluationId: 'e1' }, { verdict: 'ALLOWED', auditConfirmed: false }]) {
  test(`governed closure refuses ${JSON.stringify(closureGuard)}`, async () => {
    const result = await gate(closureGuard)(payload);
    assert.equal(result.result, false);
    assert.match(result.errorMessage, /closure/i);
  });
}
test('a durable allowed closure evaluation clears the closure guard', async () => {
  assert.equal((await gate({ verdict: 'ALLOWED', auditConfirmed: true, evaluationId: 'e1' })(payload)).result, true);
});

test('ordinary Jira Bugs enrolled as sources receive the governed Done check', async () => {
  const { governedClosureGuard } = await import('../src/testmgmt/closureGuard.js');
  const result = await governedClosureGuard({ issue: { id: '1', key: 'VAT-1', fields: { project: { id: '100' }, issuetype: { id: '3' } } }, readStatusCategory: async () => 'done' },
    { listProjects: async () => [{ projectId: '100', enabled: true, testTypeId: '1', executionTypeId: '2', defectTypeId: '3' }],
      readGovernanceRecordsComplete: async () => ({ records: [], complete: false }) });
  assert.deepEqual(result, { error: true });
});
