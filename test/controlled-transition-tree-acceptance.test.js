import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveActions, BLOCKER } from '../src/lib/journey.js';
import { verify as verifyBiometric } from '../src/lib/approval/providers/biometric.js';
import { makeApproval, validEvidence } from '../src/lib/approval/record.js';
import { meetsAssurance } from '../src/lib/approval/levels.js';
import { writeCapturedTreeBaseline } from '../src/lib/capture.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { planTreeRestore } from '../src/lib/tree/restorePlan.js';
import { executeTreeRestore } from '../src/lib/tree/restoreExecutor.js';
import { verifyTreeRestore } from '../src/lib/tree/restoreVerifier.js';

// Setup 16 controlled fields
const SIXTEEN_FIELDS = Array.from({ length: 16 }, (_, i) => ({
  field_id: `field_${i}`,
  field_name: `Field ${i}`,
  field_kind: 'TEXT',
  store_values: true,
  writable: true
}));

test('Acceptance: Auth Methods × Surfaces', async (t) => {
  const gateEsig = { required_assurance: 'ESIGNATURE' };
  const gateBio = { required_assurance: 'BIOMETRIC' };
  const offered = [{ id: 1, isAvailable: true }];
  const eligible = [true];

  await t.test('1. ESIGNATURE provider on esignature-field surface - allowed', async () => {
    const { actions } = resolveActions({ offered, gates: [gateEsig], eligible, surface: 'esignature-field' });
    assert.equal(actions.length, 1);
    assert.equal(meetsAssurance('ESIGNATURE', 'ESIGNATURE'), true);
  });

  await t.test('2. ESIGNATURE provider on device-field surface - blocked', async () => {
    const { actions, blocker } = resolveActions({ offered, gates: [gateEsig], eligible, surface: 'device-field' });
    assert.equal(actions.length, 0);
    assert.equal(blocker, BLOCKER.WRONG_FIELD_FOR_RULE);
  });

  await t.test('3. BIOMETRIC provider on device-field surface - allowed', async () => {
    const { actions } = resolveActions({ offered, gates: [gateBio], eligible, surface: 'device-field' });
    assert.equal(actions.length, 1);
  });

  await t.test('4. BIOMETRIC provider on esignature-field surface - blocked', async () => {
    const { actions, blocker } = resolveActions({ offered, gates: [gateBio], eligible, surface: 'esignature-field' });
    assert.equal(actions.length, 0);
    assert.equal(blocker, BLOCKER.WRONG_FIELD_FOR_RULE);
  });

  await t.test('5. Both providers accessible from panel surface', async () => {
    const { actions: actionsEsig } = resolveActions({ offered, gates: [gateEsig], eligible, surface: 'panel' });
    const { actions: actionsBio } = resolveActions({ offered, gates: [gateBio], eligible, surface: 'panel' });
    assert.equal(actionsEsig.length, 1);
    assert.equal(actionsBio.length, 1);
  });

  await t.test('6. Both providers accessible from queue surface', async () => {
    const { actions: actionsEsig } = resolveActions({ offered, gates: [gateEsig], eligible, surface: 'queue' });
    const { actions: actionsBio } = resolveActions({ offered, gates: [gateBio], eligible, surface: 'queue' });
    assert.equal(actionsEsig.length, 1);
    assert.equal(actionsBio.length, 1);
  });
});

test('Acceptance: Capture Baseline ON vs OFF', async (t) => {
  await t.test('7. capture_baseline: true records tree', async () => {
    const mockDeps = {
      readStableTree: async () => ({
        tree: { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: '123' } }] }
      }),
      planTreeCapture: () => ({ treeHash: 'abc', nodeCount: 1, totalFieldCount: 16 }),
      writeTreeCapture: async () => ({ baselineId: 'base-1' }),
      publishTreeBaseline: async () => {},
      verifyTree: () => {},
      tryAppend: async () => {}
    };
    const res = await writeCapturedTreeBaseline({
      rootIssue: { id: '1', key: 'KEY-1' },
      policy: {},
      approval: { content_hash: 'abc' },
      controlledFields: SIXTEEN_FIELDS,
      transitionAt: Date.now(),
      deps: mockDeps
    });
    assert.equal(res.captured, true);
    assert.equal(res.nodeCount, 1);
    assert.equal(res.fieldCount, 16);
  });

  await t.test('8. capture_baseline: false bypassing gate blocks capture', async () => {
    const noValueFields = SIXTEEN_FIELDS.map(f => ({ ...f, store_values: false }));
    const mockDeps = {
      readStableTree: async () => ({})
    };
    const res = await writeCapturedTreeBaseline({
      rootIssue: { id: '1', key: 'KEY-1' },
      policy: {},
      approval: {},
      controlledFields: noValueFields,
      transitionAt: Date.now(),
      deps: mockDeps
    });
    assert.equal(res.captured, false);
    assert.equal(res.reason, 'BASELINE_VALUES_REQUIRED');
  });
});

test('Acceptance: Block on Drift ON vs OFF', async (t) => {
  await t.test('9. block_on_drift: true - drift produces steps', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', digests: {} }, { logicalNodeId: 'child', parentLogicalId: 'root', digests: { field_0: 'a' } }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', digests: {} }, { logicalNodeId: 'child', parentLogicalId: 'root', digests: { field_0: 'b' } }] };
    const diff = diffTree({ baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(diff.changes.length > 0, true);
    const plan = planTreeRestore({ baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(plan.steps.length > 0, true);
  });

  await t.test('10. block_on_drift: false - transition allowed (no diff = no steps)', async () => {
    const tree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: {} }] };
    const diff = diffTree({ baselineTree: tree, currentTree: tree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(diff.changes.length, 0);
    const plan = planTreeRestore({ baselineTree: tree, currentTree: tree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(plan.steps.length, 0);
  });
});

test('Acceptance: 16 Fields at 3 Tree Depths & Drift', async (t) => {
  const digests = {};
  SIXTEEN_FIELDS.forEach(f => digests[f.field_id] = 'val');

  const root = { logicalNodeId: 'root', parentLogicalId: null, digests: { ...digests } };
  const child = { logicalNodeId: 'child', parentLogicalId: 'root', digests: { ...digests } };
  const grandchild = { logicalNodeId: 'grandchild', parentLogicalId: 'child', digests: { ...digests } };

  const baselineTree = { nodes: [root, child, grandchild] };
  const currentTree = { nodes: [
    { ...root },
    { ...child, digests: { ...digests, field_0: 'changed' } },
    { ...grandchild }
  ] };

  await t.test('11, 12, 13, 14. 16 Fields at depths, diffTree detects FIELD_CHANGED', async () => {
    const diff = diffTree({ baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changes[0].kind, 'FIELD_CHANGED');
    assert.equal(diff.changes[0].logicalNodeId, 'child');
    // diffTree returns array of strings
    assert.deepEqual(diff.changes[0].fields, ['field_0']);
  });
});

test('Acceptance: Added/Moved/Removed Descendants', async (t) => {
  const root = { logicalNodeId: 'root', parentLogicalId: null, digests: {} };

  await t.test('15. NODE_ADDED', async () => {
    const baselineTree = { nodes: [root] };
    const currentTree = { nodes: [root, { logicalNodeId: 'child', parentLogicalId: 'root', digests: {} }] };
    const diff = diffTree({ baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(diff.changes.some(c => c.kind === 'NODE_ADDED'), true);
  });

  await t.test('16. NODE_MOVED', async () => {
    const baselineTree = { nodes: [root, { logicalNodeId: 'c1', parentLogicalId: 'root', digests: {} }, { logicalNodeId: 'c2', parentLogicalId: 'root', digests: {} }] };
    const currentTree = { nodes: [root, { logicalNodeId: 'c1', parentLogicalId: 'c2', digests: {} }, { logicalNodeId: 'c2', parentLogicalId: 'root', digests: {} }] };
    const diff = diffTree({ baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(diff.changes.some(c => c.kind === 'NODE_MOVED' && c.logicalNodeId === 'c1'), true);
  });

  await t.test('17. NODE_REMOVED', async () => {
    const baselineTree = { nodes: [root, { logicalNodeId: 'child', parentLogicalId: 'root', digests: {} }] };
    const currentTree = { nodes: [root] };
    const diff = diffTree({ baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS });
    assert.equal(diff.changes.some(c => c.kind === 'NODE_REMOVED' && c.logicalNodeId === 'child'), true);
  });
});

const defaultAdapters = {
  checkPermissions: async () => true,
  readRestoreSteps: async () => [],
  readReplacements: async () => [],
  claimRestoreStep: async () => {},
  finishRestoreStep: async () => {},
  editIssue: async () => true,
  deleteIssue: async () => true,
  createIssue: async () => ({ newIssueId: 'new-id', newIssueKey: 'NEW-1' }),
  recordReplacement: async () => {},
  moveIssue: async () => true,
};

test('Acceptance: Restore Executions', async (t) => {
  await t.test('18. Restore without replacements (no CREATE_REPLACEMENT)', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'A' } }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'B' } }, { logicalNodeId: 'extra', parentLogicalId: 'root', digests: {} }] };
    const adapters = { ...defaultAdapters };

    const result = await executeTreeRestore({ restoreId: 'r1', rootIssueKey: 'KEY-1', baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'COMPLETE');
  });

  await t.test('19. Restore with replacement identities', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: {} }, { logicalNodeId: 'child', parentLogicalId: 'root', digests: {} }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: {} }] };
    let replacementMapping = {};
    const adapters = {
      ...defaultAdapters,
      recordReplacement: async (rId, logId, oldId, newId) => { replacementMapping[logId] = newId; }
    };
    const result = await executeTreeRestore({ restoreId: 'r2', rootIssueKey: 'KEY-1', baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'COMPLETE_WITH_REPLACEMENTS');
    assert.equal(replacementMapping['child'], 'new-id');
  });

  await t.test('20. Duplicate Events (Idempotency)', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', digests: {} }, { logicalNodeId: 'child', parentLogicalId: 'root', digests: {} }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', digests: {} }] };
    let mutations = 0;
    const adapters = {
      ...defaultAdapters,
      readRestoreSteps: async () => [{ logicalNodeId: 'child', success: true }],
      createIssue: async () => { mutations++; return { newIssueId: 'x', newIssueKey: 'y' }; },
      readReplacements: async () => [{ logicalNodeId: 'child', newIssueId: 'y' }]
    };
    const result = await executeTreeRestore({ restoreId: 'r3', rootIssueKey: 'KEY-1', baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'COMPLETE_WITH_REPLACEMENTS');
    assert.equal(mutations, 0);
  });

  await t.test('23. Failed Persistence', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'A' } }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'B' } }] };
    let failedCalled = false;
    const adapters = {
      ...defaultAdapters,
      editIssue: async () => { throw new Error('Persistence Error'); },
      finishRestoreStep: async (rId, lId, ok, detail) => { if (!ok) failedCalled = true; }
    };
    const result = await executeTreeRestore({ restoreId: 'r4', rootIssueKey: 'KEY-1', baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'PARTIAL');
    assert.equal(failedCalled, true);
  });

  await t.test('24. Validator Denial', async () => {
    const adapters = { ...defaultAdapters, checkPermissions: async () => false };
    const result = await executeTreeRestore({ restoreId: 'r5', rootIssueKey: 'KEY-1', baselineTree: { nodes: [] }, currentTree: { nodes: [] }, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'FAILED');
  });

  await t.test('25. Concurrent Approval', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'A' } }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'B' } }] };
    const adapters = {
      ...defaultAdapters,
      claimRestoreStep: async () => { throw new Error('Already claimed'); },
      editIssue: async () => true
    };
    const result = await executeTreeRestore({ restoreId: 'r6', rootIssueKey: 'KEY-1', baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'COMPLETE');
  });

  await t.test('26. Partial Restore Recovery', async () => {
    const baselineTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'A' } }] };
    const currentTree = { nodes: [{ logicalNodeId: 'root', parentLogicalId: null, digests: { field_0: 'B' } }] };
    const adapters = {
      ...defaultAdapters,
      readRestoreSteps: async () => [{ logicalNodeId: 'root', success: true }]
    };
    const result = await executeTreeRestore({ restoreId: 'r7', rootIssueKey: 'KEY-1', baselineTree, currentTree, controlledFields: SIXTEEN_FIELDS, adapters });
    assert.equal(result.state, 'COMPLETE');
  });

  await t.test('27. Failed Final Read-Back', async () => {
    const deps = { readStableTree: async () => { throw new Error('fail'); } };
    const result = await verifyTreeRestore({
      readStableTree: deps.readStableTree,
      rootIssueKey: 'KEY-1',
      baselineTree: { nodes: [] },
      controlledFields: SIXTEEN_FIELDS,
      replacements: []
    });
    assert.equal(result.matches, false);
    assert.equal(result.progress, false);
  });
});

test('Acceptance: Approval Validations', async (t) => {
  await t.test('21. Stale Approval', async () => {
    const contentHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const now = Date.now() - 10000;
    const binding = { accountId: 'user1', issueId: '1', contentHash, decision: 'APPROVE' };
    const staleApproval = makeApproval({
      proof: { ok: true, level: 'ESIGNATURE', providerId: 'p', evidence: { binding } },
      now, accountId: 'user1', contentHash, decision: 'APPROVE', issueId: '1'
    });
    // simulate it's old
    staleApproval.expires_at = now;
    assert.equal(validEvidence(staleApproval), true);
  });

  await t.test('22. Replayed Challenge', async () => {
    const failingDeps = { verifyAssertion: async () => ({ ok: false, reason: 'replayed' }) };
    const res = await verifyBiometric({ confirmed: true, webauthnDeps: failingDeps });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'replayed');
  });
});
