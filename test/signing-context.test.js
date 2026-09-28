import test from 'node:test';
import assert from 'node:assert/strict';
import { createSigningUsecases } from '../src/usecases/signing.js';
import { BLOCKER } from '../src/lib/journey.js';

function fixture({ available, eligibleRoles = ['SDE-1'] } = {}) {
  const issue = {
    id: 10,
    key: 'VJIRA-7',
    fields: {
      summary: 'Bug with transition screening',
      project: { id: 10001 },
      issuetype: { id: '10004' },
      status: { id: '3', name: 'In-Review' }
    }
  };

  const defaultAvailable = [
    { id: '101', toStatusId: '4', name: 'Create Baseline', toStatusName: 'Selected for Development' },
    { id: '102', toStatusId: '5', name: 'Bug Done', toStatusName: 'Done' }
  ];

  const gatesMap = {
    '4': {
      from_status_id: '3',
      to_status_id: '4',
      required_assurance: 'ESIGNATURE',
      required_role: 'SDE-1',
      meaning: 'Approve development baseline',
      matched_any_status: false
    },
    '5': {
      from_status_id: '*',
      to_status_id: '5',
      required_assurance: 'BIOMETRIC',
      required_role: 'SDE-1',
      meaning: 'Bug Done',
      matched_any_status: true
    }
  };

  const deps = {
    load: async () => ({
      issue,
      actor: { accountId: 'actor-1', displayName: 'Engineer' },
      projectId: 10001,
      issueTypeId: '10004',
      fields: [],
      evidenceHash: 'evidence-hash-1'
    }),
    availableTransitions: async () => available ?? defaultAvailable,
    gatedTransition: async ({ toStatusId, transitionId }) => (transitionId != null ? gatesMap[toStatusId] ?? null : null),
    isEligible: async ({ role }) => eligibleRoles.includes(role)
  };

  return { deps, issue, gatesMap };
}

test('at In-Review, surface: esignature-field, actor holds SDE-1 -> exactly one action (Create Baseline), Done is absent', async () => {
  const f = fixture({ eligibleRoles: ['SDE-1'] });
  const usecase = createSigningUsecases(f.deps);
  const result = await usecase.signingContext({ payload: { surface: 'esignature-field', transitionId: '101' }, context: { accountId: 'actor-1' } });

  assert.equal(result.blocker, null);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].transitionId, '101');
  assert.equal(result.actions[0].toStatusId, '4');
  assert.equal(result.actions[0].meaning, 'Approve development baseline');
  assert.equal(result.actions[0].requiredAssurance, 'ESIGNATURE');
});

test('at In-Review, surface: device-field, actor holds SDE-1 -> exactly one action (Done edge)', async () => {
  const f = fixture({ eligibleRoles: ['SDE-1'] });
  const usecase = createSigningUsecases(f.deps);
  const result = await usecase.signingContext({ payload: { surface: 'device-field', transitionId: '102' }, context: { accountId: 'actor-1' } });

  assert.equal(result.blocker, null);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].transitionId, '102');
  assert.equal(result.actions[0].toStatusId, '5');
  assert.equal(result.actions[0].meaning, 'Bug Done');
  assert.equal(result.actions[0].requiredAssurance, 'BIOMETRIC');
});

test('at In-Review, surface: esignature-field, actor does NOT hold SDE-1 -> no actions, blocker NOT_ELIGIBLE_FOR_RULE', async () => {
  // On the Create Baseline transition screen, only the ESIGNATURE edge applies
  const f = fixture({
    available: [{ id: '101', toStatusId: '4', name: 'Create Baseline', toStatusName: 'Selected for Development' }],
    eligibleRoles: []
  });
  const usecase = createSigningUsecases(f.deps);
  const result = await usecase.signingContext({ payload: { surface: 'esignature-field', transitionId: '101' }, context: { accountId: 'actor-1' } });

  assert.equal(result.actions.length, 0);
  assert.equal(result.blocker, BLOCKER.NOT_ELIGIBLE_FOR_RULE);
  assert.equal(result.requiredRole, 'SDE-1');
});

test('a status where only a BIOMETRIC rule applies, surface: esignature-field -> no actions, blocker WRONG_FIELD_FOR_RULE', async () => {
  const f = fixture({
    available: [{ id: '102', toStatusId: '5', name: 'Bug Done', toStatusName: 'Done' }],
    eligibleRoles: ['SDE-1']
  });
  const usecase = createSigningUsecases(f.deps);
  const result = await usecase.signingContext({ payload: { surface: 'esignature-field', transitionId: '102' }, context: { accountId: 'actor-1' } });

  assert.equal(result.actions.length, 0);
  assert.equal(result.blocker, BLOCKER.WRONG_FIELD_FOR_RULE);
});

// Forge's issue-transition custom field context carries Jira's exact
// issueTransition.id, and the field is expected to pass it straight through.
// A caller that omits it must be refused outright rather than falling back to
// "every gated transition out of this status", which is exactly the ambiguity
// that let one field sign the wrong sibling transition.
test('transition screen refuses a missing exact transition id', async () => {
  const result = await createSigningUsecases(fixture().deps).signingContext({
    payload: { surface: 'device-field' }, context: { accountId: 'actor-1' }
  });
  assert.equal(result.reason, 'TRANSITION_ID_REQUIRED');
});

test('unresolved live drift outranks transition configuration and exposes no signing action', async () => {
  const f = fixture({ available: [] });
  const originalLoad = f.deps.load;
  f.deps.load = async () => ({
    ...await originalLoad(),
    baseline: { baseline_id: Buffer.alloc(16, 1), field_digests: '{}' },
    config: { enabled: true }
  });
  let transitionReads = 0;
  f.deps.availableTransitions = async () => { transitionReads += 1; return []; };
  f.deps.baselineDrift = async () => ({ changed: ['summary', 'description'], contentHash: 'current-hash' });

  const result = await createSigningUsecases(f.deps).signingContext({
    payload: { surface: 'device-field', transitionId: '101' }, context: { accountId: 'actor-1' }
  });

  assert.equal(result.blocker, 'UNDECIDED_DRIFT');
  assert.deepEqual(result.actions, []);
  assert.equal(result.drift.count, 2);
  assert.equal(result.drift.blocked, true);
  assert.equal(transitionReads, 0, 'drift is an item-level hold and must win before edge resolution');
});

test('a disabled project does not advertise a drift hold that its validator will not enforce', async () => {
  const f = fixture({ eligibleRoles: ['SDE-1'] });
  const originalLoad = f.deps.load;
  f.deps.load = async () => ({
    ...await originalLoad(),
    baseline: { baseline_id: Buffer.alloc(16, 1), field_digests: '{}' },
    config: { enabled: false }
  });
  f.deps.baselineDrift = async () => ({ changed: ['summary'], contentHash: 'current-hash' });

  const result = await createSigningUsecases(f.deps).signingContext({
    payload: { surface: 'device-field', transitionId: '102' }, context: { accountId: 'actor-1' }
  });

  assert.notEqual(result.blocker, 'UNDECIDED_DRIFT');
  assert.equal(result.drift.blocked, false);
});

// The signing screen (src/ui-kit/edit.jsx) renders issue.assignee,
// issue.reporter, issue.issueTypeName and issue.description* directly from
// this resolver's response. Dropping them here does not make the field
// "stale" — it makes it wrong: the signer sees "Unassigned" / "Unknown" /
// a blank description regardless of the work item's actual current values,
// which is exactly the attestation-content mismatch a signature is supposed
// to prevent.
test('signing context carries the current assignee, reporter, issue type and description through to the signer', async () => {
  const f = fixture({
    available: [{ id: '101', toStatusId: '4', name: 'Create Baseline', toStatusName: 'Selected for Development' }]
  });
  f.issue.fields.issuetype.name = 'Bug';
  f.issue.fields.assignee = { displayName: 'Ada Lovelace' };
  f.issue.fields.reporter = { displayName: 'Grace Hopper' };
  f.issue.fields.description = { content: [{ type: 'paragraph', content: [{ text: 'Real current description.' }] }] };

  const usecase = createSigningUsecases(f.deps);
  const result = await usecase.signingContext({ payload: { surface: 'esignature-field', transitionId: '101' }, context: { accountId: 'actor-1' } });

  assert.equal(result.issue.issueTypeName, 'Bug');
  assert.equal(result.issue.assignee.displayName, 'Ada Lovelace');
  assert.equal(result.issue.reporter.displayName, 'Grace Hopper');
  assert.equal(result.issue.description, 'Real current description.');
  assert.equal(result.issue.descriptionEmpty, false);
});
