import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDecisions, decisionMapHash, validateDecisions, targetTreeFor, applyOverlay,
  planMixed, mixedEligibility } from '../src/lib/approval/mixedDecision.js';

const field = (logicalNodeId, rawFieldId, extra = {}) => ({
  fieldId: `${logicalNodeId}:${rawFieldId}`, rawFieldId, logicalNodeId, fieldName: rawFieldId,
  group: { kind: 'ISSUE', logicalNodeId }, restorable: 'YES', retained: true, ...extra });
const root = 'n1';
const fields = [field(root, 'summary'), field(root, 'description')];

test('canonical form is order independent and hashes stably', () => {
  const a = canonicalDecisions([{ fieldId: 'b', decision: 'REJECT' }, { fieldId: 'a', decision: 'APPROVE' }]);
  const b = canonicalDecisions([{ fieldId: 'a', decision: 'APPROVE' }, { fieldId: 'b', decision: 'REJECT' }]);
  assert.deepEqual(a, b);
  assert.equal(decisionMapHash(a), decisionMapHash(b));
  assert.notEqual(decisionMapHash(a), decisionMapHash(canonicalDecisions([
    { fieldId: 'a', decision: 'REJECT' }, { fieldId: 'b', decision: 'REJECT' }])));
});

test('malformed maps are refused', () => {
  for (const bad of [null, {}, [{ fieldId: 'a', decision: 'MAYBE' }], [{ fieldId: '', decision: 'APPROVE' }],
    [{ fieldId: 'a', decision: 'APPROVE' }, { fieldId: 'a', decision: 'REJECT' }]]) {
    assert.throws(() => canonicalDecisions(bad), { reason: 'DECISION_MAP_INVALID' });
  }
});

test('coverage must be exact', () => {
  const ok = [{ fieldId: `${root}:summary`, decision: 'APPROVE' }, { fieldId: `${root}:description`, decision: 'REJECT' }];
  const v = validateDecisions({ decisions: ok, reviewFields: fields });
  assert.deepEqual(v.approved.map(f => f.rawFieldId), ['summary']);
  assert.deepEqual(v.rejected.map(f => f.rawFieldId), ['description']);
  for (const bad of [ok.slice(0, 1), [...ok, { fieldId: 'ghost:x', decision: 'APPROVE' }]]) {
    assert.throws(() => validateDecisions({ decisions: bad, reviewFields: fields }), { reason: 'DECISION_MAP_MISMATCH' });
  }
});

test('a non-restorable field cannot be rejected but may be approved', () => {
  const locked = [field(root, 'summary', { restorable: 'NOT_RETAINED', retained: false }), field(root, 'description')];
  const reject = [{ fieldId: `${root}:summary`, decision: 'REJECT' }, { fieldId: `${root}:description`, decision: 'APPROVE' }];
  assert.throws(() => validateDecisions({ decisions: reject, reviewFields: locked }), { reason: 'FIELD_NOT_RESTORABLE' });
  const approve = reject.map(d => ({ ...d, decision: 'APPROVE' }));
  assert.doesNotThrow(() => validateDecisions({ decisions: approve, reviewFields: locked }));
});

test('structural changes make the mixed workflow unavailable', () => {
  const withStructure = [...fields, { fieldId: 'tree:NODE_ADDED:n2', group: { kind: 'STRUCTURE' }, restorable: 'SPECIAL' }];
  assert.throws(() => validateDecisions({ decisions: [], reviewFields: withStructure }), { reason: 'MIXED_STRUCTURE_UNSUPPORTED' });
  assert.deepEqual(mixedEligibility({ baseline: { tree_hash: 'x' }, reviewFields: withStructure }),
    { eligible: false, reason: 'STRUCTURE_CHANGED', fields: [] });
  assert.equal(mixedEligibility({ baseline: {}, reviewFields: fields }).reason, 'NOT_TREE_BASELINE');
  assert.equal(mixedEligibility({ baseline: { tree_hash: 'x' }, reviewFields: fields }).eligible, true);
  assert.deepEqual(mixedEligibility({ baseline: { tree_hash: 'x' }, reviewFields: fields, authoritativeCount: 3 }),
    { eligible: false, reason: 'HIDDEN_CHANGES', fields: [] });
});

test('mixed eligibility follows an effective scoped tree, not the child row storage shape', () => {
  const result = mixedEligibility({
    baseline: { tree_hash: null },
    baselineTree: { nodes: [{ logicalNodeId: 'child' }] },
    reviewFields: [{ fieldId: 'child:summary', restorable: 'YES', retained: true }],
    authoritativeCount: 1
  });
  assert.deepEqual(result, { eligible: true, reason: null,
    fields: [{ fieldId: 'child:summary', restorable: 'YES', retained: true }] });
});

// As stored: parentLogicalId is a non-enumerable property (db/baselineTreeStore.js).
const baselineNode = Object.defineProperty({ logicalNodeId: root, parentLogicalNodeId: null,
  digests: { summary: 'S0', description: 'D0' } }, 'parentLogicalId', { value: null, enumerable: false });
const baselineTree = { nodes: [baselineNode], values: { [root]: { summary: 'old', description: 'oldD' } } };
const currentTree = { nodes: [{ logicalNodeId: root, parentLogicalId: null,
  digests: { summary: 'S1', description: 'D1' } }], values: { [root]: { summary: 'new', description: 'newD' } } };

test('target tree takes live digests for approved fields only', () => {
  const approved = [fields[0]];
  const { targetTree, overlay } = targetTreeFor({ baselineTree, currentTree, approved });
  assert.deepEqual(targetTree.nodes[0].digests, { summary: 'S1', description: 'D0' });
  assert.deepEqual(overlay, { [root]: { summary: 'S1' } });
  assert.deepEqual(baselineTree.nodes[0].digests, { summary: 'S0', description: 'D0' }, 'input is not mutated');
  assert.deepEqual(applyOverlay({ baselineTree, overlay }).nodes[0].digests, targetTree.nodes[0].digests);
  assert.equal(targetTree.nodes[0].parentLogicalId, null, 'non-enumerable parent identity survives the copy');
});

test('plan restores only rejected fields and its hash moves with every decision', () => {
  const controlledFields = [{ field_id: 'summary', field_kind: 'scalar' }, { field_id: 'description', field_kind: 'scalar' }];
  const run = decisions => planMixed({ decisions, reviewFields: fields, baselineTree, currentTree,
    controlledFields, fieldsFor: () => controlledFields });
  const a = run([{ fieldId: `${root}:summary`, decision: 'APPROVE' }, { fieldId: `${root}:description`, decision: 'REJECT' }]);
  assert.deepEqual(a.restore.steps.map(s => [s.kind, s.fieldIds]), [['RESTORE_FIELDS', ['description']]]);
  const b = run([{ fieldId: `${root}:summary`, decision: 'REJECT' }, { fieldId: `${root}:description`, decision: 'APPROVE' }]);
  assert.deepEqual(b.restore.steps.map(s => s.fieldIds), [['summary']]);
  assert.notEqual(a.planHash, b.planHash);
  assert.equal(a.planHash, run([...a.decisions].reverse()).planHash, 'input order is irrelevant');
});
