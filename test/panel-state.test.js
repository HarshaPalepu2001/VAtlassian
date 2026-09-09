import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { project } from '../src/lib/content.js';

/**
 * WHAT THE PANEL TELLS THE SCREEN.
 *
 * usecases/panel.js had no test, and two fields the UI is built to render were
 * never produced by it: `approval.pending` was the literal `null`, and
 * `credentialEnrolled` was absent entirely. Both are read by
 * panel/sections/ApprovalControls.tsx. A field the server never sends is a
 * control the reviewer can never reach, which is indistinguishable from the
 * feature not existing.
 *
 * Real preparation, diff, record building and eligibility. Only Jira and
 * persistence are replaced.
 */

const modules = {
  'db/configStore.js': ['controlledFields', 'projectConfig', 'gateActiveOutOf', 'gatedTransition',
    'listGatedTransitions', 'declaredFieldRows', 'seedControlledFields', 'countControlledFields'],
  'db/baselineStore.js': ['activeBaseline', 'readAllValues', 'baselineHistory'],
  'db/itemStateStore.js': ['getReview'],
  'db/driftStore.js': ['driftForIssue'],
  'db/approvalStore.js': ['approvalById', 'pendingApprovalForActor'],
  'db/incidentStore.js': ['issueControlStatus'],
  'db/credentialStore.js': ['credentialState'],
  'lib/reviewer.js': ['isEligible'],
  'lib/transitions.js': ['availableTransitions']
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({requestJira: (...a) => globalThis.vaPanel.request('user',...a)}),
        asApp: () => ({requestJira: (...a) => globalThis.vaPanel.request('app',...a)}) };` };
    const names = modules[url.slice(8)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaPanel.${n}(...a);`).join('\n') };
    return next(url, context);
  }
});
const { getState } = await import('../src/usecases/panel.js');
hooks.deregister();

const clone = value => structuredClone(value);
const NOW = 1_700_000_000_000;

function fixture(overrides = {}) {
  const fields = [
    { field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, writable: true, materiality: 'MAJOR' }
  ];
  const editmeta = { summary: { schema: { type: 'string' }, operations: ['set'] } };
  const approvedValues = { summary: 'approved text' };
  const projected = project(approvedValues, fields);
  const issue = { id: '10', key: 'T-10',
    fields: { summary: 'approved text', project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } };
  const baseline = { baseline_id: Buffer.alloc(16, 1), issue_id: 10, version: 1, state: 'ACTIVE',
    content_hash: projected.contentHash, field_digests: JSON.stringify(projected.digests),
    from_status_id: '100', to_status_id: '200', transition_id: '31', transition_at: NOW - 1000,
    captured_at: NOW - 900, approved_name: 'A reviewer', approved_by: 'reviewer-1',
    fidelity: 'EXACT', approval_id: Buffer.alloc(16, 2) };
  const policy = { required_assurance: 'ESIGNATURE', required_role: 'reviewer', meaning: 'Reviewed and approved',
    capture_baseline: true, block_on_drift: true, gated: true };

  const f = {
    issue, fields, pendingRow: null, credential: null,
    controlledFields: async () => fields,
    projectConfig: async () => ({ enabled: true, restore: {}, reviewerFieldId: null }),
    gateActiveOutOf: async () => policy,
    gatedTransition: async () => policy,
    listGatedTransitions: async () => [policy],
    activeBaseline: async () => baseline,
    readAllValues: async () => clone(approvedValues),
    baselineHistory: async () => [],
    getReview: async () => ({ state: 'BASELINED', version: 1, baseline_version: 1 }),
    driftForIssue: async () => [],
    approvalById: async () => null,
    pendingApprovalForActor: async () => f.pendingRow,
    issueControlStatus: async () => ({ incidents: [], gateFindings: [] }),
    credentialState: async () => f.credential,
    isEligible: async () => true,
    availableTransitions: async () => [{ id: '31', name: 'Approve', toStatusId: '200' }],
    request: async (_identity, url) => {
      const response = body => ({ ok: true, status: 200, json: async () => clone(body) });
      if (String(url).includes('/editmeta')) return response({ fields: editmeta });
      if (String(url).includes('/changelog')) return response({ values: [], total: 0, isLast: true });
      return response(f.issue);
    },
    ...overrides
  };
  globalThis.vaPanel = f;
  return f;
}

const args = { payload: { issueKey: 'T-10' }, context: { accountId: 'reviewer-1' } };

// ── A recorded approval whose transition never landed ────────────────────────
//
// submit() leaves the approval row PENDING when Jira refuses the transition.
// ApprovalControls keeps that in component state, which does not survive a
// reload — so unless the panel reports it, the reviewer's only route to
// `approval:retryTransition` disappears the moment they navigate away.

test('a stranded PENDING approval is reported so the retry control can be rendered', async () => {
  const f = fixture();
  f.pendingRow = { approval_id: Buffer.alloc(16, 9), state: 'PENDING', decision: 'APPROVE',
    transition_id: '31', from_status_id: '100', to_status_id: '200',
    account_id: 'reviewer-1', actor_account_id: 'reviewer-1', expires_at: NOW + 600_000 };

  const state = await getState(args);

  assert.equal(state.approval.pending?.approvalId, Buffer.alloc(16, 9).toString('hex'),
    'the panel must name the approval so retryTransition can be called with it');
  assert.equal(state.approval.pending?.transitionId, '31');
  assert.equal(state.approval.pending?.state, 'PENDING');
});

test('no pending approval means no retry control', async () => {
  fixture();
  const state = await getState(args);
  assert.equal(state.approval.pending, null);
});

test('a pending approval whose transition Jira no longer offers is not advertised', async () => {
  // retryTransition refuses when the transition cannot be resolved. Offering a
  // button that is certain to fail is worse than not offering it.
  const f = fixture({ availableTransitions: async () => [] });
  f.pendingRow = { approval_id: Buffer.alloc(16, 9), state: 'PENDING', decision: 'APPROVE',
    transition_id: '31', from_status_id: '100', to_status_id: '200',
    account_id: 'reviewer-1', actor_account_id: 'reviewer-1', expires_at: NOW + 600_000 };

  const state = await getState(args);
  assert.equal(state.approval.pending, null);
});

// ── Whether this reviewer can actually sign ──────────────────────────────────

test('the panel reports that the signer has no active authenticator', async () => {
  const f = fixture();
  f.credential = { state: 'NONE' };

  const state = await getState(args);

  assert.equal(state.credentialEnrolled, false,
    'ApprovalControls renders its enrolment guidance on exactly this value');
});

test('an active authenticator is reported as enrolled', async () => {
  const f = fixture();
  f.credential = { state: 'ACTIVE' };

  const state = await getState(args);
  assert.equal(state.credentialEnrolled, true);
});

test('an unreadable credential is not reported as "not enrolled"', async () => {
  // A storage failure must not tell a reviewer who IS enrolled to go and enrol.
  // Unknown is its own answer, and the notice is keyed on `=== false`.
  const f = fixture({ credentialState: async () => { throw new Error('storage unavailable'); } });

  const state = await getState(args);
  assert.equal(state.credentialEnrolled, undefined);
  assert.equal(state.error, undefined, 'the panel still renders');
});
