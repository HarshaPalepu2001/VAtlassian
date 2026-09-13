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
    approver: { approvalId: Buffer.alloc(16, 1), accountId: 'a', assuranceLevel: 'ESIGNATURE',
      contentHash: project({ summary: 'Approved' }, fields).contentHash } };
  const calls = [];
  let written = null;
  const deps = { baselineForApproval: async () => null, currentVersion: async () => 0,
    writeBaseline: async args => { calls.push('write'); written = args; return { baselineId: Buffer.alloc(16, 2) }; },
    assignReviewer: async () => ({ accountId: 'a' }), upsertBaselined: async () => calls.push('publish'),
    tryAppend: async () => calls.push('audit'), getReview: async () => null };
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
