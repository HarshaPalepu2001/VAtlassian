import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * EXACT-TRANSITION BINDING, AGAINST THE REAL QUERIES.
 *
 * Two different Jira workflow transitions can both go from status 3 to status
 * 5 ("Approve" and "Approve (fast-track)", say). Before this, gatedTransition()
 * and pendingApprovalFor() matched on project/issueType/fromStatus/toStatus
 * only, so the two transitions collided: whichever row or receipt matched the
 * status pair was usable by either transition id. This exercises the real SQL
 * text in db/configStore.js and db/approvalStore.js — only the Forge SQL
 * transport (lib/db.js) is replaced, with a tiny in-memory table that
 * understands the same WHERE semantics (wildcard columns, exact transition id,
 * ORDER BY / LIMIT 1) the real statements rely on.
 */

function sortDesc(rows, keys) {
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const av = String(a[key]), bv = String(b[key]);
      if (av !== bv) return av < bv ? 1 : -1;
    }
    return 0;
  });
}

function fakeQuery(sql, params) {
  const db = globalThis.vaTransitionPolicy;
  if (sql.includes('FROM va_controlled_transition')) {
    const [projectId, issueTypeId, fromStatusId, toStatusId, transitionId, state] = params;
    const matches = sortDesc(db.controlledTransitions.filter((r) =>
      String(r.project_id) === String(projectId) &&
      (String(r.issue_type_id) === String(issueTypeId) || r.issue_type_id === '*') &&
      (String(r.from_status_id) === String(fromStatusId) || r.from_status_id === '*') &&
      (String(r.to_status_id) === String(toStatusId) || r.to_status_id === '*') &&
      String(r.transition_id) === String(transitionId) &&
      r.state === state
    ), ['issue_type_id', 'from_status_id', 'to_status_id']);
    return { result: true, data: matches.slice(0, 1) };
  }
  if (sql.includes('FROM va_approval')) {
    const [issueId, fromStatusId, toStatusId, transitionId, now, approvalIdB64] = params;
    const matches = db.approvals
      .filter((r) =>
        String(r.issue_id) === String(issueId) &&
        r.state === 'PENDING' && r.decision === 'APPROVE' &&
        String(r.from_status_id) === String(fromStatusId) &&
        String(r.to_status_id) === String(toStatusId) &&
        String(r.transition_id) === String(transitionId) &&
        Number(r.expires_at) > Number(now) &&
        (approvalIdB64 == null || r.approval_id === approvalIdB64))
      .sort((a, b) => Number(b.decided_at) - Number(a.decided_at));
    return { result: true, data: matches.slice(0, 1) };
  }
  return { result: true, data: [] };
}

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    if (resolved.endsWith('/lib/db.js')) return { url: 'fixture:lib/db.js', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:lib/db.js') return { format: 'module', shortCircuit: true, source: `
      export function toBinaryParam(buffer) { return buffer.toString('base64'); }
      export function fromBinaryColumn(value) { return value == null ? null : Buffer.from(value, 'base64'); }
      export function limitClause(count) {
        if (!Number.isSafeInteger(count) || count <= 0) throw new TypeError('LIMIT must be a positive safe integer');
        return String(count);
      }
      export function affectedRows(result) {
        const count = result && result.data && result.data.affectedRows;
        return typeof count === 'number' ? count : null;
      }
      export async function executeQuery(sql, params) { return globalThis.vaTransitionPolicy.query(sql, params); }
    ` };
    return next(url, context);
  }
});
const { gatedTransition } = await import('../src/db/configStore.js');
const { pendingApprovalFor } = await import('../src/db/approvalStore.js');
hooks.deregister();

function row(overrides = {}) {
  return {
    project_id: 1, issue_type_id: '10001', from_status_id: '3', to_status_id: '5',
    required_role: 'reviewer', meaning: 'Approved', require_decision: 0, block_on_drift: 1,
    required_assurance: 'ESIGNATURE', capture_baseline: 1, state: 'ACTIVE',
    ...overrides
  };
}

test('two transitions to the same status resolve by transition id', async () => {
  globalThis.vaTransitionPolicy = {
    controlledTransitions: [
      row({ ct_id: 'AAA=', transition_id: '101', required_assurance: 'ESIGNATURE' }),
      row({ ct_id: 'BBB=', transition_id: '102', required_assurance: 'BIOMETRIC' })
    ],
    approvals: [],
    query: fakeQuery
  };

  const exact = await gatedTransition({
    projectId: 1, issueTypeId: '10001', fromStatusId: '3',
    toStatusId: '5', transitionId: '102'
  });

  assert.equal(exact.transition_id, '102');
  assert.equal(exact.required_assurance, 'BIOMETRIC');
});

test('the sibling transition id resolves its own, different policy', async () => {
  globalThis.vaTransitionPolicy = {
    controlledTransitions: [
      row({ ct_id: 'AAA=', transition_id: '101', required_assurance: 'ESIGNATURE', meaning: 'Fast-track approve' }),
      row({ ct_id: 'BBB=', transition_id: '102', required_assurance: 'BIOMETRIC', meaning: 'Approve' })
    ],
    approvals: [],
    query: fakeQuery
  };

  const sibling = await gatedTransition({
    projectId: 1, issueTypeId: '10001', fromStatusId: '3',
    toStatusId: '5', transitionId: '101'
  });

  assert.equal(sibling.transition_id, '101');
  assert.equal(sibling.required_assurance, 'ESIGNATURE');
  assert.equal(sibling.meaning, 'Fast-track approve');
});

test('gatedTransition never queries and returns null without an exact transition id', async () => {
  globalThis.vaTransitionPolicy = {
    controlledTransitions: [row({ ct_id: 'AAA=', transition_id: '101' })],
    approvals: [],
    query: () => assert.fail('a missing transition id must never reach the database')
  };

  const result = await gatedTransition({ projectId: 1, issueTypeId: '10001', fromStatusId: '3', toStatusId: '5', transitionId: null });
  assert.equal(result, null);
});

test('a pending approval signed for one transition is not returned for a sibling transition to the same status', async () => {
  const signedForFastTrack = {
    approval_id: Buffer.alloc(16, 1).toString('base64'), baseline_id: null,
    issue_id: 10, issue_key: 'T-10', project_id: 1, issue_type_id: '10001',
    decision: 'APPROVE', state: 'PENDING', from_status_id: '3', to_status_id: '5',
    transition_id: '101', expires_at: 999999999999, decided_at: 100
  };
  globalThis.vaTransitionPolicy = { controlledTransitions: [], approvals: [signedForFastTrack], query: fakeQuery };

  const forSibling = await pendingApprovalFor({ issueId: 10, fromStatusId: '3', toStatusId: '5', transitionId: '102', now: 0 });
  assert.equal(forSibling, null);

  const forItsOwnTransition = await pendingApprovalFor({ issueId: 10, fromStatusId: '3', toStatusId: '5', transitionId: '101', now: 0 });
  assert.ok(forItsOwnTransition, 'the approval must still resolve for the transition it was actually signed for');
  assert.equal(forItsOwnTransition.transition_id, '101');
});

test('pendingApprovalFor never queries and returns null without an exact transition id', async () => {
  globalThis.vaTransitionPolicy = {
    controlledTransitions: [],
    approvals: [{ approval_id: Buffer.alloc(16, 1).toString('base64'), issue_id: 10, decision: 'APPROVE',
      state: 'PENDING', from_status_id: '3', to_status_id: '5', transition_id: '101', expires_at: 999999999999, decided_at: 100 }],
    query: () => assert.fail('a missing transition id must never reach the database')
  };

  const result = await pendingApprovalFor({ issueId: 10, fromStatusId: '3', toStatusId: '5', transitionId: null, now: 0 });
  assert.equal(result, null);
});
