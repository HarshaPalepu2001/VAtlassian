import test from 'node:test';
import assert from 'node:assert/strict';
import { writeCapturedBaseline } from '../src/lib/capture.js';
import { project } from '../src/lib/content.js';

const fields = [{
  field_id: 'summary', field_kind: 'TEXT', schema_type: 'string',
  materiality: 'MAJOR', store_values: true, writable: false
}];
function fixture() {
  const args = { issueId: 1, issueKey: 'VA-1', projectId: 2, issueTypeId: '3', controlledFields: fields,
    issueFields: { summary: 'Approved' }, editmetaFields: { summary: {} }, transitionAt: 100, capturedAt: 100,
    transitionId: '31', fromStatusId: 'review', toStatusId: 'approved',
    requiredRole: 'Quality Reviewer', requiredAssurance: 'ESIGNATURE',
    ruleScope: { source: 'OWN', projectId: 2, issueTypeId: '3', imposedByBaselineId: null, imposedByVersion: null },
    approver: { approvalId: Buffer.alloc(16, 1), accountId: 'a', assuranceLevel: 'ESIGNATURE',
      contentHash: project({ summary: 'Approved' }, fields).contentHash } };
  const calls = [];
  let written = null;
  const deps = { baselineForApproval: async () => null, currentVersion: async () => 0,
    writeBaseline: async args => { calls.push('write'); written = args; return { baselineId: Buffer.alloc(16, 2) }; },
    assignReviewer: async () => ({ accountId: 'a' }), upsertBaselined: async () => calls.push('publish'),
    tryAppend: async () => calls.push('audit'), getReview: async () => null,
    activeBaselines: async () => new Map() };
  return { args, deps, calls, written: () => written };
}
test('capture refuses content that differs from the signature', async () => {
  const { args, deps, calls } = fixture(); args.issueFields.summary = 'Unreviewed';
  assert.equal((await writeCapturedBaseline(args, deps)).reason, 'CONTENT_CHANGED');
  assert.deepEqual(calls, []);
});
test('duplicate delivery never republishes an old baseline or clears drift', async () => {
  const { args, deps, calls } = fixture();
  deps.baselineForApproval = async () => ({ state: 'SUPERSEDED', version: 1, baseline_id: Buffer.alloc(16, 2) });
  const result = await writeCapturedBaseline(args, deps);
  assert.equal(result.alreadyCaptured, true);
  assert.deepEqual(calls, []);
});
test('an already published active baseline preserves its current review state', async () => {
  const { args, deps, calls } = fixture();
  deps.baselineForApproval = async () => ({ state: 'ACTIVE', version: 1, baseline_id: Buffer.alloc(16, 2) });
  deps.getReview = async () => ({ baseline_version: 1, state: 'DRIFTED' });
  assert.equal((await writeCapturedBaseline(args, deps)).alreadyCaptured, true);
  assert.deepEqual(calls, []);
});
test('new exact capture publishes only after all values are durable', async () => {
  const { args, deps, calls } = fixture();
  assert.equal((await writeCapturedBaseline(args, deps)).captured, true);
  assert.deepEqual(calls, ['write', 'publish', 'audit']);
});

// ── Concurrent version allocation ─────────────────────────────────────────
//
// Two DIFFERENT approvals racing the same issue can both read MAX(version)
// before either commits. idx_baseline_version(issue_id, version) turns the
// second write into a duplicate-key error rather than silent corruption;
// this proves that error is retried with a freshly read version instead of
// surfacing as a raw capture failure.

test('a version collision from a concurrent capture is retried with a freshly read version, not surfaced as a failure', async () => {
  const { args, deps, calls } = fixture();
  let versionReads = 0;
  deps.currentVersion = async () => { versionReads++; return versionReads === 1 ? 0 : 1; };
  let attempts = 0;
  deps.writeBaseline = async writeArgs => {
    attempts++;
    calls.push('write');
    if (attempts === 1) {
      const err = new Error('Duplicate entry for key idx_baseline_version');
      err.code = 'ER_DUP_ENTRY';
      throw err;
    }
    return { baselineId: Buffer.alloc(16, 2), version: writeArgs.baseline.version };
  };

  const result = await writeCapturedBaseline(args, deps);

  assert.equal(result.captured, true);
  assert.equal(attempts, 2, 'the collided write is retried, not abandoned');
  assert.equal(versionReads, 2, 'the retry re-reads the table rather than blindly incrementing');
  assert.equal(result.version, 2, 'the retry publishes under the freshly read version, not the stale collided one');
  assert.deepEqual(calls, ['write', 'write', 'publish', 'audit']);
});

test('a non-collision write failure is never retried or mistaken for a version race', async () => {
  const { args, deps, calls } = fixture();
  deps.writeBaseline = async () => { calls.push('write'); throw new Error('ECONNRESET'); };
  await assert.rejects(() => writeCapturedBaseline(args, deps), /ECONNRESET/);
  assert.deepEqual(calls, ['write'], 'a real failure surfaces on the first attempt, no retry loop consumed');
});

test('scalar capture freezes required policy separately from achieved assurance', async () => {
  const { args, deps, written } = fixture();
  args.approver.assuranceLevel = 'BIOMETRIC';

  assert.equal((await writeCapturedBaseline(args, deps)).captured, true);
  assert.equal(written().baseline.required_role, 'Quality Reviewer');
  assert.equal(written().baseline.required_assurance, 'ESIGNATURE');
  assert.equal(written().baseline.assurance_level, 'BIOMETRIC');
  assert.equal(
    written().baseline.controlled_fields_hash,
    'fd72aecbb8f6bb81b736aef9a8487475cbd738237f347353fbc93b37c8599e5f'
  );
});

test('scalar capture refuses to publish without complete policy provenance', async () => {
  const { args, deps, calls } = fixture();
  args.requiredRole = null;

  assert.deepEqual(
    await writeCapturedBaseline(args, deps),
    { captured: false, reason: 'BASELINE_POLICY_INCOMPLETE' }
  );
  assert.deepEqual(calls, []);
});

test('a capture hands the write its evidence, and the write must require it', async () => {
  const { args, deps, written } = fixture();
  assert.equal((await writeCapturedBaseline(args, deps)).captured, true);
  const { evidence } = written();
  assert.equal(evidence.required, true);
  assert.equal(evidence.cause, 'OWN_TRANSITION');
  assert.deepEqual(evidence.evidence.fields.map(f => [f.field_id, f.materiality, f.restorable]), [['summary', 'MAJOR', true]]);
  assert.equal(evidence.evidence.rules[0].source, 'OWN');
  assert.equal(evidence.evidence.rules[0].approvers, JSON.stringify([{ role: 'Quality Reviewer', assurance: 'ESIGNATURE' }]));
  assert.equal(evidence.evidence.signatures[0].signer_account_id, 'a');
  assert.equal(evidence.evidence.signatures[0].signer_name, 'a',
    'a signer with no display name is named by their account id, never "Unknown"');
  assert.equal(evidence.evidence.signatures[0].transition_id, '31');
  assert.deepEqual(evidence.links, [], 'no link field tracked, no links recorded');
});

test('a capture of a child held to its parent\'s fields records that rule as inherited from that parent', async () => {
  const { args, deps, written } = fixture();
  args.ruleScope = { source: 'INHERITED', projectId: 2, issueTypeId: 'epic', imposedByBaselineId: Buffer.alloc(16, 9), imposedByVersion: 6 };
  args.cause = 'DRIFT_DECISION';
  await writeCapturedBaseline(args, deps);
  const { evidence } = written();
  assert.equal(evidence.cause, 'DRIFT_DECISION');
  assert.equal(evidence.evidence.rules[0].source, 'INHERITED');
  assert.equal(evidence.evidence.rules[0].issue_type_id, 'epic');
  assert.equal(evidence.evidence.rules[0].imposed_by_version, 6);
});

test('a capture without its rule scope is refused before anything is written', async () => {
  const { args, deps, calls } = fixture();
  args.ruleScope = null;
  assert.equal((await writeCapturedBaseline(args, deps)).reason, 'BASELINE_POLICY_INCOMPLETE');
  assert.deepEqual(calls, []);
});

test('tracked links are recorded with the other end\'s version at that moment', async () => {
  const { args, deps, written } = fixture();
  const linksField = { field_id: 'issuelinks', field_kind: 'LINKS', schema_type: 'array', materiality: 'MAJOR',
    store_values: true, writable: false };
  const links = [{ id: '15539', type: { id: '10022', name: 'Deployments' }, outwardIssue: { id: '43903', key: 'VAT-3' } }];
  args.controlledFields = [...fields, linksField];
  args.issueFields = { summary: 'Approved', issuelinks: links };
  args.approver.contentHash = project(args.issueFields, args.controlledFields).contentHash;
  const asked = [];
  deps.activeBaselines = async ids => { asked.push(ids); return new Map([[43903, { baseline_id: Buffer.alloc(16, 5), version: 4 }]]); };
  assert.equal((await writeCapturedBaseline(args, deps)).captured, true);
  assert.deepEqual(asked, [[43903]]);
  assert.deepEqual(written().evidence.links.map(l => [l.link_id, l.direction, l.other_issue_key, l.other_baseline_version]),
    [['15539', 'OUTWARD', 'VAT-3', 4]]);
});
