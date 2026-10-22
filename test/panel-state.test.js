import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { project } from '../src/lib/content.js';
import { logicalNodeId } from '../src/lib/tree/model.js';

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
  'db/baselineStore.js': ['activeBaseline', 'activeBaselines', 'readAllValues', 'baselineHistory', 'baselineByVersion', 'baselineById'],
  'db/baselineTreeStore.js': ['readBaselineTree', 'activeRootsForNode', 'rootNodeDigests', 'driftedDescendants', 'driftedDescendantsOfNode', 'capturingParent'],
  'db/itemStateStore.js': ['getReview'],
  'db/driftStore.js': ['driftForIssue', 'driftForIssueVersions'],
  'db/approvalStore.js': ['approvalById', 'pendingApprovalForActor', 'latestApproval'],
  'db/incidentStore.js': ['issueControlStatus', 'adminIncidentCount'],
  'db/credentialStore.js': ['credentialState'],
  'db/adminStore.js': ['isActiveAdmin'],
  'db/restoreStore.js': ['restoresForIssue', 'restoreReaching'],
  'lib/reviewer.js': ['isEligible'],
  'lib/transitions.js': ['availableTransitions']
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    // Test-management tables are not part of these scenarios: no project has it enabled.
    if (specifier.startsWith('.') && context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/testmgmt/store.js')) return { url: 'fixture:tm-store', shortCircuit: true };
    let resolved = specifier;
    try { resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL || 'file:///').pathname : specifier; } catch (e) {}
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:tm-store') return { format: 'module', shortCircuit: true, source: 'export const listProjects = async () => []; export const bugIssueIdsAmong = async () => new Set(); export const listRunsForExecution = async () => []; export const listBugsFor = async () => [];' };
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
const { getState, getGlanceState } = await import('../src/usecases/panel.js');
const { getEvidence, compareVersions } = await import('../src/usecases/panelEvidence.js');
const { filterViewableReviewDiff } = await import('../src/usecases/panelAccess.js');
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
    fields: { summary: 'approved text', parent: null, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } };
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
    // No child carries a baseline of its own unless a test says so.
    activeBaselines: async () => new Map(),
    baselineHistory: async () => [],
    baselineByVersion: async () => null,
    baselineById: async () => null,
    getReview: async () => ({ state: 'BASELINED', version: 1, baseline_version: 1 }),
    driftForIssue: async () => [],
    driftForIssueVersions: async () => ({ rows: [], truncated: false }),
    approvalById: async () => null,
    pendingApprovalForActor: async () => f.pendingRow,
    latestApproval: async () => null,
    issueControlStatus: async () => ({ incidents: [], gateFindings: [] }),
    adminIncidentCount: async () => 0,
    restoresForIssue: async () => [],
    restoreReaching: async () => null,
    // A work item that is a node inside someone else's tree baseline resolves
    // its governing approval through this. Most fixtures here are roots, so the
    // default is "covered by nothing of its own".
    activeRootsForNode: async () => [],
    rootNodeDigests: async () => null,
    credentialState: async () => f.credential,
    isActiveAdmin: async () => false,
    isEligible: async () => true,
    availableTransitions: async () => [{ id: '31', name: 'Approve to next', toStatusId: '200' }],
    throwing: async () => [],
    request: async (_identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => clone(body) });
      if (String(url).includes('/editmeta')) return response({ fields: editmeta });
      if (String(url).includes('/changelog')) return response({ values: [], total: 0, isLast: true });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        const body = JSON.parse(options.body);
        return response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: body.projectPermissions[0].issues }] });
      }
      return response(f.issue);
    },
    ...overrides
  };
  globalThis.vaPanel = f;
  return f;
}

const args = { payload: { issueKey: 'T-10' }, context: { accountId: 'reviewer-1' } };

test('filtered review evidence retains the actual highest materiality', () => {
  const visibleTree = { nodes: [{ logicalNodeId: 'root' }] };
  const result = filterViewableReviewDiff({ fields: [
    { logicalNodeId: 'root', semanticChange: true, materiality: 'MINOR' },
    { logicalNodeId: 'root', semanticChange: true, materiality: 'CRITICAL' }
  ] }, visibleTree);

  assert.equal(result.materialFieldCount, 2);
  assert.equal(result.maxMateriality, 'CRITICAL');
});

test('non-admin glance reads do not query administrative incident controls', async () => {
  let controlsRead = 0;
  fixture({ issueControlStatus: async () => {
    controlsRead++;
    throw new Error('control storage unavailable');
  } });

  const result = await getGlanceState({ context: {
    accountId: 'reviewer-1', extension: { issue: { id: '10', typeId: '1' }, project: { id: '1' } }
  } });

  assert.equal(result.state, 'BASELINED');
  assert.equal(result.controls, undefined);
  assert.equal(controlsRead, 0);
});

test('admin glance degrades controls when their incident read fails', async () => {
  fixture({
    isActiveAdmin: async () => true,
    issueControlStatus: async () => { throw new Error('control storage unavailable'); }
  });

  const result = await getGlanceState({ context: {
    accountId: 'admin', extension: { issue: { id: '10', typeId: '1' }, project: { id: '1' } }
  } });

  assert.deepEqual(result.controls, { unavailable: true, incidents: [], gateFindings: [] });
  assert.equal(result.error, undefined);
});

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

// ── Payload tiering & living state sentence ──────────────────────────────────

test('an ineligible reviewer receives observer tier without actions, drift fields, or controls', async () => {
  const f = fixture({ isEligible: async () => false });
  const state = await getState(args);

  assert.equal(state.tier, 'observer');
  assert.equal(state.state, 'Waiting on a signature from reviewer');
  assert.equal(state.transitions, undefined, 'actions are omitted for observer');
  assert.equal(state.drift.fields, undefined, 'drift field details are omitted for observer');
  assert.equal(state.credentialEnrolled, undefined);
  assert.equal(state.controls, undefined, 'controls are omitted for non-admin');
});

test('when no transitions are gated, living state reports nothing needs a signature', async () => {
  const f = fixture({ gatedTransition: async () => null });
  const state = await getState(args);

  assert.equal(state.tier, 'observer');
  assert.equal(state.state, 'Nothing needs a signature at this status');
  assert.equal(state.transitions, undefined);
});

/**
 * The item sits in a status no rule fires out of, and it has drifted since it
 * was signed. Authority to decide that drift belongs to the BASELINE's own
 * gate — snapshot() already resolves it from `baseline.from_status_id ->
 * baseline.to_status_id` precisely because "drift outlives review status".
 * Deriving the tier from the offered transitions alone threw that answer away,
 * so the panel counted the change, said it needed a decision, and then rendered
 * the observer card with no way to make one.
 */
test('drift on a signed baseline is decidable when no transition is gated at the current status', async () => {
  const f = fixture({
    // Gated on the baseline's edge only. Nothing is gated out of where it sits now.
    gatedTransition: async ({ fromStatusId, toStatusId }) =>
      String(fromStatusId) === '100' && String(toStatusId) === '200'
        ? { required_assurance: 'ESIGNATURE', required_role: 'reviewer', meaning: 'Reviewed and approved',
            capture_baseline: true, block_on_drift: true, gated: true }
        : null,
    gateActiveOutOf: async () => ({ gated: false }),
    availableTransitions: async () => [{ id: '41', name: 'Start progress', toStatusId: '300' }]
  });
  f.issue.fields.status = { id: '200' };
  f.issue.fields.summary = 'edited after approval';

  const state = await getState(args);

  assert.equal(state.drift.count, 1, 'the change is detected');
  assert.equal(state.drift.materialCount, 1, 'and it needs a decision');
  assert.equal(state.tier, 'actor', 'so the reviewer must be able to make one');
  assert.ok(state.drift.fields?.length, 'the changed field reaches the panel');
  assert.equal(state.eligibility.eligible, true);
  assert.deepEqual(state.transitions, [], 'no transition is offered — only the drift decision');
  assert.equal(state.approval.requiredAssurance, 'ESIGNATURE', 'signed at the baseline rule\'s level');
  assert.notEqual(state.state, 'Nothing needs a signature at this status');
});

test('an administrator receives controls in the payload', async () => {
  const f = fixture({ isActiveAdmin: async () => true });
  const state = await getState(args);

  assert.ok(state.controls, 'admin must receive controls');
  assert.deepEqual(state.controls, { incidents: [], gateFindings: [] });
});

test('when issue is in done category, living state reports completed and no transitions offered', async () => {
  const f = fixture({
    issue: {
      id: '10', key: 'T-10',
      fields: {
        summary: 'approved text', parent: null, project: { id: '1' }, issuetype: { id: '1' },
        status: { id: '100', statusCategory: { key: 'done' } }
      }
    }
  });
  const state = await getState(args);

  assert.equal(state.state, 'Work item is completed.');
  assert.equal(state.transitions?.length ?? 0, 0, 'no forward transition gates when issue is completed');
});

test('self-transitions where toStatusId matches fromStatusId are never offered', async () => {
  const f = fixture({
    availableTransitions: async () => [
      { id: '10', name: 'Move to same', toStatusId: '100' },
      { id: '31', name: 'Approve to next', toStatusId: '200' }
    ]
  });
  const state = await getState(args);

  assert.ok(state.transitions.every(t => t.toStatusId !== '100'), 'self-transition must be filtered out');
});

test('when baseline is null, drift counts are strictly zero', async () => {
  const f = fixture({
    activeBaseline: async () => null,
    getReview: async () => ({ state: 'UNAPPROVED', version: 0, baseline_version: null })
  });
  const state = await getState(args);

  assert.equal(state.drift.count, 0);
  assert.equal(state.drift.materialCount, 0);
  assert.equal(state.record, null);
});

test('baseline history is mapped from database snake_case to camelCase properties', async () => {
  const f = fixture({
    baselineHistory: async () => [
      { version: 1, approved_name: 'Priya', transition_at: NOW - 5000, assurance_level: 'ESIGNATURE', captured_at: NOW - 4000 }
    ]
  });
  const state = await getState(args);

  assert.ok(state.record?.history?.length === 1);
  const h = state.record.history[0];
  assert.equal(h.version, 1);
  assert.equal(h.approvedName, 'Priya');
  assert.equal(h.approvedAt, NOW - 5000);
  assert.equal(h.assuranceLevel, 'ESIGNATURE');
});

test('panel returns structural drift and exact destructive consequences', async () => {
  const f = fixture({
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1),
      tree_hash: 'abc',
      node_count: 5,
      edge_count: 4,
      total_field_count: 48,
      from_status_id: '100', to_status_id: '200', transition_id: '31'
    }),
    readBaselineTree: async () => ({
      nodes: [
        { logicalNodeId: logicalNodeId('10'), issueKey: 'T-10', parentLogicalId: null, digests: { summary: '5c220e4800cda2aba11f631dacaca88f4c8bf8b5529ea30b657e5d978bf396a0' } },
        { logicalNodeId: logicalNodeId('11'), issueKey: 'T-11', parentLogicalId: logicalNodeId('10'), digests: { summary: '76bb4b18bc769e84fb98bb7751b019f5474317821f558597e1fcd07637f1559f' } },
        { logicalNodeId: 'removed-12', issueKey: 'T-12', parentLogicalId: logicalNodeId('10'), digests: {} }
      ],
      values: {}
    }),
    request: async (_identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        const body = JSON.parse(options.body);
        return response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: body.projectPermissions[0].issues }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        const bodyStr = options.body;
        if (bodyStr.includes('T-10')) {
          return response({ issues: [
            { id: '11', key: 'T-11', fields: { summary: 'story', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
            { id: '9', key: 'NEW-9', fields: { summary: 'new1', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
            { id: '100', key: 'NEW-10', fields: { summary: 'new2', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } }
          ]});
        }
        return response({ issues: [] });
      }
      return response({ ...f.issue, fields: { ...f.issue.fields, parent: null } });
    }
  });
  const state = await getState(args);
  assert.deepEqual(state.rejection.deleteIssueKeys.sort(), ['NEW-10', 'NEW-9'].sort());
  assert.equal(state.rejection.recreateCount, 1);
  assert.equal(state.baseline.totalFieldCount, 48);
});

// ── panel:getEvidence — the lazy, heavy half of the split ────────────────────

test('evidence returns the retained-value record, live diff fields, and tree rejection detail', async () => {
  const f = fixture();
  f.issue.fields.summary = 'edited after approval';
  const evidence = await getEvidence(args);

  assert.equal(evidence.error, undefined, `getEvidence must not fail: ${evidence.error}`);
  assert.equal(evidence.baselineVersion, 1);
  assert.ok(evidence.record, 'the retained-value record is part of evidence for every viewer');
  assert.ok(Array.isArray(evidence.drift.fields));
  assert.ok(evidence.drift.fields.some(field => field.fieldId === 'summary'));
  assert.deepEqual(evidence.drift.mixed, { eligible: false, reason: 'NOT_TREE_BASELINE', fields: [] },
    'a field-only baseline has no per-node digests to build a field decision from');
  assert.deepEqual(evidence.rejection, { deleteIssueKeys: [], recreateCount: 0,
    attachments: { deleteFiles: [], restoreFiles: [], unrestorableFiles: [], mediaUnknownFiles: [], vaultChecked: true } });
  assert.deepEqual(evidence.restoreHistory, []);
});

test('evidence carries the same content-binding hash that the compatibility adapter gave drift decisions', async () => {
  const f = fixture();
  f.issue.fields.summary = 'edited after approval';
  const state = await getState(args);
  const evidence = await getEvidence(args);

  assert.equal(typeof evidence.evidenceHash, 'string', 'a drift decision binds its challenge to the reviewed evidence');
  assert.equal(evidence.evidenceHash, state.drift.evidenceHash);
});

test('evidence refuses a stale expected baseline version rather than mixing vintages', async () => {
  fixture();
  const evidence = await getEvidence({ ...args, payload: { ...args.payload, expectedBaselineVersion: 99 } });
  assert.equal(evidence.reason, 'STALE_EVIDENCE');
});

test('evidence reports structural rejection detail identically to the compatibility adapter', async () => {
  const f = fixture({
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), tree_hash: 'abc', node_count: 5, edge_count: 4, total_field_count: 48,
      from_status_id: '100', to_status_id: '200', transition_id: '31'
    }),
    readBaselineTree: async () => ({
      nodes: [
        { logicalNodeId: logicalNodeId('10'), issueKey: 'T-10', parentLogicalId: null, digests: { summary: '5c220e4800cda2aba11f631dacaca88f4c8bf8b5529ea30b657e5d978bf396a0' } },
        { logicalNodeId: logicalNodeId('11'), issueKey: 'T-11', parentLogicalId: logicalNodeId('10'), digests: { summary: '76bb4b18bc769e84fb98bb7751b019f5474317821f558597e1fcd07637f1559f' } },
        { logicalNodeId: 'removed-12', issueKey: 'T-12', parentLogicalId: logicalNodeId('10'), digests: {} }
      ],
      values: {}
    }),
    request: async (_identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        const body = JSON.parse(options.body);
        return response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: body.projectPermissions[0].issues }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        const bodyStr = options.body;
        if (bodyStr.includes('T-10')) {
          return response({ issues: [
            { id: '11', key: 'T-11', fields: { summary: 'story', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
            { id: '9', key: 'NEW-9', fields: { summary: 'new1', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
            { id: '100', key: 'NEW-10', fields: { summary: 'new2', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } }
          ]});
        }
        return response({ issues: [] });
      }
      return response({ ...f.issue, fields: { ...f.issue.fields, parent: null } });
    }
  });
  const evidence = await getEvidence(args);
  assert.deepEqual(evidence.rejection.deleteIssueKeys.sort(), ['NEW-10', 'NEW-9'].sort());
  assert.equal(evidence.rejection.recreateCount, 1);
  assert.equal(evidence.drift.mixed.eligible, false, 'work items added or removed cannot be decided field by field');
  assert.equal(evidence.drift.mixed.reason, 'STRUCTURE_CHANGED');
});

// ── Issue Security Scheme enforcement on descendant tree nodes ───────────────
//
// createTreeReader walks the recursive hierarchy with asApp(), which has full
// tenant privilege and does not honour Jira Issue Security Schemes. Without a
// viewer-scoped filter, a reviewer who cannot see a security-scheme-protected
// child issue would still receive its key and live field content through
// evidence.rejection / evidence.drift. The root issue is already asUser()
// gated by readableIssue(); this proves the same boundary holds recursively.

test('evidence excludes a descendant node the viewer cannot browse, and checks with the viewer\'s own privilege', async () => {
  const requestedIdentities = [];
  const f = fixture({
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), tree_hash: 'abc', node_count: 5, edge_count: 4, total_field_count: 48,
      from_status_id: '100', to_status_id: '200', transition_id: '31'
    }),
    readBaselineTree: async () => ({
      nodes: [
        { logicalNodeId: logicalNodeId('10'), issueKey: 'T-10', parentLogicalId: null, digests: {} }
      ],
      values: {}
    }),
    request: async (identity, url, options = {}) => {
      requestedIdentities.push({ identity, url: String(url) });
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        const body = JSON.parse(options.body);
        return response({ projectPermissions: [{
          permission: 'BROWSE_PROJECTS',
          // Every descendant is visible except NEW-9's id (9): simulates an
          // Issue Security Scheme that hides that one issue from this viewer.
          issues: body.projectPermissions[0].issues.filter(id => String(id) !== '9')
        }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        if (String(options.body).includes('T-10')) {
          return response({ issues: [
            { id: '9', key: 'NEW-9', fields: { summary: 'secret', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
            { id: '100', key: 'NEW-10', fields: { summary: 'visible', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } }
          ] });
        }
        return response({ issues: [] });
      }
      return response({ ...f.issue, fields: { ...f.issue.fields, parent: null } });
    }
  });
  const evidence = await getEvidence(args);
  assert.deepEqual(evidence.rejection.deleteIssueKeys, ['NEW-10'],
    'NEW-9 must not appear anywhere in evidence once BROWSE_PROJECTS denies it');
  assert.ok(!JSON.stringify(evidence).includes('secret'),
    'the hidden descendant\'s live field content must never reach the response');
  const permCheck = requestedIdentities.find(r => r.url.includes('/permissions/check'));
  assert.ok(permCheck, 'evidence must check descendant visibility before returning tree content');
  assert.equal(permCheck.identity, 'user', 'visibility must be checked with the viewer\'s own privilege, not asApp()');
});

test('evidence and panel state hide a hidden descendant\'s changed-field content, not just its key', async () => {
  const hiddenId = logicalNodeId('9');
  const visibleId = logicalNodeId('100');
  const f = fixture({
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), tree_hash: 'abc', node_count: 3, edge_count: 2, total_field_count: 3,
      from_status_id: '100', to_status_id: '200', transition_id: '31'
    }),
    readBaselineTree: async () => ({
      nodes: [
        { logicalNodeId: logicalNodeId('10'), issueKey: 'T-10', parentLogicalId: null, digests: { summary: 'baseline-root' } },
        { logicalNodeId: hiddenId, issueKey: 'NEW-9', parentLogicalId: logicalNodeId('10'), digests: { summary: 'baseline-hidden' } },
        { logicalNodeId: visibleId, issueKey: 'NEW-10', parentLogicalId: logicalNodeId('10'), digests: { summary: 'baseline-visible' } }
      ],
      values: {
        [hiddenId]: { summary: 'secret-before' },
        [visibleId]: { summary: 'visible-before' }
      }
    }),
    request: async (identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        const body = JSON.parse(options.body);
        return response({ projectPermissions: [{
          permission: 'BROWSE_PROJECTS',
          // NEW-9's id (9) is denied: simulates an Issue Security Scheme
          // hiding that one issue from this viewer.
          issues: body.projectPermissions[0].issues.filter(id => String(id) !== '9')
        }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        if (String(options.body).includes('T-10')) {
          return response({ issues: [
            { id: '9', key: 'NEW-9', fields: { summary: 'secret-after', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
            { id: '100', key: 'NEW-10', fields: { summary: 'visible-after', parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } }
          ] });
        }
        return response({ issues: [] });
      }
      return response({ ...f.issue, fields: { ...f.issue.fields, parent: null } });
    }
  });

  const evidence = await getEvidence(args);
  assert.ok(!evidence.drift.fields.some(field => String(field.fieldId).startsWith(hiddenId)),
    'a hidden descendant\'s changed field must not reach evidence.drift.fields');
  assert.ok(!JSON.stringify(evidence).includes('secret'),
    'the hidden descendant\'s key and retained content must never reach evidence');
  assert.ok(evidence.drift.fields.some(field => String(field.fieldId).startsWith(visibleId)),
    'a visible descendant\'s changed field must still reach evidence.drift.fields');
  assert.equal(evidence.drift.count, evidence.drift.fields.length,
    'the visible count must not include hidden descendant changes');
  assert.deepEqual(evidence.drift.mixed, { eligible: false, reason: 'HIDDEN_CHANGES', fields: [] },
    'an exact decision map cannot be built from what this viewer may see, and nothing hidden is named');

  const state = await getState(args);
  assert.ok(!state.drift.fields.some(field => String(field.fieldId).startsWith(hiddenId)),
    'a hidden descendant\'s changed field must not reach panel:getState either');
  assert.ok(!JSON.stringify(state).includes('secret'),
    'the hidden descendant\'s key and retained content must never reach panel state');
  assert.equal(state.drift.count, state.drift.fields.length,
    'panel state must count only changes visible to this reviewer');
});

// ── Child baselines (2026-09-24): the parent's review, grouped by issue ───────

function familyFixture({ liveChild, liveRoot = 'approved text', childOwn = { version: 6, summary: 'child own v6', after: true } } = {}) {
  const fields = [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, writable: true, materiality: 'MAJOR' }];
  const digests = value => project({ summary: value }, fields).digests;
  const rootId = logicalNodeId('10');
  const childId = logicalNodeId('100');
  const parentBaseline = { baseline_id: Buffer.alloc(16, 1), issue_id: 10, version: 3, tree_hash: 'abc', node_count: 2,
    edge_count: 1, total_field_count: 2, from_status_id: '100', to_status_id: '200', transition_id: '31',
    required_role: 'reviewer', required_assurance: 'ESIGNATURE', captured_at: NOW - 5000 };
  const childBaseline = childOwn && { baseline_id: Buffer.alloc(16, 7), issue_id: 100, version: childOwn.version, tree_hash: null,
    field_digests: JSON.stringify(digests(childOwn.summary)), captured_by_baseline_id: null,
    captured_at: childOwn.after ? NOW - 1000 : NOW - 9000 };
  const node = (id, key, parent, value) => {
    const n = { logicalNodeId: id, issueKey: key, parentLogicalNodeId: parent, currentIssueId: Number(key === 'T-10' ? 10 : 100),
      originalIssueId: Number(key === 'T-10' ? 10 : 100), projectId: 1, issueTypeId: '1', fieldDigests: JSON.stringify(digests(value)) };
    Object.defineProperties(n, { parentLogicalId: { value: parent, enumerable: false }, digests: { value: digests(value), enumerable: false } });
    return n;
  };
  const f = fixture({
    fields,
    controlledFields: async () => fields,
    activeBaseline: async () => parentBaseline,
    activeBaselines: async ids => new Map(childBaseline && ids.map(Number).includes(100) ? [[100, childBaseline]] : []),
    readAllValues: async (issueId, version) => (Number(issueId) === 100
      ? (assert.equal(Number(version), childOwn.version), { summary: childOwn.summary })
      : { summary: 'approved text' }),
    readBaselineTree: async () => ({
      nodes: [node(rootId, 'T-10', null, 'approved text'), node(childId, 'NEW-10', rootId, 'captured by parent')],
      values: { [rootId]: { summary: 'approved text' }, [childId]: { summary: 'captured by parent' } }
    }),
    request: async (_identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (String(url).includes('/changelog')) return response({ values: [], total: 0, isLast: true });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        const body = JSON.parse(options.body);
        return response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: body.projectPermissions[0].issues }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        return response({ issues: String(options.body).includes('T-10') ? [{ id: '100', key: 'NEW-10',
          fields: { summary: liveChild, parent: { id: '10' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } }] : [] });
      }
      return response({ id: '10', key: 'T-10', fields: { summary: liveRoot, parent: null, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } });
    }
  });
  return { f, rootId, childId };
}

test('a parent\'s review shows a drifted child against the child\'s OWN latest baseline, in its own section', async () => {
  const { childId } = familyFixture({ liveChild: 'live edit' });
  const evidence = await getEvidence(args);
  assert.equal(evidence.error, undefined, JSON.stringify(evidence));
  assert.equal(evidence.drift.count, 1);
  assert.deepEqual(evidence.drift.groups.map(g => [g.kind, g.issueKey, g.isRoot, g.baselineVersion, g.fields.length]),
    [['ISSUE', 'NEW-10', false, 6, 1]]);
  const [field] = evidence.drift.groups[0].fields;
  assert.equal(field.fieldId, `${childId}:summary`);
  assert.equal(field.label, 'Summary');
  assert.equal(field.before, 'child own v6', 'compared with the child\'s own v6, not the parent\'s stored node');
  assert.equal(field.after, 'live edit');
  const state = await getState(args);
  assert.deepEqual(state.drift.groups.map(g => g.issueKey), ['NEW-10']);
});

test('a changed descendant carries its stored actor and edit time into the Changes evidence', async () => {
  const { f } = familyFixture({ liveChild: 'live edit' });
  f.driftForIssueVersions = async pairs => {
    assert.deepEqual(pairs, [{ issueId: 100, version: 6 }]);
    return { rows: [{ issue_id: 100, baseline_version: 6, field_id: 'summary',
      actor_name: 'Sam', actor_account_id: 'sam', occurred_at: NOW - 100, source: 'USER', detected_via: 'EVENT', key: 'd1' }], truncated: false };
  };
  const result = await getEvidence(args);
  const child = result.drift.fields.find(field => field.issueKey === 'NEW-10');
  assert.equal(child.lastChangedBy, 'Sam');
  assert.equal(child.lastChangedAt, NOW - 100);
  assert.equal(child.attribution[0].detected, false);
});

test('a child matching its own newer baseline is not a change in the parent\'s review', async () => {
  familyFixture({ liveChild: 'child own v6' });
  const evidence = await getEvidence(args);
  assert.equal(evidence.drift.count, 0);
  assert.deepEqual(evidence.drift.groups, []);
});

test('the parent\'s own change comes first, then each child, each in its own section', async () => {
  familyFixture({ liveChild: 'live edit', liveRoot: 'root edited' });
  const evidence = await getEvidence(args);
  assert.deepEqual(evidence.drift.groups.map(g => [g.issueKey, g.isRoot, g.baselineVersion]),
    [['T-10', true, 3], ['NEW-10', false, 6]]);
  assert.equal(evidence.drift.count, 2);
});

test('a child baselined only before its parent\'s capture is compared with the parent\'s stored node, as before', async () => {
  familyFixture({ liveChild: 'captured by parent', childOwn: { version: 2, summary: 'older own', after: false } });
  const evidence = await getEvidence(args);
  assert.equal(evidence.drift.count, 0, 'matches what the parent captured; the older own baseline does not win');
});

test('tree baseline record reads signed root values and does not present fields added later as approved', async () => {
  const { f, rootId } = familyFixture({ liveChild: 'captured by parent' });
  f.fields.push({ field_id: 'customfield_5', field_name: 'Added later', field_kind: 'TEXT', store_values: true });
  f.controlledFields = async () => f.fields;
  const readTree = f.readBaselineTree;
  f.readBaselineTree = async (...params) => {
    const tree = await readTree(...params);
    for (const node of tree.nodes) {
      const historical = JSON.parse(node.fieldDigests);
      delete historical.customfield_5;
      node.fieldDigests = JSON.stringify(historical);
    }
    return tree;
  };
  const read = f.request;
  f.request = async (...request) => {
    const response = await read(...request);
    if (!response.ok) return response;
    return { ...response, json: async () => {
      const body = await response.json();
      if (body?.fields?.summary != null) body.fields.customfield_5 = null;
      if (Array.isArray(body?.issues)) for (const item of body.issues) item.fields.customfield_5 = null;
      return body;
    } };
  };
  const result = await getEvidence(args);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.record.fields.map(field => field.fieldId), ['summary']);
  assert.equal(result.record.fields[0].preview.text, 'approved text');
  assert.ok(rootId);
});

test('version comparison reads two saved versions, while refusing unpublished versions and an unreadable root', async () => {
  const { f, rootId } = familyFixture({ liveChild: 'captured by parent' });
  const first = { ...await f.activeBaseline(), version: 1, baseline_id: Buffer.alloc(16, 4) };
  const latest = await f.activeBaseline();
  f.baselineByVersion = async (_issueId, version) => Number(version) === 1 ? first : Number(version) === 3 ? latest : null;
  f.readBaselineTree = async id => ({
    nodes: [{ logicalNodeId: rootId, issueKey: 'T-10', originalIssueId: 10, currentIssueId: 10,
      parentLogicalNodeId: null, fieldDigests: JSON.stringify(project({ summary: Buffer.from(id).equals(first.baseline_id) ? 'first' : 'latest' }, f.fields.slice(0, 1)).digests) }],
    values: { [rootId]: { summary: Buffer.from(id).equals(first.baseline_id) ? 'first' : 'latest' } }
  });
  const result = await compareVersions({ payload: { issueKey: 'T-10', fromVersion: 1, toVersion: 3 }, context: { accountId: 'reviewer-1' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].before, 'first');
  assert.equal(result.fields[0].after, 'latest');
  const unpublished = await compareVersions({ payload: { issueKey: 'T-10', fromVersion: 2, toVersion: 3 }, context: { accountId: 'reviewer-1' } });
  assert.ok(unpublished.error);
  const oldRequest = f.request;
  f.request = async (...request) => String(request[1]).includes('/issue/T-10?fields=')
    ? { ok: false, status: 403 } : oldRequest(...request);
  const denied = await compareVersions({ payload: { issueKey: 'T-10', fromVersion: 1, toVersion: 3 }, context: { accountId: 'reviewer-1' } });
  assert.equal(denied.reason, 'ISSUE_ACCESS_DENIED');
});

test('version comparison names the work item by its key, never by its internal node id', async () => {
  const { f, rootId } = familyFixture({ liveChild: 'captured by parent' });
  const first = { ...await f.activeBaseline(), version: 1, baseline_id: Buffer.alloc(16, 4) };
  const latest = await f.activeBaseline();
  f.baselineByVersion = async (_issueId, version) => Number(version) === 1 ? first : latest;
  // A saved node that carries no issue key — how a single-issue baseline is read.
  f.readBaselineTree = async id => {
    const value = Buffer.from(id).equals(first.baseline_id) ? 'first' : 'latest';
    return { nodes: [{ logicalNodeId: rootId, issueKey: null, originalIssueId: 10, currentIssueId: 10,
      parentLogicalNodeId: null, fieldDigests: JSON.stringify(project({ summary: value }, f.fields.slice(0, 1)).digests) }],
    values: { [rootId]: { summary: value } } };
  };
  const result = await compareVersions({ payload: { issueKey: 'T-10', fromVersion: 1, toVersion: 3 }, context: { accountId: 'reviewer-1' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.fields[0].issueKey, 'T-10');
  assert.equal(result.fields[0].group.issueKey, 'T-10');
  assert.doesNotMatch(JSON.stringify(result.fields.map(field => [field.issueKey, field.fieldName, field.group?.issueKey])), new RegExp(rootId));
});

test('version comparison hides historical descendants the viewer cannot browse', async () => {
  const { f, rootId, childId } = familyFixture({ liveChild: 'captured by parent' });
  const latest = await f.activeBaseline();
  const first = { ...latest, version: 1, baseline_id: Buffer.alloc(16, 4) };
  f.baselineByVersion = async (_issueId, version) => Number(version) === 1 ? first : latest;
  f.readBaselineTree = async id => {
    const secret = Buffer.from(id).equals(first.baseline_id) ? 'before secret' : 'after secret';
    const digests = value => JSON.stringify(project({ summary: value }, f.fields).digests);
    return { nodes: [
      { logicalNodeId: rootId, issueKey: 'T-10', originalIssueId: 10, currentIssueId: 10,
        parentLogicalNodeId: null, projectId: 1, issueTypeId: '1', fieldDigests: digests('root') },
      { logicalNodeId: childId, issueKey: 'SECRET-11', originalIssueId: 100, currentIssueId: 100,
        parentLogicalNodeId: rootId, projectId: 1, issueTypeId: '1', fieldDigests: digests(secret) }
    ], values: { [rootId]: { summary: 'root' }, [childId]: { summary: secret } } };
  };
  const read = f.request;
  f.request = async (...request) => String(request[1]).includes('/permissions/check')
    ? { ok: true, json: async () => ({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [10] }] }) }
    : read(...request);
  const result = await compareVersions({ payload: { issueKey: 'T-10', fromVersion: 1, toVersion: 3 }, context: { accountId: 'reviewer-1' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.fields.length, 0);
  assert.equal(result.incomplete, true, 'unreadable historical nodes must not look like an exact match');
  assert.doesNotMatch(JSON.stringify(result), /SECRET-11|before secret|after secret/);
});

test('a deleted historical child makes the comparison incomplete without disclosing its saved content', async () => {
  const { f, rootId, childId } = familyFixture({ liveChild: 'captured by parent' });
  const latest = await f.activeBaseline();
  const first = { ...latest, version: 1, baseline_id: Buffer.alloc(16, 4) };
  f.baselineByVersion = async (_issueId, version) => Number(version) === 1 ? first : latest;
  f.readBaselineTree = async id => {
    const nodes = [{ logicalNodeId: rootId, issueKey: 'T-10', originalIssueId: 10, currentIssueId: 10,
      parentLogicalNodeId: null, projectId: 1, issueTypeId: '1', fieldDigests: JSON.stringify(project({ summary: 'root' }, f.fields).digests) }];
    const values = { [rootId]: { summary: 'root' } };
    if (Buffer.from(id).equals(first.baseline_id)) {
      nodes.push({ logicalNodeId: childId, issueKey: 'DELETED-11', originalIssueId: 100, currentIssueId: 100,
        parentLogicalNodeId: rootId, projectId: 1, issueTypeId: '1', fieldDigests: JSON.stringify(project({ summary: 'old secret' }, f.fields).digests) });
      values[childId] = { summary: 'old secret' };
    }
    return { nodes, values };
  };
  const read = f.request;
  f.request = async (...request) => String(request[1]).includes('/permissions/check')
    ? { ok: true, json: async () => ({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [10] }] }) }
    : read(...request);
  const result = await compareVersions({ payload: { issueKey: 'T-10', fromVersion: 1, toVersion: 3 }, context: { accountId: 'reviewer-1' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.incomplete, true);
  assert.equal(result.fields.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /DELETED-11|old secret/);
});

test('a tree review with only visible field changes is offered field by field, naming each field once', async () => {
  const rootId = logicalNodeId('10');
  const f = fixture({
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), tree_hash: 'abc', node_count: 1, edge_count: 0, total_field_count: 1,
      from_status_id: '100', to_status_id: '200', transition_id: '31'
    }),
    readBaselineTree: async () => ({
      nodes: [{ logicalNodeId: rootId, issueKey: 'T-10', parentLogicalId: null, digests: { summary: 'baseline-root' } }],
      values: { [rootId]: { summary: 'before' } }
    }),
    request: async (identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        return response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: JSON.parse(options.body).projectPermissions[0].issues }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) return response({ issues: [] });
      return response({ ...f.issue, fields: { ...f.issue.fields, parent: null } });
    }
  });
  f.issue.fields.summary = 'edited after approval';
  const evidence = await getEvidence(args);
  assert.equal(evidence.drift.mixed.eligible, true, JSON.stringify(evidence.drift.mixed));
  assert.deepEqual(evidence.drift.mixed.fields.map(field => field.fieldId), evidence.drift.fields.map(field => field.fieldId));
  assert.ok(evidence.drift.mixed.fields.every(field => field.fieldId.startsWith(rootId)), 'identity is node and field together');
});

test('a child opened from See changes gets its subtree and field decisions from its parent-captured baseline', async () => {
  const fields = [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, writable: true, materiality: 'MAJOR' }];
  const childId = logicalNodeId('57');
  const grandchildId = logicalNodeId('59');
  const parentId = logicalNodeId('56');
  const digests = value => project({ summary: value }, fields).digests;
  const parentBaseline = { baseline_id: Buffer.alloc(16, 9), issue_id: 56, version: 3, tree_hash: 'parent-tree',
    node_count: 3, edge_count: 2, total_field_count: 3, captured_at: NOW - 5000 };
  const childBaseline = { baseline_id: Buffer.alloc(16, 7), issue_id: 57, version: 3, tree_hash: null,
    field_digests: JSON.stringify(digests('child approved')), captured_by_baseline_id: parentBaseline.baseline_id,
    captured_at: NOW - 5000 };
  const node = (logicalNodeId, issueId, issueKey, parentLogicalId, value) => {
    const result = { logicalNodeId, originalIssueId: issueId, currentIssueId: issueId, issueKey, parentLogicalNodeId: parentLogicalId,
      projectId: 1, issueTypeId: '1', fieldDigests: JSON.stringify(digests(value)) };
    Object.defineProperties(result, { parentLogicalId: { value: parentLogicalId, enumerable: false }, digests: { value: digests(value), enumerable: false } });
    return result;
  };
  const f = fixture({
    gateActiveOutOf: async () => ({ required_assurance: 'ESIGNATURE', required_role: 'reviewer', meaning: 'Reviewed',
      capture_baseline: false, block_on_drift: true, gated: true }),
    gatedTransition: async () => ({ required_assurance: 'ESIGNATURE', required_role: 'reviewer', meaning: 'Reviewed',
      capture_baseline: false, block_on_drift: true, gated: true }),
    issue: { id: '57', key: 'VAT-57', fields: { summary: 'child live', parent: { id: '56' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } },
    fields, controlledFields: async () => fields,
    activeBaseline: async () => childBaseline,
    baselineById: async id => Buffer.from(id).equals(parentBaseline.baseline_id) ? parentBaseline : null,
    readAllValues: async issueId => Number(issueId) === 57 ? { summary: 'child approved' } : { summary: 'grand approved' },
    readBaselineTree: async () => ({ nodes: [
      node(parentId, 56, 'VAT-56', null, 'parent approved'),
      node(childId, 57, 'VAT-57', parentId, 'parent capture child'),
      node(grandchildId, 59, 'VAT-59', childId, 'grand approved')
    ], values: {
      [parentId]: { summary: 'parent approved' },
      [childId]: { summary: 'parent capture child' },
      [grandchildId]: { summary: 'grand approved' }
    } }),
    request: async (_identity, url, options = {}) => {
      const response = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
      if (String(url).includes('/editmeta')) return response({ fields: {} });
      if (String(url).includes('/changelog')) return response({ values: [], total: 0, isLast: true });
      if (options.method === 'POST' && String(url).includes('/permissions/check')) {
        return response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: JSON.parse(options.body).projectPermissions[0].issues }] });
      }
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        return response({ issues: String(options.body).includes('VAT-57') ? [{ id: '59', key: 'VAT-59', fields: {
          summary: 'grand live', parent: { id: '57' }, project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' }
        } }] : [] });
      }
      return response(f.issue);
    }
  });
  const evidence = await getEvidence({ payload: { issueKey: 'VAT-57' }, context: { accountId: 'reviewer-1' } });
  assert.equal(evidence.error, undefined, JSON.stringify(evidence));
  assert.equal(evidence.drift.mixed.eligible, true, JSON.stringify(evidence.drift.mixed));
  assert.deepEqual(evidence.drift.groups.map(group => group.issueKey), ['VAT-57', 'VAT-59']);
  assert.deepEqual(evidence.drift.fields.map(field => field.issueKey), ['VAT-57', 'VAT-59']);
});
