import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalUsecases } from '../src/usecases/approval.js';
import crypto from 'node:crypto';
import { createGate } from '../src/gate.js';

function fixture() {
  const rows = [], events = [];
  const challenges = new Map();
  const issue = { issueId: 10, issueKey: 'T-10', projectId: 1, issueTypeId: '1', statusId: '1' };
  const deps = {
    now: () => 1700000000000, issue: async () => issue, actor: async id => ({ accountId: id, displayName: 'Name' }),
    edge: async () => ({ required_assurance: 'ESIGNATURE', required_role: 'reviewer', meaning: 'Approve', capture_baseline: true, block_on_drift: true }),
    eligible: async () => true, transition: async () => ({ id: '5', toStatusId: '2' }),
    prepare: async () => ({ contentHash: 'a'.repeat(64), evidenceHash: 'e'.repeat(64), baselineVersion: 1, driftCount: 0 }),
    apply: async () => ({ success: true }), record: async row => rows.push(row), audit: async event => events.push(event),
    activate: async ({ approvalId, state }) => { rows.find(r => r.approval_id.equals(approvalId)).state = state; return true; },
    invalidate: async ({ approvalId }) => {
      const row = rows.find(r => r.approval_id.equals(approvalId));
      if (row?.state === 'PENDING') row.state = 'VOID';
      return row?.state === 'VOID';
    },
    performTransition: async (_issue, _transition, row) => { row.state = 'CONSUMED'; return { transitioned: true }; },
    byId: async id => rows.find(r => r.approval_id.equals(id)),
    totpDeps: {
      now: () => 1700000000000,
      consume: async () => true, fail: async () => true, audit: async () => {}, alert: async () => {}, activate: async () => true
    },
    writeChallenge: async row => {
      const challengeId = Buffer.alloc(16, 4);
      challenges.set(challengeId.toString('hex'), { ...row, challenge_id: challengeId });
      return challengeId;
    },
    getChallenge: async challengeId => challenges.get(challengeId.toString('hex')) ?? null,
    markChallengeConsumed: async challengeId => {
      const row = challenges.get(challengeId.toString('hex'));
      if (!row || row.state !== 'PENDING') return false;
      row.state = 'CONSUMED';
      return true;
    }
  };
  const request = { context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', transitionId: '5', decision: 'APPROVE', confirmed: true, preauthorize: true, accountId: 'spoof', code: '007787' } };
  
  // Actually, I can just use a fixed key.
  const fixedKey = Buffer.alloc(32, 2);
  deps.totpDeps.key = () => fixedKey;
  deps.totpDeps.read = async () => {
    const crypto = await import('node:crypto');
    const secret = Buffer.alloc(20, 1);
    const iv = Buffer.alloc(16, 3);
    const cipher = crypto.createCipheriv('aes-256-gcm', fixedKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { state: 'ACTIVE', algo: 'TOTP-SHA1', digits: 6, period_seconds: 30, key_version: 1, version: 1, ciphertext, iv, tag };
  };
  
  return { deps, rows, events, request, challenges };
}

/** Sign as every client does: open a challenge for the request, then answer it. */
async function signed(deps, request) {
  const api = createApprovalUsecases(deps);
  const challenge = await api.challenge(request);
  assert.equal(challenge.success, true, JSON.stringify(challenge));
  return api.submit({ context: request.context, payload: { ...request.payload, challengeId: challenge.challengeId } });
}

function baselineDecisionPrepared(overrides = {}) {
  const baselineId = Buffer.alloc(16, 9);
  return {
    contentHash: 'a'.repeat(64),
    evidenceHash: 'e'.repeat(64),
    baselineVersion: 4,
    driftCount: 2,
    review: { state: 'DRIFTED' },
    baseline: {
      baseline_id: baselineId,
      version: 4,
      content_hash: 'b'.repeat(64),
      transition_id: '5',
      from_status_id: '1',
      to_status_id: '2',
      required_role: 'baseline-reviewer',
      required_assurance: 'ESIGNATURE',
      controlled_fields_hash: 'c'.repeat(64)
    },
    approvalPolicy: {
      transition_id: '5',
      from_status_id: '1',
      to_status_id: '2',
      required_role: 'baseline-reviewer',
      required_assurance: 'ESIGNATURE',
      meaning: 'Approve changes against baseline v4',
      capture_baseline: true,
      block_on_drift: true
    },
    ...overrides
  };
}
test('challenge response contains the nonce, meaning and expiry the UI must display', async () => {
  const f = fixture();
  const result = await createApprovalUsecases(f.deps).challenge(f.request);
  assert.equal(result.success, true);
  assert.equal(result.challengeId, '04'.repeat(16));
  assert.match(result.nonce, /^[a-f0-9]{64}$/);
  assert.equal(result.meaning, 'Approve');
  assert.equal(result.expiresAt, 1700000300000);
  const stored = f.challenges.get(result.challengeId);
  assert.equal(stored.issue_id, 10);
  assert.equal(stored.signer_account_id, 'trusted');
  assert.equal(stored.candidate_hash, 'a'.repeat(64));
});
test('electronic signature challenge completes with an authenticator code and no preauthorize shortcut', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({ context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '007787' } });
  assert.equal(result.success, true);
  assert.equal(f.rows[0].state, 'CONSUMED');
});

test('biometric challenge records a WebAuthn-backed approval through the same approval row', async () => {
  const f = fixture();
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, required_assurance: 'BIOMETRIC' });
  let totpSpent = false;
  f.deps.totpDeps.consume = async () => { totpSpent = true; return true; };
  f.deps.webauthnDeps = {
    verifyAssertion: async ({ binding, payload, approvalChallengeId }) => {
      assert.equal(binding.accountId, 'trusted');
      assert.equal(binding.issueId, 10);
      assert.equal(binding.decision, 'APPROVE');
      assert.equal(binding.contentHash, 'a'.repeat(64));
      assert.equal(payload.challengeId, 'webauthn-challenge');
      assert.deepEqual(approvalChallengeId, Buffer.alloc(16, 4), 'the device check names the challenge it answers');
      return {
        ok: true,
        credentialId: 'credential-1',
        assertionAssurance: 'DEVICE_BOUND_UV',
        rpId: 'app.cdn.prod.atlassian-dev.net',
        origin: 'https://app.cdn.prod.atlassian-dev.net',
        verifiedAt: f.deps.now()
      };
    }
  };
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({
    context: { accountId: 'trusted' },
    payload: {
      issueKey: 'T-10',
      challengeId: challenge.challengeId,
      confirmed: true,
      webauthn: { challengeId: 'webauthn-challenge', response: { id: 'credential-1' } }
    }
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(totpSpent, false);
  assert.equal(f.rows[0].assurance_level, 'BIOMETRIC');
  assert.equal(f.rows[0].provider_id, 'webauthn');
  assert.equal(JSON.parse(f.rows[0].provider_evidence).method, 'SESSION_AND_WEBAUTHN');
});

test('biometric workflow approval after an existing baseline uses the current transition policy', async () => {
  const f = fixture();
  f.request.payload.transitionId = '7';
  f.request.payload.intent = 'WORKFLOW';
  delete f.request.payload.code;
  f.deps.issue = async () => ({ issueId: 10, issueKey: 'T-10', projectId: 1, issueTypeId: '1', statusId: '3' });
  const currentPolicy = {
    required_assurance: 'BIOMETRIC', required_role: 'reviewer', meaning: 'Assigned for Development',
    capture_baseline: false, block_on_drift: true
  };
  f.deps.transition = async (_issue, requested) => String(requested.transitionId) === '7'
    ? { id: '7', toStatusId: '4' } : { id: '5', toStatusId: '2' };
  f.deps.edge = async (_issue, transition) => String(transition?.id) === '7'
    ? currentPolicy : { ...currentPolicy, required_assurance: 'ESIGNATURE', transition_id: '5' };
  const prepared = baselineDecisionPrepared({
    driftCount: 0,
    review: { state: 'BASELINED' },
    approvalPolicy: currentPolicy,
    gate: currentPolicy
  });
  const prepareCalls = [];
  f.deps.prepare = async options => { prepareCalls.push(options); return { ...prepared }; };
  let totpSpent = false;
  f.deps.totpDeps.consume = async () => { totpSpent = true; return true; };
  f.deps.webauthnDeps = {
    verifyAssertion: async ({ binding, payload }) => {
      assert.equal(binding.transitionId, '7');
      assert.equal(binding.fromStatusId, '3');
      assert.equal(binding.toStatusId, '4');
      assert.equal(payload.challengeId, 'current-device-challenge');
      return {
        ok: true, credentialId: 'credential-1', assertionAssurance: 'DEVICE_BOUND_UV',
        rpId: 'app.cdn.prod.atlassian-dev.net', origin: 'https://app.cdn.prod.atlassian-dev.net', verifiedAt: f.deps.now()
      };
    }
  };

  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  assert.equal(challenge.success, true, JSON.stringify(challenge));
  const result = await api.submit({ context: f.request.context, payload: {
    issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true,
    webauthn: { challengeId: 'current-device-challenge', response: { id: 'credential-1' } }
  } });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(totpSpent, false);
  assert.equal(f.rows[0].transition_id, '7');
  assert.equal(f.rows[0].assurance_level, 'BIOMETRIC');
  assert.ok(prepareCalls.length >= 2);
  assert.ok(prepareCalls.every(call => call.forTransition === true), 'every workflow read must use transition authority');
});

for (const decision of ['APPROVE', 'REJECT']) {
  test(`drift ${decision.toLowerCase()} follows the biometric assurance frozen in the baseline`, async () => {
    const f = fixture();
    delete f.request.payload.transitionId;
    f.request.payload.decision = decision;
    f.request.payload.preauthorize = false;
    const prepared = baselineDecisionPrepared();
    prepared.baseline.required_assurance = 'BIOMETRIC';
    prepared.approvalPolicy = {
      ...prepared.approvalPolicy,
      required_assurance: 'BIOMETRIC',
      meaning: `${decision === 'REJECT' ? 'Reject changes and restore' : 'Approve changes against'} baseline v4`
    };
    f.deps.prepare = async () => prepared;
    let webauthnChecked = false;
    f.deps.webauthnDeps = {
      verifyAssertion: async ({ binding, payload }) => {
        webauthnChecked = true;
        assert.equal(binding.decision, decision);
        assert.equal(payload.challengeId, 'webauthn-challenge');
        return {
          ok: true,
          credentialId: 'credential-1',
          assertionAssurance: 'DEVICE_BOUND_UV',
          rpId: 'app.cdn.prod.atlassian-dev.net',
          origin: 'https://app.cdn.prod.atlassian-dev.net',
          verifiedAt: f.deps.now()
        };
      }
    };

    const api = createApprovalUsecases(f.deps);
    const challenge = await api.challenge(f.request);
    assert.equal(challenge.success, true, JSON.stringify(challenge));
    assert.equal(challenge.requiredAssurance, 'BIOMETRIC');
    assert.equal(challenge.meaning, prepared.approvalPolicy.meaning);

    const result = await api.submit({
      context: { accountId: 'trusted' },
      payload: {
        issueKey: 'T-10',
        challengeId: challenge.challengeId,
        confirmed: true,
        webauthn: { challengeId: 'webauthn-challenge', response: { id: 'credential-1' } }
      }
    });

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(webauthnChecked, true);
    assert.equal(f.rows[0].assurance_level, 'BIOMETRIC');
    assert.equal(f.rows[0].provider_id, 'webauthn');
    // REJECT carries the baseline edge, because the restore reads it to decide
    // where the approved content belongs. APPROVE ratifies content in place and
    // is bound to no edge at all.
    assert.equal(f.rows[0].transition_id, decision === 'REJECT' ? '5' : null);
    assert.equal(f.rows[0].meaning, prepared.approvalPolicy.meaning);
  });
}

test('drift challenge ignores injected transition and policy facts and resolves no edge at all', async () => {
  const f = fixture();
  f.request.payload.intent = 'DRIFT';
  f.request.payload.transitionId = '999';
  f.request.payload.toStatusId = '999';
  f.request.payload.requiredRole = 'attacker';
  f.request.payload.requiredAssurance = 'BIOMETRIC';
  f.deps.prepare = async () => baselineDecisionPrepared();
  const requestedTransitions = [];
  f.deps.transition = async (_issue, payload) => {
    requestedTransitions.push({ ...payload });
    if (String(payload.transitionId) !== '5') return { id: String(payload.transitionId), toStatusId: '999' };
    return { id: '5', toStatusId: '2' };
  };

  const challenge = await createApprovalUsecases(f.deps).challenge(f.request);

  assert.equal(challenge.success, true, JSON.stringify(challenge));
  assert.equal(challenge.meaning, 'Approve changes against baseline v4');
  assert.equal(challenge.requiredAssurance, 'ESIGNATURE');
  // The injected transitionId 999 is ignored, and so is the baseline's own edge:
  // approving drift asks Jira for nothing, so there is no edge to hijack.
  assert.deepEqual(requestedTransitions, []);
  assert.equal(f.challenges.get(challenge.challengeId).transition_id, null);
});

// WORKFLOW intent, because that is now the only decision that calls Jira. The
// property under test is unchanged: an approval on an item that already has a
// baseline is voided when Jira refuses, never left behind as retryable.
test('a refused Jira transition invalidates the approval of an item that has a baseline, and it cannot be retried', async () => {
  const f = fixture();
  f.request.payload.intent = 'WORKFLOW';
  f.request.payload.preauthorize = false;
  f.deps.prepare = async () => baselineDecisionPrepared();
  f.deps.transition = async (_issue, payload) => {
    assert.equal(payload.transitionId, '5');
    return { id: '5', toStatusId: '2' };
  };
  f.deps.apply = async () => ({ success: true, capture: { captured: true }, baselinePublished: true });
  let transitionAttempts = 0;
  f.deps.performTransition = async () => {
    transitionAttempts += 1;
    return { transitioned: false, transitionError: 'Jira refused the transition.' };
  };

  const result = await signed(f.deps, f.request);

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.baselinePublished, true);
  assert.equal(result.transitioned, false);
  assert.equal(result.retryableApprovalId, null);
  assert.equal(f.rows[0].state, 'VOID');
  const retry = await createApprovalUsecases(f.deps).retryTransition({
    context: f.request.context,
    payload: { issueKey: 'T-10', approvalId: result.approvalId }
  });
  assert.equal(retry.success, false);
  assert.equal(retry.reason, 'NO_DECISION');
  assert.equal(transitionAttempts, 1);
});

test('a newer active baseline invalidates the earlier drift challenge before proof is spent', async () => {
  const f = fixture();
  delete f.request.payload.transitionId;
  let prepared = baselineDecisionPrepared();
  f.deps.prepare = async () => prepared;
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  prepared = baselineDecisionPrepared({ baselineVersion: 5 });
  prepared.baseline.version = 5;
  prepared.baseline.baseline_id = Buffer.alloc(16, 10);
  prepared.approvalPolicy = { ...prepared.approvalPolicy,
    meaning: 'Approve changes against baseline v5' };
  let proofSpent = false;
  f.deps.totpDeps.consume = async () => { proofSpent = true; return true; };

  const result = await api.submit({ context: f.request.context, payload: {
    issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '007787'
  } });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'CONTENT_CHANGED');
  assert.equal(proofSpent, false);
  assert.equal(f.rows.length, 0);
});

test('role membership is rechecked at drift submit against the role frozen in the baseline', async () => {
  const f = fixture();
  delete f.request.payload.transitionId;
  f.deps.prepare = async () => baselineDecisionPrepared();
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const checkedRoles = [];
  f.deps.eligible = async ({ role }) => { checkedRoles.push(role); return false; };

  const result = await api.submit({ context: f.request.context, payload: {
    issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '007787'
  } });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'NOT_ELIGIBLE');
  assert.deepEqual(checkedRoles, ['baseline-reviewer']);
  assert.equal(f.rows.length, 0);
});

test('baseline publication and capability audit finish before the exact Jira transition is called', async () => {
  const f = fixture();
  // WORKFLOW intent: approving drift no longer calls Jira, so the ordering this
  // guards is now only reachable through a workflow action.
  f.request.payload.intent = 'WORKFLOW';
  f.request.payload.preauthorize = false;
  f.deps.prepare = async () => baselineDecisionPrepared();
  const order = [];
  f.deps.record = async row => { order.push('record'); f.rows.push(row); };
  f.deps.audit = async event => { if (event.eventType === 'APPROVAL_RECORDED') order.push('audit'); };
  f.deps.apply = async () => { order.push('publish'); return {
    success: true, capture: { captured: true }, baselinePublished: true
  }; };
  f.deps.activate = async ({ approvalId, state }) => {
    order.push('capability');
    f.rows.find(row => row.approval_id.equals(approvalId)).state = state;
    return true;
  };
  f.deps.performTransition = async () => { order.push('jira'); return { transitioned: true }; };

  const result = await signed(f.deps, f.request);

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.baselinePublished, true);
  assert.deepEqual(order, ['record', 'audit', 'publish', 'capability', 'jira']);
});

test('failed N+1 publication never calls Jira and leaves the approval unusable', async () => {
  const f = fixture();
  delete f.request.payload.transitionId;
  f.request.payload.preauthorize = false;
  f.deps.prepare = async () => baselineDecisionPrepared();
  f.deps.apply = async () => ({ success: false, capture: { captured: false } });
  let jiraCalled = false;
  f.deps.performTransition = async () => { jiraCalled = true; return { transitioned: true }; };

  const result = await signed(f.deps, f.request);

  assert.equal(result.success, false);
  assert.equal(jiraCalled, false);
  assert.equal(f.rows[0].state, 'VOID');
});
test('challenge submit rejects content that changed after the challenge was created', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  f.deps.prepare = async () => ({ contentHash: 'b'.repeat(64), evidenceHash: 'f'.repeat(64), baselineVersion: 1, driftCount: 0 });
  let consumed = false;
  f.deps.markChallengeConsumed = async () => { consumed = true; return true; };
  const result = await api.submit({ context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'CONTENT_CHANGED');
  assert.equal(f.rows.length, 0);
  assert.equal(consumed, false);
});
test('a transition without baseline capture cannot bypass blocking drift', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, capture_baseline: false });
  const challenge = await api.challenge(f.request);
  f.deps.prepare = async () => ({ contentHash: 'a'.repeat(64), evidenceHash: 'e'.repeat(64), baselineVersion: 1, driftCount: 1 });
  let consumed = false;
  f.deps.markChallengeConsumed = async () => { consumed = true; return true; };
  const result = await api.submit({ context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'UNDECIDED_DRIFT');
  assert.equal(f.rows.length, 0);
  assert.equal(consumed, false);
});
test('lost challenge consumption race cannot mint an approval', async () => {
  const f = fixture();
  f.deps.markChallengeConsumed = async () => false;
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({ context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '007787' } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'NO_DECISION');
  assert.equal(f.rows.length, 0);
});
test('challenge submit accepts an expired operation lock after challenge preparation allowed it', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  f.deps.prepare = async () => baselineDecisionPrepared({
    review: { state: 'DECIDING', last_checked_at: f.deps.now() - 61000 }
  });

  const challenge = await api.challenge(f.request);
  const result = await api.submit({
    context: { accountId: 'trusted' },
    payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '007787' }
  });

  assert.equal(result.success, true);
  assert.equal(f.rows[0].state, 'CONSUMED');
});
test('approval notes allow the same four thousand characters the panel accepts', async () => {
  const f = fixture();
  f.request.payload.note = 'x'.repeat(4000);
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, true);
  assert.equal(f.rows[0].note.length, 4000);
});
test('challenge submit refuses notes longer than the panel limit before recording', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({ context: { accountId: 'trusted' }, payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '007787', note: 'x'.repeat(4001) } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'NOT_CONFIGURED');
  assert.equal(f.rows.length, 0);
});
test('only resolver identity enters the persisted approval and audit precedes usable capability', async () => {
  const f = fixture();
  f.deps.audit = async () => assert.equal(f.rows[0].state, 'VOID');
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, true);
  assert.equal(f.rows[0].account_id, 'trusted');
  assert.equal(f.rows[0].state, 'PENDING');
});
test('failed approval audit leaves only an unusable record', async () => {
  const f = fixture(); f.deps.audit = async () => { throw new Error('audit down'); };
  assert.equal((await signed(f.deps, f.request)).success, false);
  assert.equal(f.rows[0].state, 'VOID');
});
test('capture failure cannot complete ratification or publish a pending capability', async () => {
  const f = fixture(); delete f.request.payload.transitionId;
  f.deps.apply = async () => ({ success: false, captured: false });
  assert.equal((await signed(f.deps, f.request)).success, false);
  assert.equal(f.rows[0].state, 'VOID');
});
test('stale reviewed evidence is rejected before recording', async () => {
  const f = fixture(); f.request.payload.expectedEvidenceHash = 'f'.repeat(64);
  const challenge = await createApprovalUsecases(f.deps).challenge(f.request);
  assert.equal(challenge.success, false);
  assert.equal(challenge.reason, 'CONTENT_CHANGED');
  assert.equal(f.rows.length, 0);
});
test('rejection applies baseline restoration then becomes consumed, never pending', async () => {
  const f = fixture(); f.request.payload.decision = 'REJECT';
  let applied = false; f.deps.apply = async ({ approval }) => { assert.equal(approval.state, 'VOID'); applied = true; return { success: true }; };
  assert.equal((await signed(f.deps, f.request)).success, true);
  assert.equal(applied, true); assert.equal(f.rows[0].state, 'CONSUMED');
});
test('a busy restore returns a recovery message instead of the raw lock code', async () => {
  const f = fixture();
  f.request.payload.decision = 'REJECT';
  f.deps.apply = async () => { const error = new Error('ALREADY_DECIDING'); error.reason = 'ALREADY_DECIDING'; throw error; };
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, false);
  assert.match(result.error, /another decision.*already in progress/i);

});
test('retry cannot use another actor approval or mint new capability', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, true);
  const retry = await api.retryTransition({ context: { accountId: 'intruder' }, payload: { issueKey: 'T-10', approvalId: result.approvalId, transitionId: '5' } });
  assert.equal(retry.success, false); assert.equal(f.rows.length, 1);
});

test('initial transition makes the audited approval available to the real gate before Jira executes it', async () => {
  const f = fixture();
  f.request.payload.preauthorize = false;
  f.deps.activate = async ({ approvalId, state }) => {
    const row = f.rows.find(r => r.approval_id.equals(approvalId));
    if (row.state !== 'VOID') return false;
    row.state = state;
    return true;
  };
  const gate = createGate({
    now: f.deps.now, log: () => {}, audit: async () => {}, eligible: async () => true,
    load: async () => ({ ...await f.deps.prepare(), issueId: 10, projectId: 1, issueTypeId: '1', ct: await f.deps.edge() }),
    pending: async () => f.rows.find(r => r.state === 'PENDING'),
    consume: async ({ approvalId }) => {
      const row = f.rows.find(r => r.approval_id.equals(approvalId));
      if (row.state !== 'PENDING') return { consumed: false };
      row.state = 'CONSUMED'; return { consumed: true };
    },
    voidOthers: async () => {}
  });
  f.deps.performTransition = async () => ({ transitioned: (await gate({ issue: { key: 'T-10' }, transition: { id: '5', from: { id: '1' }, to: { id: '2' } } })).result });
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, true);
  assert.equal(result.transitioned, true);
  assert.equal(f.rows[0].state, 'CONSUMED');
});

test('challenge refuses a different attestation meaning before spending the code', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, meaning: 'Release to production' });
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId: challenge.challengeId } });
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
});

test('challenge refuses a changed baseline even when the candidate content is identical', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const prepared = await f.deps.prepare();
  f.deps.prepare = async () => ({ ...prepared, baselineVersion: 2 });
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId: challenge.challengeId } });
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
});

test('challenge refuses confirmation if the drift list (and thus evidence hash) mutates mid-flow', async () => {
  const f = fixture(), api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const prepared = await f.deps.prepare();
  f.deps.prepare = async () => ({ ...prepared, evidenceHash: 'new-mutated-hash' });
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId: challenge.challengeId } });
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
});

test('electronic signature requires explicit affirmation before spending the code', async () => {
  const f = fixture();
  f.request.payload.confirmed = false;
  f.request.payload.preauthorize = false;
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
});

test('signed drift approval reaches baseline capture through the panel challenge', async () => {
  const f = fixture();
  const prepared = await f.deps.prepare();
  f.deps.prepare = async () => ({ ...prepared, driftCount: 3, review: { state: 'DRIFTED' } });
  const api = createApprovalUsecases(f.deps);
  const payload = { ...f.request.payload, preauthorize: false };
  payload.challengeId = (await api.challenge(f.request)).challengeId;
  const result = await api.submit({ context: f.request.context, payload });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.transitioned, true);
  assert.equal(f.rows[0].drift_count, 3);
});

test('a submit with no challenge is refused before any code is spent or anything recorded', async () => {
  // A challenge fixes the meaning shown, the candidate content and the exact
  // edge, once. Without one, a direct call chose its own transition and could
  // leave out the evidence hash — approving content the signer never saw.
  const f = fixture();
  let spent = false;
  f.deps.totpDeps.consume = async () => { spent = true; return true; };
  const result = await createApprovalUsecases(f.deps).submit({ context: f.request.context,
    payload: { ...f.request.payload, preauthorize: false } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'NO_DECISION');
  assert.equal(spent, false);
  assert.equal(f.rows.length, 0);
});
test('Jira preauthorization cannot substitute for the signer affirming the declaration', async () => {
  const f = fixture();
  f.request.payload.confirmed = false;
  f.request.payload.preauthorize = true;
  let spentCode = false;
  f.deps.totpDeps.consume = async () => { spentCode = true; return true; };
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, false);
  assert.equal(f.rows.length, 0);
  assert.equal(spentCode, false);
});

// A panel that always sends its code box, empty or not, must not silently
// downgrade a biometric edge into an electronic signature it cannot satisfy.
test('an empty signature code does not displace the required biometric assurance', async () => {
  const f = fixture();
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, required_assurance: 'BIOMETRIC' });
  let totpSpent = false;
  f.deps.totpDeps.consume = async () => { totpSpent = true; return true; };
  let verified = false;
  f.deps.webauthnDeps = {
    verifyAssertion: async () => {
      verified = true;
      return { ok: true, credentialId: 'credential-1', assertionAssurance: 'DEVICE_BOUND_UV',
        rpId: 'app.cdn.prod.atlassian-dev.net', origin: 'https://app.cdn.prod.atlassian-dev.net', verifiedAt: f.deps.now() };
    }
  };
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({
    context: { accountId: 'trusted' },
    payload: {
      issueKey: 'T-10',
      challengeId: challenge.challengeId,
      confirmed: true,
      code: '',
      webauthn: { challengeId: 'webauthn-challenge', response: { id: 'credential-1' } }
    }
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(verified, true, 'the device assertion is what must be checked');
  assert.equal(totpSpent, false);
  assert.equal(f.rows[0].assurance_level, 'BIOMETRIC');
});

test('biometric policy refuses an injected TOTP code', async () => {
  const f = fixture();
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, required_assurance: 'BIOMETRIC' });
  let providerCalled = false;
  f.deps.totpDeps.consume = async () => { providerCalled = true; return true; };
  f.deps.webauthnDeps = { verifyAssertion: async () => { providerCalled = true; return { ok: true }; } };
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({
    context: { accountId: 'trusted' },
    payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true, code: '123456' }
  });
  assert.equal(providerCalled, false, 'no provider must be called before method mismatch check');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'WRONG_AUTHENTICATION_METHOD');
});

test('electronic policy refuses WebAuthn substitution', async () => {
  const f = fixture();
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, required_assurance: 'ESIGNATURE' });
  let providerCalled = false;
  f.deps.totpDeps.consume = async () => { providerCalled = true; return true; };
  f.deps.webauthnDeps = { verifyAssertion: async () => { providerCalled = true; return { ok: true }; } };
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({
    context: { accountId: 'trusted' },
    payload: { issueKey: 'T-10', challengeId: challenge.challengeId, confirmed: true,
      webauthn: { challengeId: 'webauthn-challenge', response: { id: 'cred-1' } } }
  });
  assert.equal(providerCalled, false, 'no provider must be called before method mismatch check');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'WRONG_AUTHENTICATION_METHOD');
});

test('a transition of a work item held from above is refused before any challenge or authentication', async () => {
  const f = fixture();
  let asked = null;
  f.deps.ancestorDrift = async issue => { asked = issue.issueKey; return { issueKey: 'E-1', issueId: 1, depth: 1, changed: ['labels'] }; };
  const result = await createApprovalUsecases(f.deps).challenge(f.request);
  assert.equal(asked, 'T-10');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ANCESTOR_DRIFT');
  assert.match(result.error, /E-1, above this work item, has changed since it was approved/);
  assert.equal(f.challenges.size, 0, 'no challenge row: no authentication can be spent on it');
});

test('an ancestor that drifts after the challenge refuses the submit, and nothing is recorded', async () => {
  const f = fixture();
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  assert.equal(challenge.success, true, JSON.stringify(challenge));
  f.deps.ancestorDrift = async () => ({ issueKey: 'E-1', issueId: 1, depth: 2, changed: ['description'] });
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId: challenge.challengeId } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ANCESTOR_DRIFT');
  assert.equal(f.rows.length, 0);
});

test('a drift decision is about content, not movement: an ancestor\'s drift never refuses it', async () => {
  const f = fixture();
  let asked = false;
  f.deps.ancestorDrift = async () => { asked = true; return { issueKey: 'E-1', issueId: 1, depth: 1, changed: ['labels'] }; };
  f.deps.prepare = async () => baselineDecisionPrepared();
  const result = await createApprovalUsecases(f.deps).challenge({ context: f.request.context,
    payload: { issueKey: 'T-10', decision: 'APPROVE', intent: 'DRIFT' } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(asked, false);
});

test('a parent whose own content is unchanged is not refused a non-capturing transition for a child\'s drift', async () => {
  const f = fixture();
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, capture_baseline: false });
  f.deps.prepare = async () => ({ contentHash: 'a'.repeat(64), evidenceHash: 'e'.repeat(64), baselineVersion: 1, driftCount: 1 });
  f.deps.ownDriftCount = async () => 0;
  const result = await signed(f.deps, f.request);
  assert.equal(result.success, true, JSON.stringify(result));
});

test('a work item with drift of its own is still refused a non-capturing transition', async () => {
  const f = fixture();
  const edge = await f.deps.edge();
  f.deps.edge = async () => ({ ...edge, capture_baseline: false });
  f.deps.ownDriftCount = async () => 2;
  const api = createApprovalUsecases(f.deps);
  const challenge = await api.challenge(f.request);
  const result = await api.submit({ context: f.request.context, payload: { ...f.request.payload, challengeId: challenge.challengeId } });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'UNDECIDED_DRIFT');
});
