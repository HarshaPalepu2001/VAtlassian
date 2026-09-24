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
  // trackedFields.js imports these; getSummary never calls them, and the
  // poisoned list above is what enforces that boundary.
  'db/configStore.js': ['gatedTransition', 'controlledFields', 'declaredFieldRows',
    'seedControlledFields', 'countControlledFields'],
  'db/itemStateStore.js': ['getReview'],
  'db/approvalStore.js': ['latestApproval', 'pendingApprovalForActor'],
  'db/incidentStore.js': ['adminIncidentCount'],
  'db/credentialStore.js': ['credentialState'],
  'db/adminStore.js': ['isActiveAdmin'],
  'db/restoreStore.js': ['restoresForIssue'],
  'lib/reviewer.js': ['isEligible'],
  'lib/transitions.js': ['availableTransitions'],
  'db/baselineTreeStore.js': ['activeRootsForNode', 'rootNodeDigests']
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
const { project } = await import('../src/lib/content.js');
hooks.deregister();

/** One tracked field, and the digest map a baseline over it would carry. */
const TRACKED = [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' }];
const digestsFor = value => JSON.stringify(project({ summary: value }, TRACKED).digests);

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
    controlledFields: async () => [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' }],
    isEligible: async () => true,
    activeRootsForNode: async () => [],
    rootNodeDigests: async () => null,
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

// The issue read is now `*all`, DELIBERATELY. Drift is derived from the
// content, and content cannot be compared without reading it. What this test
// protects is the boundary that actually costs latency: the number of round
// trips, and the four readers poisoned at the top of this file. Widening the
// field list on a request the summary already makes adds no round trip.
test('summary reads the issue once, and reads no other Jira resource', async () => {
  const issueReads = [];
  fixture({
    request: async (_identity, url) => {
      if (String(url).includes('/issue/')) issueReads.push(String(url));
      const response = body => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/myself')) return response({ displayName: 'A reviewer' });
      return response({ id: '10', key: 'T-10',
        fields: { summary: 'a signed item', project: { id: '1' }, issuetype: { id: '1' }, status: { id: '100' } } });
    }
  });
  await getSummary(args);
  assert.equal(issueReads.length, 1, 'one issue read, however wide it is');
  assert.match(issueReads[0], /fields=\*all/, 'wide enough to compare content against the signature');
  assert.doesNotMatch(issueReads[0], /editmeta|changelog|expand=/);
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

test('an unavailable admin incident read preserves the summary with an explicit unavailable state', async () => {
  fixture({ isActiveAdmin: async () => true, adminIncidentCount: async () => { throw new Error('storage unavailable'); } });
  const summary = await getSummary(args);
  assert.equal(summary.error, undefined);
  assert.equal(summary.adminIncidentUnavailable, true);
});

// ─── Eligibility is a fact about the viewer, not about the counter ───────────
//
// VJIRA-17: the panel showed "1 change since approval · 1 changed field" and
// refused to let the viewer decide it, saying "only Reviewer can decide them"
// to someone who held Reviewer on that project and work item type.
//
// `decidesDrift` short-circuited on `va_item_state.drift_count`, so when the
// stored counter said 0 while the live re-diff the panel was rendering said 1,
// isEligible() was never called at all. The role in that sentence had never
// been checked — it was a fallback string.
//
// The summary now reports eligibility on its own, so the client can pair it
// with whichever count it is actually displaying, and a viewer is never told a
// role is the reason when the role was not consulted.

const baselineWithRole = () => ({
  baseline_id: Buffer.alloc(16, 1), version: 3, transition_id: '31',
  from_status_id: '100', to_status_id: '200',
  required_role: 'baseline-signer', required_assurance: 'ESIGNATURE',
  controlled_fields_hash: 'a'.repeat(64),
  field_digests: digestsFor('the approved text')
});

test('eligibility is reported even when there is no drift to decide', async () => {
  const f = fixture({
    isEligible: async ({ role }) => role === 'baseline-signer',
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: baselineWithRole,
    // The counter the restore zeroed; the content is genuinely clean.
    getReview: async () => ({ state: 'BASELINED', version: 2, baseline_version: 3, drift_count: 0, drifted_field_count: 0 }),
    controlledFields: async () => TRACKED
  });
  f.issue.fields.summary = 'the approved text';
  const summary = await getSummary(args);

  assert.equal(summary.drift.count, 0);
  assert.equal(summary.drift.decidesDrift, false, 'nothing to decide');
  assert.equal(summary.drift.eligible, true, 'but this viewer WOULD be allowed to decide it');
});

test('a viewer without the baseline role is reported ineligible, counter or not', async () => {
  fixture({
    isEligible: async () => false,
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: baselineWithRole,
    getReview: async () => ({ state: 'BASELINED', version: 2, baseline_version: 3, drift_count: 0, drifted_field_count: 0 })
  });
  const summary = await getSummary(args);

  assert.equal(summary.drift.eligible, false);
});

test('an item with no baseline reports no drift eligibility to anyone', async () => {
  fixture({
    isEligible: async () => true,
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: async () => null,
    getReview: async () => ({ state: 'BASELINED', version: 2, drift_count: 0, drifted_field_count: 0 })
  });
  const summary = await getSummary(args);

  assert.equal(summary.drift.eligible, false);
});

test('recorded drift the viewer is eligible for still decides, exactly as before', async () => {
  fixture({
    isEligible: async ({ role }) => role === 'baseline-signer',
    gatedTransition: async () => null,
    availableTransitions: async () => [],
    activeBaseline: baselineWithRole,
    getReview: async () => ({ state: 'DRIFTED', version: 2, baseline_version: 3, drift_count: 1, drifted_field_count: 1 })
  });
  const summary = await getSummary(args);

  assert.equal(summary.drift.decidesDrift, true);
  assert.equal(summary.drift.eligible, true);
  assert.equal(summary.drift.canApprove, true);
});

// ─── The count is derived from the issue, not carried on the state row ──────
//
// A stored counter is a second answer to a question the content already
// settles, and on VJIRA-17 the two disagreed permanently: va_item_state said 0
// while the live comparison said one field had moved. Drift IS "the content no
// longer matches the digests the signature covers", so the summary computes it
// the same way the collector does — lib/interception.js's driftedFields() is
// the single implementation both call.

const signedBaseline = (approvedSummary) => async () => ({
  baseline_id: Buffer.alloc(16, 1), version: 3, transition_id: '31',
  from_status_id: '100', to_status_id: '200',
  required_role: 'reviewer', required_assurance: 'ESIGNATURE',
  controlled_fields_hash: 'a'.repeat(64),
  field_digests: digestsFor(approvedSummary)
});

test('drift is counted from the live issue even when the stored counter says zero', async () => {
  const f = fixture({
    activeBaseline: signedBaseline('the approved text'),
    controlledFields: async () => TRACKED,
    getReview: async () => ({ state: 'BASELINED', version: 2, baseline_version: 3, drift_count: 0, drifted_field_count: 0 })
  });
  f.issue.fields.summary = 'edited after approval';

  const summary = await getSummary(args);

  assert.equal(summary.drift.count, 1, 'the content moved, so there is drift to decide');
  assert.equal(summary.drift.decidesDrift, true);
  assert.equal(summary.drift.canApprove, true);
});

test('a stale counter cannot invent drift on content that matches its baseline', async () => {
  const f = fixture({
    activeBaseline: signedBaseline('the approved text'),
    controlledFields: async () => TRACKED,
    // A counter left high by an interrupted decision.
    getReview: async () => ({ state: 'DRIFTED', version: 2, baseline_version: 3, drift_count: 5, drifted_field_count: 5 })
  });
  f.issue.fields.summary = 'the approved text';

  const summary = await getSummary(args);

  assert.equal(summary.drift.count, 0, 'the content matches the signature, so nothing is outstanding');
  assert.equal(summary.drift.decidesDrift, false);
});

test('an unreadable baseline over-reports rather than reporting clean', async () => {
  // Same rule as the collector: an absence of digests is not evidence of a
  // match, and concluding "clean" from it would report a corrupt baseline as
  // an approved one.
  const f = fixture({
    activeBaseline: async () => ({
      baseline_id: Buffer.alloc(16, 1), version: 3, transition_id: '31',
      from_status_id: '100', to_status_id: '200', required_role: 'reviewer',
      required_assurance: 'ESIGNATURE', controlled_fields_hash: 'a'.repeat(64),
      field_digests: '{}'
    }),
    controlledFields: async () => TRACKED,
    getReview: async () => ({ state: 'BASELINED', version: 2, baseline_version: 3, drift_count: 0, drifted_field_count: 0 })
  });
  f.issue.fields.summary = 'anything at all';

  assert.equal((await getSummary(args)).drift.count, 1);
});

test('an item with no baseline has nothing to drift from', async () => {
  const f = fixture({ controlledFields: async () => TRACKED });
  f.issue.fields.summary = 'never approved';

  assert.equal((await getSummary(args)).drift.count, 0);
});

test('the summary carries the content hash, so the panel can key its diff on the content', async () => {
  // review.version alone only moves when the collector writes a row, which is
  // exactly what lags. The content's own hash moves on every edit.
  const f = fixture({
    activeBaseline: signedBaseline('the approved text'),
    controlledFields: async () => TRACKED,
    getReview: async () => ({ state: 'BASELINED', version: 2, baseline_version: 3, drift_count: 0, drifted_field_count: 0 })
  });
  f.issue.fields.summary = 'the approved text';
  const clean = await getSummary(args);

  f.issue.fields.summary = 'edited, and no row written yet';
  const dirty = await getSummary(args);

  assert.match(clean.contentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(dirty.contentHash, clean.contentHash, 'an edit must change the key');
  assert.equal(dirty.evidenceVersion, clean.evidenceVersion, 'even though the row version did not move');
});

// A baseline captured by a controlled transition is a TREE baseline: its field
// digests live on the tree's nodes (va_baseline_node) and the va_baseline row
// carries field_digests '{}' (lib/capture.js). Comparing against that empty
// map "failed towards drift" on every read, so the panel said "Changes since
// approval need a decision" forever — even straight after a verified restore.
const treeBaseline = () => ({
  baseline_id: Buffer.alloc(16, 2), version: 2, transition_id: '31',
  from_status_id: '100', to_status_id: '200', approved_by: 'reviewer-1',
  required_role: 'reviewer', required_assurance: 'ESIGNATURE',
  controlled_fields_hash: 'a'.repeat(64), tree_hash: 't'.repeat(64), field_digests: '{}'
});

test('a tree baseline is compared against its root node, so matching content reads clean', async () => {
  const asked = [];
  fixture({
    activeBaseline: async () => treeBaseline(),
    rootNodeDigests: async (baselineId, issueId) => { asked.push([baselineId, issueId]); return digestsFor('a signed item'); }
  });
  const summary = await getSummary(args);
  assert.equal(summary.drift.count, 0);
  assert.notEqual(summary.state, 'Changes since approval need a decision');
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], 10);
});

test('a tree baseline still reports a real change to the root', async () => {
  fixture({
    activeBaseline: async () => treeBaseline(),
    rootNodeDigests: async () => digestsFor('what was signed')
  });
  const summary = await getSummary(args);
  assert.equal(summary.drift.count, 1);
  assert.equal(summary.state, 'Changes since approval need a decision');
});

test('a tree baseline whose root cannot be read still over-reports rather than reporting clean', async () => {
  fixture({
    activeBaseline: async () => treeBaseline(),
    rootNodeDigests: async () => { throw new Error('storage unavailable'); }
  });
  const summary = await getSummary(args);
  assert.equal(summary.drift.count, 1);
});
