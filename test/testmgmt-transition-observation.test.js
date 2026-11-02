import test from 'node:test';
import assert from 'node:assert/strict';

test('completed transition observations never infer evaluation linkage from time', async () => {
  const { observeGovernedTransition } = await import('../src/testmgmt/governanceObservation.js');
  let saved;
  const deps = { now: () => 123, isGovernedSource: async () => true, insertObservedTransition: async r => { saved = r; return true; },
    audit: async () => ({ seq: 2, entryHash: 'a'.repeat(64) }), confirmObservedTransition: async () => true };
  const result = await observeGovernedTransition({ id: 'event1', atlassianId: 'actor', issue: { id: '1', key: 'VAT-1' } },
    { from: { id: '10' }, to: { id: '20' }, transitionId: '11', source: 'changelog' }, deps);
  assert.equal(result.observed, true);
  assert.equal(saved.content.evaluationId, null);
  assert.equal(saved.content.correlation, 'NOT_ESTABLISHED');
  assert.equal(saved.content.toStatusId, '20');
});

test('an observation is not published without durable audit confirmation', async () => {
  const { observeGovernedTransition } = await import('../src/testmgmt/governanceObservation.js');
  await assert.rejects(observeGovernedTransition({ id: 'event1', issue: { id: '1', key: 'VAT-1' } },
    { from: { id: '10' }, to: { id: '20' } }, { now: () => 123, isGovernedSource: async () => true,
      insertObservedTransition: async () => true, audit: async () => { throw new Error('offline'); } }), /offline/);
});

test('duplicate Jira transition events reuse the confirmed observation', async () => {
  const { observeGovernedTransition } = await import('../src/testmgmt/governanceObservation.js');
  let saved, auditCalls = 0;
  const deps = { now: () => 123, isGovernedSource: async () => true,
    insertObservedTransition: async r => { saved ??= r; return true; }, readObservedTransition: async () => saved,
    audit: async () => { auditCalls++; return { seq: auditCalls, entryHash: 'a'.repeat(64) }; },
    confirmObservedTransition: async ({ proof }) => { saved.auditProof = proof; return true; } };
  const event = { id: 'event1', issue: { id: '1', key: 'VAT-1' } }, transition = { from: { id: '10' }, to: { id: '20' } };
  const first = await observeGovernedTransition(event, transition, deps);
  assert.deepEqual(await observeGovernedTransition(event, transition, deps), first);
  assert.equal(auditCalls, 1);
});
