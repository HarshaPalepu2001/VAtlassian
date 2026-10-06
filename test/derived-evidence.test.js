import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDerivedFlat, writeDerivedTree } from '../src/db/derivedBaselineStore.js';

const d = c => c.repeat(64);
const source = { baseline_id: Buffer.alloc(16, 1), issue_id: 7, project_id: 2, issue_type_id: '3', version: 4,
  transition_id: '31', from_status_id: '3', to_status_id: '4', required_role: 'REVIEWER', required_assurance: 'ESIGNATURE',
  controlled_fields_hash: d('h'), fidelity: 'EXACT' };
const signed = {
  fields: [{ field_id: 'issuelinks', label: 'Linked issues', label_source: 'CAPTURE', kind: 'LINKS', schema_type: 'array',
    materiality: 'MAJOR', store_values: true, restorable: null, digest: d('b'), required_by: ['k1'] }],
  rules: [{ rule_key: 'k1', source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
    approvers: [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }], controlled_fields_hash: d('h'),
    imposed_by_baseline_id: null, imposed_by_version: null }],
  signatures: [], links: []
};
const links = [{ id: '15539', type: { id: '10022' }, inwardIssue: { id: '43979', key: 'VAT-30' } }];
const approval = { approvalId: Buffer.alloc(16, 2), accountId: 'signer', displayName: 'Signer', assuranceLevel: 'ESIGNATURE',
  signerRole: 'REVIEWER' };

function deps(evidence) {
  const writes = [];
  return { writes, deps: { readEvidence: async () => evidence,
    activeBaselines: async () => new Map([[43979, { baseline_id: Buffer.alloc(16, 3), version: 9 }]]),
    write: async args => { writes.push(args); return { baselineId: Buffer.alloc(16, 4) }; } } };
}

test('a link record copies its source\'s signed definitions, and records the link and the signer', async () => {
  const { writes, deps: given } = deps(signed);
  await writeDerivedFlat({ source, values: { issuelinks: links }, digests: { issuelinks: d('c') }, contentHash: d('e'),
    approval, now: 50 }, { ...given, nextVersion: async attempt => attempt(5) });
  const [{ evidence, baseline }] = writes;
  assert.equal(baseline.version, 5);
  assert.equal(evidence.required, true);
  assert.equal(evidence.cause, 'LINK_RECORD');
  assert.deepEqual(evidence.evidence.fields.map(f => [f.field_id, f.digest]), [['issuelinks', d('c')]]);
  assert.equal(evidence.evidence.signatures[0].role, 'REVIEWER');
  assert.equal(evidence.evidence.signatures[0].fields_covered, '["issuelinks"]');
  assert.deepEqual(evidence.links.map(l => [l.link_id, l.direction, l.other_issue_key, l.other_baseline_version]),
    [['15539', 'INWARD', 'VAT-30', 9]]);
});

test('a link record on a version with no recorded policy publishes without the evidence gate, and says whose role is unknown', async () => {
  const { writes, deps: given } = deps({ fields: [], rules: [], signatures: [], links: [] });
  await writeDerivedFlat({ source, values: { issuelinks: links }, digests: { issuelinks: d('c') }, contentHash: d('e'),
    approval: { ...approval, signerRole: null }, now: 50 }, { ...given, nextVersion: async attempt => attempt(5) });
  const [{ evidence }] = writes;
  assert.equal(evidence.required, false);
  assert.equal(evidence.evidence.signatures[0].role, 'UNRECORDED');
});

// A tree record: the same evidence, written onto the reserved version before it is published.
const treeSource = { ...source, tree_hash: d('t'), nodes_captured_at: 40, captured_at: 40 };
const root = { logicalNodeId: 'root', parentLogicalNodeId: null, originalIssueId: 7, currentIssueId: 7, issueKey: 'VAT-7',
  projectId: 2, issueTypeId: '3', contentHash: d('r'), fieldDigests: JSON.stringify({ issuelinks: d('c') }), nodeOrder: 0 };
const derived = { nodes: [root], values: { root: { issuelinks: links } }, treeHash: d('t'), rootLogicalNodeId: 'root' };

function treeRun(evidence) {
  const log = [];
  const query = async (sql, params) => {
    log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/COUNT\(DISTINCT n\.logical_node_id\)/.test(sql)) {
      return [{ state: 'CAPTURING', treeHash: d('t'), nodeCount: 1, totalFieldCount: 1, storedNodeCount: 1, storedFieldCount: 1 }];
    }
    if (/GROUP BY logical_node_id, field_id/.test(sql)) {
      return [{ logicalNodeId: 'root', fieldId: 'issuelinks', minSeq: 0, maxSeq: 0, chunkCount: 1, encodingCount: 1, rawBytesCount: 1 }];
    }
    return [];
  };
  const write = async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params, publish: true });
    return { result: true, data: { affectedRows: 1 } }; };
  const written = [];
  const given = { readEvidence: async () => evidence,
    activeBaselines: async () => new Map([[43979, { baseline_id: Buffer.alloc(16, 3), version: 9 }]]),
    nextVersion: async attempt => attempt(5),
    copyPins: async args => { log.push({ pins: args }); },
    writeEvidence: async args => { log.push({ evidence: args }); written.push(args); } };
  return { log, written, query, write, given };
}

test('a tree link record copies the pins, writes its evidence while capturing, then publishes behind the evidence gate', async () => {
  const run = treeRun(signed);
  const result = await writeDerivedTree({ source: treeSource, derived, approval, now: 50, query: run.query, write: run.write },
    run.given);
  assert.equal(result.version, 5);
  const steps = run.log.filter(entry => entry.pins || entry.evidence || entry.publish);
  assert.deepEqual(steps.map(entry => entry.pins ? 'pins' : entry.evidence ? 'evidence' : 'publish'),
    ['pins', 'evidence', 'publish']);
  const [{ pins }, { evidence }, publish] = steps;
  assert.deepEqual(pins.fromBaselineId, treeSource.baseline_id);
  assert.deepEqual(pins.toBaselineId, result.baselineId);
  const [entry] = evidence.entries;
  assert.deepEqual(entry.baselineId, result.baselineId);
  assert.equal(entry.cause, 'LINK_RECORD');
  assert.deepEqual(entry.evidence.fields.map(f => [f.field_id, f.digest]), [['issuelinks', d('c')]]);
  assert.equal(entry.evidence.signatures[0].role, 'REVIEWER');
  assert.deepEqual(entry.links.map(l => [l.link_id, l.other_issue_key, l.other_baseline_version]), [['15539', 'VAT-30', 9]]);
  assert.match(publish.sql, /AND policy_recorded = TRUE/);
});

test('a tree link record on a version with no recorded policy publishes without the evidence gate', async () => {
  const run = treeRun({ fields: [], rules: [], signatures: [], links: [] });
  await writeDerivedTree({ source: treeSource, derived, approval: { ...approval, signerRole: null }, now: 50,
    query: run.query, write: run.write }, run.given);
  const publish = run.log.find(entry => entry.publish);
  assert.doesNotMatch(publish.sql, /policy_recorded/);
  assert.equal(run.written[0].entries[0].evidence.signatures[0].role, 'UNRECORDED');
});

test('a tree link record whose evidence tables are not there yet reserves nothing, so the retry starts clean', async () => {
  const run = treeRun(signed);
  const pending = Object.assign(new Error('pending'), { reason: 'SCHEMA_PENDING' });
  run.given.readEvidence = async () => { throw pending; };
  await assert.rejects(() => writeDerivedTree({ source: treeSource, derived, approval, now: 50, query: run.query, write: run.write },
    run.given), error => error === pending);
  assert.deepEqual(run.log, []);
});
