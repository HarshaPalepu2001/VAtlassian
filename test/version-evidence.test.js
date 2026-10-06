import test from 'node:test';
import assert from 'node:assert/strict';
import { versionEvidence, derivedEvidence, linkRows, trackedLinks, linkedIssueIds, ruleKey,
  CAUSE, RULE_SOURCE, UNRECORDED_ROLE } from '../src/lib/evidence/versionEvidence.js';

const d = c => c.repeat(64);
const FIELDS = [
  { field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', schema_type: 'string',
    materiality: 'MAJOR', store_values: true, writable: true },
  { field_id: 'issuelinks', field_name: 'Linked issues', field_kind: 'LINKS', schema_type: 'array',
    materiality: 'MAJOR', store_values: 1, writable: null }
];
const DIGESTS = { summary: d('a'), issuelinks: d('b') };
const RULE = { source: RULE_SOURCE.OWN, projectId: 2, issueTypeId: '3', transitionId: '31',
  approvers: [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }], controlledFieldsHash: d('h') };
const SIGNATURE = { approvalId: Buffer.alloc(16, 1), signerAccountId: 'acc-1', signerName: 'Asha',
  role: 'REVIEWER', assurance: 'ESIGNATURE', cause: CAUSE.OWN_TRANSITION, transitionId: '31',
  fromStatusId: '3', toStatusId: '4', transitionAt: 100, statusAtCapture: '3', signedAt: 101 };

test('every field is recorded with its definition, its digest and the rule that required it', () => {
  const ev = versionEvidence({ fields: FIELDS, digests: JSON.stringify(DIGESTS), writable: { summary: false },
    rule: RULE, signature: SIGNATURE });
  const key = ruleKey(RULE);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.deepEqual(ev.fields[0], { field_id: 'summary', label: 'Summary', label_source: 'CAPTURE', kind: 'TEXT',
    schema_type: 'string', materiality: 'MAJOR', store_values: true, restorable: false, digest: d('a'),
    required_by: JSON.stringify([key]) });
  assert.equal(ev.fields[1].store_values, true);
  assert.equal(ev.fields[1].restorable, null, 'writability nobody asked about stays unknown');
  assert.deepEqual(ev.rules, [{ rule_key: key, source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
    approvers: JSON.stringify([{ role: 'REVIEWER', assurance: 'ESIGNATURE' }]), controlled_fields_hash: d('h'),
    imposed_by_baseline_id: null, imposed_by_version: null }]);
  assert.equal(ev.signatures.length, 1);
  const [sig] = ev.signatures;
  assert.ok(sig.approval_id.equals(Buffer.alloc(16, 1)));
  assert.deepEqual([sig.signer_account_id, sig.signer_name, sig.role, sig.assurance, sig.cause, sig.cause_baseline_id,
    sig.decision_id, sig.transition_id, sig.from_status_id, sig.to_status_id, sig.transition_at,
    sig.status_at_capture, sig.fields_covered, sig.signed_at],
    ['acc-1', 'Asha', 'REVIEWER', 'ESIGNATURE', 'OWN_TRANSITION', null, null, '31', '3', '4', 100, '3',
      JSON.stringify(['summary', 'issuelinks']), 101]);
});

test('a missing digest, a digest for an untracked field or unreadable digests refuse the capture', () => {
  const refused = e => e.reason === 'CAPTURE_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: { summary: d('a') }, rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS.slice(0, 1), digests: { summary: d('a'), labels: d('c') },
    rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: 'not json', rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: [], digests: {}, rule: RULE, signature: SIGNATURE }), refused);
});

test('an incomplete rule, signature or field definition refuses the capture', () => {
  const refused = e => e.reason === 'BASELINE_POLICY_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, approvers: [] }, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS,
    rule: { ...RULE, approvers: [{ role: 'REVIEWER' }] }, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS,
    rule: { ...RULE, source: RULE_SOURCE.INHERITED }, signature: SIGNATURE }), refused, 'inherited from nowhere');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, source: 'GUESSED' }, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: [{ ...FIELDS[0], materiality: undefined }, FIELDS[1]], digests: DIGESTS,
    rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE,
    signature: { ...SIGNATURE, signedAt: undefined } }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE,
    signature: { ...SIGNATURE, cause: 'SOMETHING' } }), refused);
});

test('an inherited rule names the version that imposed it, and keys apart from an own rule', () => {
  const inherited = { ...RULE, source: RULE_SOURCE.INHERITED, imposedByBaselineId: Buffer.alloc(16, 9), imposedByVersion: 3 };
  const ev = versionEvidence({ fields: FIELDS.slice(0, 1), digests: { summary: d('a') }, rule: inherited,
    signature: { ...SIGNATURE, cause: CAUSE.PARENT_CAPTURE, causeBaselineId: Buffer.alloc(16, 9) } });
  assert.ok(ev.rules[0].imposed_by_baseline_id.equals(Buffer.alloc(16, 9)));
  assert.equal(ev.rules[0].imposed_by_version, 3);
  assert.notEqual(ev.rules[0].rule_key, ruleKey(RULE));
  assert.ok(ev.signatures[0].cause_baseline_id.equals(Buffer.alloc(16, 9)));
});

test('links are recorded with their direction and the other end\'s version at that moment', () => {
  const links = [
    { id: '15539', type: { id: '10022', name: 'Deployments' }, outwardIssue: { id: '43903', key: 'VAT-3' } },
    { id: '15540', type: { id: '10000', name: 'Blocks' }, inwardIssue: { id: '43927', key: 'VAT-12' } }
  ];
  assert.deepEqual(linkedIssueIds(links), [43903, 43927]);
  assert.deepEqual(linkedIssueIds(null), []);
  const rows = linkRows({ links, otherVersions: new Map([[43903, { baseline_id: Buffer.alloc(16, 5), version: 4 }]]) });
  assert.deepEqual(rows.map(r => [r.link_id, r.link_type, r.direction, r.other_issue_id, r.other_issue_key, r.other_baseline_version]),
    [['15539', '10022', 'OUTWARD', 43903, 'VAT-3', 4], ['15540', '10000', 'INWARD', 43927, 'VAT-12', null]]);
  assert.ok(rows[0].other_baseline_id.equals(Buffer.alloc(16, 5)));
  assert.equal(rows[1].other_baseline_id, null);
  assert.deepEqual(linkRows({ links: null }), []);
  assert.throws(() => linkRows({ links: [{ id: '1', type: { id: '2' } }] }), e => e.reason === 'CAPTURE_INCOMPLETE');
  assert.throws(() => linkRows({ links: [{ id: '1', outwardIssue: { id: '2', key: 'A-2' } }] }), e => e.reason === 'CAPTURE_INCOMPLETE');
});

test('links are recorded only when the version tracks a link field', () => {
  assert.equal(trackedLinks(FIELDS.slice(0, 1), { issuelinks: [{ id: '1' }] }), null);
  assert.deepEqual(trackedLinks(FIELDS, { issuelinks: [] }), []);
  assert.deepEqual(trackedLinks(FIELDS, {}), [], 'tracked but absent from the read is no links');
});

const SIGNED = {
  fields: [
    { field_id: 'summary', label: 'Summary', label_source: 'CAPTURE', kind: 'TEXT', schema_type: 'string',
      materiality: 'MAJOR', store_values: true, restorable: true, digest: d('a'), required_by: ['k1'] },
    { field_id: 'issuelinks', label: 'Linked issues', label_source: 'CAPTURE', kind: 'LINKS', schema_type: 'array',
      materiality: 'MAJOR', store_values: true, restorable: null, digest: d('b'), required_by: ['k1'] }
  ],
  rules: [{ rule_key: 'k1', source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
    approvers: [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }], controlled_fields_hash: d('h'),
    imposed_by_baseline_id: null, imposed_by_version: null }]
};

test('a link record copies the signed definitions and rules, with the new digests and its own signature', () => {
  const ev = derivedEvidence({ source: SIGNED, digests: { summary: d('a'), issuelinks: d('c') },
    signature: { ...SIGNATURE, role: UNRECORDED_ROLE, cause: CAUSE.LINK_RECORD, fieldsCovered: ['issuelinks'] } });
  assert.equal(ev.recorded, true);
  assert.deepEqual(ev.fields.map(f => [f.field_id, f.label, f.digest, f.required_by]),
    [['summary', 'Summary', d('a'), '["k1"]'], ['issuelinks', 'Linked issues', d('c'), '["k1"]']]);
  assert.equal(ev.rules[0].approvers, JSON.stringify([{ role: 'REVIEWER', assurance: 'ESIGNATURE' }]));
  assert.equal(ev.signatures[0].role, 'UNRECORDED');
  assert.equal(ev.signatures[0].cause, 'LINK_RECORD');
  assert.equal(ev.signatures[0].fields_covered, '["issuelinks"]');
  assert.throws(() => derivedEvidence({ source: SIGNED, digests: { summary: d('a') }, signature: SIGNATURE }),
    e => e.reason === 'CAPTURE_INCOMPLETE');
});

test('a link record on a version whose policy was never recorded records only its signature', () => {
  const ev = derivedEvidence({ source: { fields: [], rules: [] }, digests: { issuelinks: d('c') },
    signature: { ...SIGNATURE, cause: CAUSE.LINK_RECORD, fieldsCovered: ['issuelinks'] } });
  assert.equal(ev.recorded, false);
  assert.deepEqual([ev.fields, ev.rules], [[], []]);
  assert.equal(ev.signatures.length, 1);
});

test('numeric fields refuse non-integer or invalid values', () => {
  const refused = e => e.reason === 'BASELINE_POLICY_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, projectId: null }, signature: SIGNATURE }), refused, 'projectId null');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, projectId: '' }, signature: SIGNATURE }), refused, 'projectId empty string');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, projectId: 0 }, signature: SIGNATURE }), refused, 'projectId zero');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE, signature: { ...SIGNATURE, signedAt: '' } }), refused, 'signedAt empty string');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE, signature: { ...SIGNATURE, signedAt: false } }), refused, 'signedAt false');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE, signature: { ...SIGNATURE, transitionAt: 'soon' } }), refused, 'transitionAt non-integer');
  const inherited = { ...RULE, source: RULE_SOURCE.INHERITED, imposedByBaselineId: Buffer.alloc(16, 9), imposedByVersion: 'x' };
  assert.throws(() => versionEvidence({ fields: FIELDS.slice(0, 1), digests: { summary: d('a') }, rule: inherited, signature: { ...SIGNATURE, cause: CAUSE.PARENT_CAPTURE, causeBaselineId: Buffer.alloc(16, 9) } }), refused, 'imposedByVersion non-integer');
});

test('numeric link fields refuse non-integer or invalid values', () => {
  const refused = e => e.reason === 'CAPTURE_INCOMPLETE';
  const links = [{ id: '1', type: { id: '2' }, outwardIssue: { id: '', key: 'A-1' } }];
  assert.throws(() => linkRows({ links }), refused, 'link other.id empty string');
  assert.throws(() => linkRows({ links: [{ id: '1', type: { id: '2' }, outwardIssue: { id: '0', key: 'A-1' } }] }), refused, 'link other.id zero');
  const badVersion = { links: [{ id: '1', type: { id: '2' }, outwardIssue: { id: '1', key: 'A-1' } }], otherVersions: new Map([[1, { baseline_id: Buffer.alloc(16), version: 'x' }]]) };
  assert.throws(() => linkRows(badVersion), refused, 'version.version non-integer');
});

test('cross-field constraints refuse incomplete evidence', () => {
  const refused = e => e.reason === 'BASELINE_POLICY_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE, signature: { ...SIGNATURE, cause: CAUSE.PARENT_CAPTURE } }), refused, 'PARENT_CAPTURE without causeBaselineId');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, source: RULE_SOURCE.INHERITED, imposedByBaselineId: Buffer.alloc(16, 9) }, signature: { ...SIGNATURE, cause: CAUSE.PARENT_CAPTURE, causeBaselineId: Buffer.alloc(16, 9) } }), refused, 'INHERITED without imposedByVersion');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, imposedByBaselineId: Buffer.alloc(16, 9) }, signature: SIGNATURE }), refused, 'OWN rule with imposedByBaselineId');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, imposedByVersion: 1 }, signature: SIGNATURE }), refused, 'OWN rule with imposedByVersion');
});

test('malformed input shapes refuse with FailClosed, not TypeError', () => {
  const policyRefused = e => e.reason === 'BASELINE_POLICY_INCOMPLETE';
  const captureRefused = e => e.reason === 'CAPTURE_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, approvers: 'x' }, signature: SIGNATURE }), policyRefused, 'approvers not array');
  assert.throws(() => linkedIssueIds({}), captureRefused, 'linkedIssueIds non-array input');
  assert.throws(() => linkRows({ links: [], otherVersions: null }), captureRefused, 'otherVersions null');
  assert.throws(() => linkRows({ links: [], otherVersions: { get: () => {} } }), captureRefused, 'otherVersions not a Map');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE, signature: { ...SIGNATURE, fieldsCovered: 'x' } }), policyRefused, 'fieldsCovered not array');
});

test('derivedEvidence with fields but no rules refuses the capture', () => {
  const refused = e => e.reason === 'CAPTURE_INCOMPLETE';
  assert.throws(() => derivedEvidence({ source: { fields: SIGNED.fields, rules: [] }, digests: { summary: d('a'), issuelinks: d('b') }, signature: SIGNATURE }), refused, 'fields without rules');
  assert.throws(() => derivedEvidence({ source: { fields: [], rules: SIGNED.rules }, digests: { summary: d('a'), issuelinks: d('b') }, signature: SIGNATURE }), refused, 'rules without fields');
});
