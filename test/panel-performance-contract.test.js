import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * THE BOUNDARY panel:getSummary MUST NEVER CROSS.
 *
 * panelSummary.js exists so the panel can paint before the heavy read
 * finishes. Every module below is "poisoned" — replaced with a stub that
 * throws the moment any of its exports is called — so that if a future change
 * wires the summary path into the recursive tree, the changelog, retained
 * baseline values, or editmeta, this test fails immediately rather than
 * quietly regressing panel:getSummary's latency back to panel:getState's.
 */

function poison(names) {
  return names.map(n => `export const ${n} = () => { throw new Error('FORBIDDEN: ${n} must not be called by getSummary'); };`).join('\n');
}

const poisoned = {
  'lib/tree/jira.js': ['createTreeReader'],
  'lib/tree/stableRead.js': ['readStableTree'],
  'lib/changelog.js': ['fetchChangelog'],
  'db/baselineStore.js': ['readAllValues']
};

const modules = {
  'db/configStore.js': ['gatedTransition'],
  'db/itemStateStore.js': ['getReview'],
  'db/approvalStore.js': ['latestApproval', 'pendingApprovalForActor'],
  'db/incidentStore.js': ['adminIncidentCount'],
  'db/credentialStore.js': ['credentialState'],
  'db/adminStore.js': ['isActiveAdmin'],
  'db/restoreStore.js': ['restoresForIssue'],
  'lib/reviewer.js': ['isEligible'],
  'lib/transitions.js': ['availableTransitions']
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    let resolved = specifier;
    try { resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL || 'file:///').pathname : specifier; } catch (e) {}
    // db/baselineStore.js needs its OWN entry below (it exports both a real
    // function, activeBaseline, and a poisoned one, readAllValues), so it is
    // checked ahead of the generic poisoned-module lookup.
    if (resolved.endsWith('/db/baselineStore.js')) return { url: 'fixture:db/baselineStore.js', shortCircuit: true };
    const poisonedKey = Object.keys(poisoned).find(k => resolved.endsWith('/' + k));
    if (poisonedKey) return { url: 'poison:' + poisonedKey, shortCircuit: true };
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({requestJira: (...a) => globalThis.vaSummary.request('user',...a)}),
        asApp: () => ({requestJira: (...a) => globalThis.vaSummary.request('app',...a)}) };` };
    if (url === 'fixture:db/baselineStore.js') return { format: 'module', shortCircuit: true, source: `
      export const activeBaseline = (...a) => globalThis.vaSummary.activeBaseline(...a);
      export const readAllValues = () => { throw new Error('FORBIDDEN: readAllValues must not be called by getSummary'); };` };
    if (url.startsWith('poison:')) return { format: 'module', shortCircuit: true, source: poison(poisoned[url.slice(7)]) };
    const names = modules[url.slice(8)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaSummary.${n}(...a);`).join('\n') };
    return next(url, context);
  }
});
const { getSummary } = await import('../src/usecases/panelSummary.js');
hooks.deregister();

const NOW = 1_700_000_000_000;

function fixture(overrides = {}) {
  const issue = { id: '10', key: 'T-10',
    fields: { summary: 'a signed item', project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } };
  const policy = { required_role: 'reviewer', required_assurance: 'ESIGNATURE', meaning: 'Reviewed and approved',
    capture_baseline: true, block_on_drift: true };
  const f = {
    issue,
    gatedTransition: async () => policy,
    getReview: async () => ({ state: 'BASELINED', version: 1, baseline_version: 1, drift_count: 0, drifted_field_count: 0 }),
    latestApproval: async () => null,
    pendingApprovalForActor: async () => null,
    adminIncidentCount: async () => 0,
    credentialState: async () => null,
    isActiveAdmin: async () => false,
    restoresForIssue: async () => [],
    activeBaseline: async () => null,
    isEligible: async () => true,
    availableTransitions: async () => [{ id: '31', name: 'Approve to next', toStatusId: '200', toStatusName: 'Done', isAvailable: true }],
    request: async (_identity, url) => {
      if (String(url).includes('editmeta')) throw new Error('FORBIDDEN: editmeta must not be requested by getSummary');
      if (String(url).includes('changelog')) throw new Error('FORBIDDEN: changelog must not be requested by getSummary');
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/myself')) return response({ displayName: 'A reviewer' });
      return response(f.issue);
    },
    ...overrides
  };
  globalThis.vaSummary = f;
  return f;
}

const args = { payload: { issueKey: 'T-10' }, context: { accountId: 'reviewer-1' } };

test('summary never invokes tree, changelog, editmeta, or baseline-value readers', async () => {
  fixture();
  const summary = await getSummary(args);
  assert.equal(summary.error, undefined, `getSummary must not fail: ${summary.error}`);
  assert.equal(summary.issue.key, 'T-10');
});

test('summary reads only the narrow issue fields, never the full field set', async () => {
  let requestedUrl = null;
  fixture({
    request: async (_identity, url) => {
      if (String(url).includes('/issue/')) requestedUrl = String(url);
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/myself')) return response({ displayName: 'A reviewer' });
      return response({ id: '10', key: 'T-10',
        fields: { summary: 'a signed item', project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } });
    }
  });
  await getSummary(args);
  assert.match(requestedUrl, /fields=project,issuetype,status,summary/);
  assert.doesNotMatch(requestedUrl, /fields=\*all/);
});

test('observer sees control and provenance but no enabled actions', async () => {
  fixture({ isEligible: async () => false });
  const summary = await getSummary(args);

  assert.equal(summary.tier, 'observer');
  assert.equal(summary.eligibility.eligible, false);
  assert.equal(summary.transitions[0].requiredRole, 'reviewer');
  assert.equal(summary.transitions[0].requiredAssurance, 'ESIGNATURE');
  assert.equal(summary.transitions[0].canApprove, false, 'the control is described but not enabled');
});

test('an eligible reviewer sees the same transition with canApprove true', async () => {
  fixture();
  const summary = await getSummary(args);

  assert.equal(summary.tier, 'actor');
  assert.equal(summary.transitions[0].canApprove, true);
});

test('summary exposes the review version that keys current-record evidence', async () => {
  fixture({ getReview: async () => ({ state: 'DRIFTED', version: 42, baseline_version: 1, drift_count: 1, drifted_field_count: 1 }) });
  const summary = await getSummary(args);

  assert.equal(summary.evidenceVersion, 42);
});

test('drift authority comes from the baseline\'s own recorded provenance, not the current rule', async () => {
  fixture({
    isEligible: async ({ role }) => role === 'baseline-signer',
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), version: 3, transition_id: '31',
      from_status_id: '100', to_status_id: '200',
      required_role: 'baseline-signer', required_assurance: 'ESIGNATURE',
      controlled_fields_hash: 'a'.repeat(64)
    }),
    getReview: async () => ({ state: 'DRIFTED', version: 2, baseline_version: 3, drift_count: 1, drifted_field_count: 1 })
  });
  const summary = await getSummary(args);

  assert.equal(summary.drift.count, 1);
  assert.equal(summary.drift.decidesDrift, true, 'eligible on the baseline\'s recorded role');
  assert.equal(summary.tier, 'actor');
  assert.equal(summary.approval.requiredRole, 'baseline-signer');
});

test('the original approver may always decide drift, even without a current eligibility grant', async () => {
  fixture({
    isEligible: async () => false,
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), version: 3, transition_id: '31',
      from_status_id: '100', to_status_id: '200', approved_by: 'reviewer-1',
      required_role: 'baseline-signer', required_assurance: 'ESIGNATURE',
      controlled_fields_hash: 'a'.repeat(64)
    }),
    getReview: async () => ({ state: 'DRIFTED', version: 2, baseline_version: 3, drift_count: 1, drifted_field_count: 1 })
  });
  const summary = await getSummary(args); // args.context.accountId === 'reviewer-1'

  assert.equal(summary.drift.decidesDrift, true, 'the approver on record can decide, regardless of current role eligibility');
  assert.equal(summary.tier, 'actor');
});

test('a bystander who neither holds the role nor approved the baseline still cannot decide drift', async () => {
  fixture({
    isEligible: async () => false,
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), version: 3, transition_id: '31',
      from_status_id: '100', to_status_id: '200', approved_by: 'someone-else',
      required_role: 'baseline-signer', required_assurance: 'ESIGNATURE',
      controlled_fields_hash: 'a'.repeat(64)
    }),
    getReview: async () => ({ state: 'DRIFTED', version: 2, baseline_version: 3, drift_count: 1, drifted_field_count: 1 })
  });
  const summary = await getSummary(args); // args.context.accountId === 'reviewer-1', not the approver

  assert.equal(summary.drift.decidesDrift, false);
  assert.equal(summary.tier, 'observer');
});

test('a baseline with incomplete provenance blocks the drift decision instead of throwing', async () => {
  fixture({
    availableTransitions: async () => [],
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), version: 1, transition_id: null,
      from_status_id: '100', to_status_id: '200',
      required_role: null, required_assurance: null, controlled_fields_hash: null
    }),
    getReview: async () => ({ state: 'DRIFTED', version: 2, baseline_version: 1, drift_count: 1, drifted_field_count: 1 })
  });
  const summary = await getSummary(args);

  assert.equal(summary.error, undefined, 'an incomplete historical baseline must not crash the summary');
  assert.equal(summary.drift.decidesDrift, false);
  assert.equal(summary.drift.policyIncomplete, true);
  assert.equal(summary.baseline.policyIncomplete, true);
});

test('a stranded approval only advertises retry when its transition is still described', async () => {
  fixture({
    pendingApprovalForActor: async () => ({ approval_id: Buffer.alloc(16, 9), state: 'PENDING', decision: 'APPROVE',
      transition_id: '31', from_status_id: '100', to_status_id: '200', expires_at: NOW + 600_000 })
  });
  const summary = await getSummary(args);
  assert.equal(summary.approval.pending?.approvalId, Buffer.alloc(16, 9).toString('hex'));
});

test('a stranded approval is not advertised once its transition is no longer eligible', async () => {
  // retryTransition() re-checks eligibility and refuses NOT_ELIGIBLE. Offering
  // the retry button here would be certain to fail.
  fixture({
    isEligible: async () => false,
    pendingApprovalForActor: async () => ({ approval_id: Buffer.alloc(16, 9), state: 'PENDING', decision: 'APPROVE',
      transition_id: '31', from_status_id: '100', to_status_id: '200', expires_at: NOW + 600_000 })
  });
  const summary = await getSummary(args);
  assert.equal(summary.approval.pending, null);
});

test('an admin sees an incident count; a non-admin does not', async () => {
  const f = fixture({ isActiveAdmin: async () => true, adminIncidentCount: async () => 4 });
  const summary = await getSummary(args);
  assert.equal(summary.adminIncidentCount, 4);

  fixture({ isActiveAdmin: async () => false });
  const summary2 = await getSummary(args);
  assert.equal(summary2.adminIncidentCount, undefined);
});
