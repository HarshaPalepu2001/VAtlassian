import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { logicalNodeId } from '../src/lib/tree/model.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@forge/api' ? { url: 'viewer:api', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url !== 'viewer:api') return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({ requestJira: (...a) => globalThis.viewerRequest(...a) }) };` };
  }
});
const { viewerProjection, projectRestore } = await import('../src/usecases/viewerProjection.js');
hooks.deregister();

const prepared = { issueId: 10, issueKey: 'T-10', nodes: [
  { currentIssueId: 11, issueKey: 'T-11', logicalNodeId: logicalNodeId(11) },
  { currentIssueId: 99, issueKey: 'SECRET-99', logicalNodeId: logicalNodeId(99) }
] };
const entries = [
  { issueKey: 'T-10', fieldId: 'summary', actual: 'root' },
  { issueKey: 'T-11', actual: 'visible' }, { issueKey: 'SECRET-99', actual: 'hidden' },
  { issueKey: 'NEW-777', actual: 'visible-new' }
];
const response = body => ({ ok: true, json: async () => body });

test('projection batches numeric browse checks and resolves new key-only children as the viewer', async () => {
  const requests = [];
  globalThis.viewerRequest = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return String(url).includes('/search/jql') ? response({ issues: [{ id: '777', key: 'NEW-777' }], isLast: true })
      : response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [11, 777] }] });
  };
  const viewer = await viewerProjection({ ...prepared, values: entries });
  assert.deepEqual(entries.map(viewer.entry).filter(Boolean).map(row => row.actual), ['root', 'visible', 'visible-new']);
  assert.equal(requests.length, 2, 'one key lookup and one bulk permission check, independent of field count');
  assert.deepEqual(requests.find(request => request.url.includes('/permissions/check')).body.projectPermissions[0].issues.sort((a,b) => a-b), [11, 99, 777]);
});

test('refused, thrown and incomplete child permission checks expose only the already-readable root', async () => {
  for (const permission of [() => ({ ok: false }), () => { throw new Error('consent refused'); },
    () => response({}), () => response({ projectPermissions: [{ permission: 'EDIT_ISSUES', issues: [11, 99] }] }),
    () => response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS' }] })]) {
    globalThis.viewerRequest = async url => String(url).includes('/search/jql') ? response({ issues: [], isLast: true }) : permission();
    const viewer = await viewerProjection({ ...prepared, values: entries });
    assert.deepEqual(entries.map(viewer.entry).filter(Boolean), [{ issueKey: 'T-10', fieldId: 'summary', actual: 'root' }]);
    assert.equal(viewer.entry({ logicalNodeId: 'unknown-logical-id', currentDigest: 'hidden' }), null);
  }
});

test('baseline-only removed-node history retains approved evidence without returning current values or nested plans', async () => {
  globalThis.viewerRequest = async () => ({ ok: false });
  const viewer = await viewerProjection({ ...prepared, values: [] });
  const row = projectRestore({ state: 'PARTIAL', detail: [{ unmatched: [
    { logicalNodeId: 'deleted-baseline-node', issueKey: 'OLD-12', kind: 'NODE_REMOVED', expected: 'approved-digest',
      actual: 'private-current', currentDigest: 'private-current', error: { detail: 'private-error' } }
  ], plan: { steps: [{ issueKey: 'SECRET-99' }] } }] }, viewer);
  assert.equal(row.detail[0].unmatched[0].issueKey, 'OLD-12');
  assert.equal(row.detail[0].unmatched[0].expected, 'approved-digest');
  assert.doesNotMatch(JSON.stringify(row), /private-|"plan"|SECRET-99/);
});

test('nested current references and free-text child keys are removed from otherwise visible restore detail', async () => {
  globalThis.viewerRequest = async url => String(url).includes('/search/jql') ? response({ issues: [], isLast: true })
    : response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [11] }] });
  const values = [{ issueKey: 'T-11', actual: { safe: 'visible', hidden: { issueId: 99, value: 'private' } },
    reason: 'issue 99 refused an update' }];
  const viewer = await viewerProjection({ ...prepared, values });
  assert.deepEqual(viewer.entry(values[0]), { issueKey: 'T-11', actual: { safe: 'visible' } });
});

test('nested dictionaries cannot disclose a protected child through an identity used as an object key', async () => {
  globalThis.viewerRequest = async () => response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [11] }] });
  const value = { issueKey: 'T-11', actual: { safe: 'visible', [logicalNodeId(99)]: { digest: 'private-current' } } };
  const viewer = await viewerProjection({ ...prepared, values: [value] });
  assert.deepEqual(viewer.entry(value), { issueKey: 'T-11', actual: { safe: 'visible' } });
});

test('permission requests stay within Jira bulk limits across baseline and restore history identities', async () => {
  const batches = [];
  globalThis.viewerRequest = async (_url, options) => {
    const ids = JSON.parse(options.body).projectPermissions[0].issues;
    batches.push(ids);
    return ids.length > 1000 ? { ok: false } : response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: ids }] });
  };
  const nodes = Array.from({ length: 1001 }, (_, index) => ({ id: index + 1000 }));
  const viewer = await viewerProjection({ issueId: 10, issueKey: 'T-10', nodes });
  assert.deepEqual(viewer.entry({ issueId: 1000, actual: 'first-visible' }), { issueId: 1000, actual: 'first-visible' });
  assert.deepEqual(viewer.entry({ issueId: 2000, actual: 'last-visible' }), { issueId: 2000, actual: 'last-visible' });
  assert.ok(batches.every(batch => batch.length <= 1000));
  assert.equal(batches.length, 2);
});

test('a failed numeric permission batch hides only that batch and never grants its children', async () => {
  globalThis.viewerRequest = async (_url, options) => {
    const ids = JSON.parse(options.body).projectPermissions[0].issues;
    return ids.includes(2000) ? { ok: false } : response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: ids }] });
  };
  const nodes = Array.from({ length: 1001 }, (_, index) => ({ id: index + 1000 }));
  const viewer = await viewerProjection({ issueId: 10, issueKey: 'T-10', nodes });
  assert.deepEqual(viewer.entry({ issueId: 1000, actual: 'visible' }), { issueId: 1000, actual: 'visible' });
  assert.equal(viewer.entry({ issueId: 2000, actual: 'private' }), null);
});

test('actual link refusal and copied reasons never expose numeric-only or unstructured private error text', async () => {
  const { opaqueRestoreEvidence, safeVerificationGuidance, assertOpaqueEvidenceHidden } = await import('./helpers/opaque-restore-evidence.js');
  globalThis.viewerRequest = async () => response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [11] }] });
  const detail = opaqueRestoreEvidence();
  const source = { state: 'PARTIAL', detail };
  const before = JSON.stringify(source);
  const viewer = await viewerProjection({ ...prepared, values: [source] });
  const projected = projectRestore(source, viewer);
  assertOpaqueEvidenceHidden(assert, projected);
  assert.equal(projected.detail[0].unmatched[0].issueKey, 'T-10');
  assert.equal(projected.detail[0].unmatched[0].fieldName, 'Issue links');
  assert.equal(projected.detail[0].unmatched[2].reason, safeVerificationGuidance);
  assert.ok(projected.detail[0].refused[0].error.detail);
  assert.equal(JSON.stringify(source), before, 'worker error detail and explainRefusals output stay authoritative');
});

test('real app-authored per-field verification guidance and readable child metadata remain useful', async () => {
  const { verifyTreeRestore } = await import('../src/lib/tree/restoreVerifier.js');
  const { opaqueRestoreEvidence, assertOpaqueEvidenceHidden } = await import('./helpers/opaque-restore-evidence.js');
  const verification = await verifyTreeRestore({
    readStableTree: async () => ({ tree: { nodes: [{ id: '10', key: 'T-10', fields: { summary: 'changed', parent: null } }] } }),
    readTree: async () => null, rootIssueKey: 'T-10',
    baselineTree: { nodes: [{ logicalNodeId: logicalNodeId(10), currentIssueId: 10, originalIssueId: 10,
      issueKey: 'T-10', parentLogicalNodeId: null, parentLogicalId: null, digests: { summary: 'approved-digest' } }] },
    controlledFields: [{ field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT' }]
  });
  assert.equal(verification.matches, false);
  globalThis.viewerRequest = async () => response({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [11] }] });
  const source = { state: 'PARTIAL', detail: [{ unmatched: verification.unmatched }, ...opaqueRestoreEvidence('T-11', 11)] };
  const viewer = await viewerProjection({ ...prepared, values: [source] });
  const result = projectRestore(source, viewer);
  assert.equal(result.detail[0].unmatched.find(entry => entry.fieldId === 'summary').reason,
    verification.unmatched.find(entry => entry.fieldId === 'summary').reason);
  assert.equal(result.detail[1].unmatched[0].issueKey, 'T-11');
  assert.equal(result.detail[1].unmatched[0].fieldName, 'Issue links');
  assert.ok(result.detail[1].refused[0].error.detail);
  assertOpaqueEvidenceHidden(assert, result);
});
