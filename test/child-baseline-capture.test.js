import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { nodeScope } from '../src/lib/tree/nodeFields.js';
import { planChildBaselines, writeChildBaselines, publishChildBaselines, nextVersions } from '../src/db/childBaselineStore.js';
import { writeCapturedTreeBaseline } from '../src/lib/capture.js';
import { nodeSecurityLevels } from '../src/lib/evidence/treeEvidence.js';
import { project } from '../src/lib/content.js';

const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' });
const nodes = [
  { id: '1', key: 'P-1', fields: { summary: 'parent', project: { id: '1' }, issuetype: { id: 'S' }, parent: null } },
  { id: '2', key: 'P-2', fields: { summary: 'sub a', project: { id: '1' }, issuetype: { id: 'T' }, parent: { id: '1' } } },
  { id: '3', key: 'P-3', fields: { summary: 'sub b', project: { id: '1' }, issuetype: { id: 'U' }, parent: { id: '2' } } }
];
const fieldsFor = n => (nodeScope(n).issueTypeId === 'U' ? [] : [F('summary')]);
const parent = { baselineId: Buffer.alloc(16, 9), approvalId: Buffer.alloc(16, 8), accountId: 'signer', displayName: 'Signer',
  assuranceLevel: 'ESIGNATURE', policy: { transition_id: '31', from_status_id: '3', to_status_id: '4',
    required_role: 'reviewer', required_assurance: 'ESIGNATURE' }, transitionAt: 10, capturedAt: 20 };

test('every child with tracked fields gets its own baseline, authenticated by the parent approval', () => {
  const treePlan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: [F('summary')], fieldsFor });
  const rows = planChildBaselines({ treePlan, rootIssueId: '1', fieldsFor, nodeOf: id => nodes.find(n => Number(n.id) === id),
    parent, nextVersion: issueId => (issueId === 2 ? 5 : 1) });
  assert.deepEqual(rows.map(r => [r.issue_id, r.version]), [[2, 5]], 'no row for the root, none for the child with no tracked fields');
  const [row] = rows;
  assert.equal(row.captured_by_baseline_id, parent.baselineId);
  assert.equal(row.approval_id, parent.approvalId);
  assert.equal(row.approved_by, 'signer');
  assert.equal(row.required_role, 'reviewer');
  assert.equal(row.issue_key, 'P-2');
  assert.equal(row.summary, 'sub a');
  assert.equal(row.field_count, 1);
  assert.match(row.controlled_fields_hash, /^[0-9a-f]{64}$/);
  // Exactly what a single-issue capture of the child would have recorded, so
  // the single-issue collector and the validator compare like with like.
  const flat = project(nodes[1].fields, [F('summary')]);
  assert.equal(row.content_hash, flat.contentHash);
  assert.deepEqual(JSON.parse(row.field_digests), flat.digests);
  assert.deepEqual(row.raw, { summary: 'sub a' });
});

test('next versions for many children come from one read', async () => {
  const queries = [];
  const next = await nextVersions([2, 3, 2], async (sql, params) => { queries.push({ sql, params }); return [{ issue_id: 2, v: 4 }]; });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [2, 3]);
  assert.equal(next(2), 5);
  assert.equal(next(3), 1);
});

function recordingQuery({ leftovers = [], duplicateOnce = false } = {}) {
  const queries = [];
  let failed = false;
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT issue_id, version FROM va_baseline/.test(sql)) return leftovers;
    if (/SELECT MAX\(version\)/.test(sql)) return [{ v: 7 }];
    if (duplicateOnce && !failed && /INSERT INTO va_baseline\s*\n/.test(sql)) {
      failed = true;
      throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    }
    return [];
  };
  return { queries, query };
}

const childRow = () => ({ issue_id: 2, issue_key: 'P-2', project_id: 1, issue_type_id: 'T', version: 5,
  content_hash: 'c'.repeat(64), field_digests: '{"summary":"d"}', raw: { summary: 'sub a' }, field_count: 1,
  captured_by_baseline_id: parent.baselineId, transition_id: '31', from_status_id: '3', to_status_id: '4',
  required_role: 'reviewer', required_assurance: 'ESIGNATURE', controlled_fields_hash: 'h'.repeat(64),
  approved_by: 'signer', approved_name: 'Signer', assurance_level: 'ESIGNATURE', approval_id: parent.approvalId,
  transition_at: 10, captured_at: 20, fidelity: 'EXACT' });

test('child rows are written CAPTURING with their values, linked to the parent capture', async () => {
  const { queries, query } = recordingQuery({ leftovers: [{ issue_id: 2, version: 5 }] });
  const written = await writeChildBaselines({ rows: [childRow()], parentBaselineId: parent.baselineId, query,
    newId: () => Buffer.alloc(16, 3) });
  const sqls = queries.map(q => q.sql.replace(/\s+/g, ' ').trim());
  // A retry first clears this parent's unpublished rows and their values.
  assert.match(sqls[0], /WHERE captured_by_baseline_id = FROM_BASE64\(\?\) AND state = 'CAPTURING'/);
  assert.match(sqls[1], /DELETE FROM va_baseline_value WHERE issue_id = \? AND version = \?/);
  assert.match(sqls[2], /DELETE FROM va_baseline WHERE captured_by_baseline_id/);
  const insert = queries.find(q => /INSERT INTO va_baseline\s*\n/.test(q.sql));
  assert.match(insert.sql, /'CAPTURING'/);
  assert.equal((insert.sql.match(/\?/g) ?? []).length, insert.params.length);
  assert.equal(insert.params.at(-1), parent.baselineId.toString('base64'));
  assert.ok(queries.some(q => /INSERT INTO va_baseline_value/.test(q.sql) && q.params.includes('summary')));
  assert.equal(written[0].version, 5);
  assert.ok(written[0].baseline_id.equals(Buffer.alloc(16, 3)));
});

test('a child version taken meanwhile moves the child to the next free one', async () => {
  const { queries, query } = recordingQuery({ duplicateOnce: true });
  const written = await writeChildBaselines({ rows: [childRow()], parentBaselineId: parent.baselineId, query });
  assert.equal(written[0].version, 8);
  const values = queries.find(q => /INSERT INTO va_baseline_value/.test(q.sql));
  assert.equal(values.params[1], 8, 'values are stored under the version actually written');
});

test('publishing activates this capture\'s child rows and retires each child\'s older versions', async () => {
  const writes = [];
  const queries = [];
  const result = await publishChildBaselines({
    parentBaselineId: parent.baselineId,
    write: async (sql, params) => { writes.push({ sql, params }); return { result: true, data: { affectedRows: 1 } }; },
    query: async (sql, params) => {
      queries.push({ sql, params });
      return /SELECT/.test(sql) ? [{ baseline_id: Buffer.alloc(16, 3).toString('base64'), issue_id: 2, version: 5,
        project_id: 1, issue_type_id: 'T', content_hash: 'c', field_digests: '{}', issue_key: 'P-2' }] : [];
    }
  });
  assert.match(writes[0].sql, /SET state = 'ACTIVE'[\s\S]*captured_by_baseline_id = FROM_BASE64\(\?\) AND state = 'CAPTURING'[\s\S]*controlled_fields_hash IS NOT NULL/);
  const supersede = queries.find(q => /SUPERSEDED/.test(q.sql));
  assert.match(supersede.sql, /\(issue_id = \? AND version < \?\)/);
  assert.deepEqual(supersede.params, [2, 5]);
  assert.equal(result.children[0].issue_key, 'P-2');
  assert.ok(result.children[0].baseline_id.equals(Buffer.alloc(16, 3)));
});

// ── writeCapturedTreeBaseline, with the real tree planner ────────────────────

function captureFixture() {
  const calls = [];
  const rootFields = [F('summary'), F('description')];
  const tree = [
    // `security: null` is Jira saying the node has no level (see nodeSecurityLevels).
    { id: '1', key: 'P-1', fields: { summary: 'parent', description: 'd', project: { id: '1' }, issuetype: { id: 'S' }, status: { id: '3' }, parent: null, security: null } },
    { id: '2', key: 'P-2', fields: { summary: 'sub', description: 'not tracked here', project: { id: '1' }, issuetype: { id: 'T' }, status: { id: '1' }, parent: { id: '1' }, security: null } }
  ];
  const treeHash = planTreeCapture({ rootIssueId: '1', nodes: tree, controlledFields: rootFields }).treeHash;
  const itemStates = [];
  const ledger = [];
  const evidenceEntries = [];
  return {
    calls, itemStates, ledger, evidenceEntries,
    args: {
      rootIssue: { id: '1', key: 'P-1', fields: tree[0].fields },
      policy: parent.policy,
      approval: { approvalId: parent.approvalId, accountId: 'signer', displayName: 'Signer', assuranceLevel: 'ESIGNATURE', content_hash: treeHash },
      controlledFields: rootFields,
      transitionAt: 10,
      ruleScope: { source: 'OWN', projectId: 1, issueTypeId: 'S', imposedByBaselineId: null, imposedByVersion: null },
      cause: 'DRIFT_DECISION',
      deps: {
        readStableTree: async () => ({ tree: { nodes: structuredClone(tree) } }),
        readTree: null,
        planTreeCapture,
        baselineForApproval: async () => null,
        currentVersion: async () => 2,
        beginTreeBaseline: async ({ baseline }) => { calls.push('begin'); assert.equal(baseline.total_field_count, 4); return { baselineId: parent.baselineId, version: 3 }; },
        writeTreeCapture: async () => { calls.push('write-tree'); return { valueBytes: 1 }; },
        verifyTreeCapture: async ({ expectedFieldCount }) => { calls.push('verify-tree'); assert.equal(expectedFieldCount, 4); },
        nextVersions: async ids => { calls.push(['next-versions', ids.map(Number).sort()]); return id => (Number(id) === 2 ? 5 : 1); },
        writeChildBaselines: async ({ rows }) => { calls.push(['write-children', rows.map(r => [r.issue_id, r.version])]);
          return rows.map(r => ({ ...r, baseline_id: Buffer.alloc(16, 4) })); },
        writeVersionEvidence: async ({ entries }) => { calls.push(['evidence', entries.map(e => [e.cause, e.evidence.rules[0].source])]); evidenceEntries.push(...entries); },
        pinChildVersions: async ({ pins }) => { calls.push(['pins', pins.map(p => [p.issueId, p.version])]); },
        recordNodeSecurity: async ({ levels }) => { calls.push(['security', levels.length]); },
        activeBaselines: async () => new Map(),
        publishTreeBaseline: async ({ requireEvidence }) => { calls.push(['publish-tree', requireEvidence]); },
        publishChildBaselines: async ({ requireEvidence }) => { calls.push(['publish-children', requireEvidence]); return { children: [] }; },
        upsertBaselined: async state => { calls.push(['item-state', state.issueId]); itemStates.push(state); },
        tryAppend: async event => { ledger.push(event); }
      }
    }
  };
}

test('a parent capture writes each child\'s baseline before it publishes and publishes them after', async () => {
  const f = captureFixture();
  const result = await writeCapturedTreeBaseline(f.args);
  assert.equal(result.captured, true);
  assert.deepEqual(f.calls, ['begin', 'write-tree', 'verify-tree', ['next-versions', [1, 2]], ['write-children', [[2, 5]]],
    ['evidence', [['DRIFT_DECISION', 'OWN'], ['PARENT_CAPTURE', 'INHERITED']]], ['pins', [[2, 5]]], ['security', 0],
    ['publish-tree', true], ['publish-children', true], ['item-state', 1], ['item-state', 2]]);
  // The child's key and project let the vault copy its files too; `attachments`
  // is null because the child tracks no attachment field.
  assert.deepEqual(result.children, [{ issueId: 2, version: 5, baselineId: Buffer.alloc(16, 4),
    issueKey: 'P-2', projectId: 1, attachments: null }]);
  const child = f.itemStates.find(s => s.issueId === 2);
  assert.equal(child.baselineVersion, 5);
  assert.equal(child.issueKey, 'P-2');
  assert.equal(child.summary, 'sub');
  // The child is a Task-like type the root's page never configured; it is held
  // to the root's fields all the same (tree/nodeFields.js, decided 2026-09-25).
  assert.deepEqual(Object.keys(JSON.parse(child.fieldDigests)).sort(), ['description', 'summary'],
    'the child is tracked with the root\'s fields');
  const entry = f.ledger.find(e => e.issueId === 2);
  assert.equal(entry.eventType, 'BASELINE_CAPTURED');
  assert.deepEqual(entry.payload.capturedBy, { issueId: 1, issueKey: 'P-1', version: 3 });
});

test('a parent with no children writes no child baselines and reads no versions', async () => {
  const f = captureFixture();
  const root = f.args.rootIssue.fields;
  f.args.deps.readStableTree = async () => ({ tree: { nodes: [{ id: '1', key: 'P-1', fields: root }] } });
  f.args.approval.content_hash = planTreeCapture({ rootIssueId: '1', nodes: [{ id: '1', key: 'P-1', fields: root }],
    controlledFields: f.args.controlledFields }).treeHash;
  f.args.deps.beginTreeBaseline = async () => ({ baselineId: parent.baselineId, version: 3 });
  f.args.deps.verifyTreeCapture = async () => {};
  const result = await writeCapturedTreeBaseline(f.args);
  assert.equal(result.captured, true);
  assert.deepEqual(result.children, []);
  assert.ok(!f.calls.some(c => Array.isArray(c) && ['next-versions', 'write-children'].includes(c[0])));
  assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === 'publish-children'));
});

test('a retry of a published parent repairs its children\'s publication', async () => {
  const f = captureFixture();
  f.args.deps.baselineForApproval = async () => ({ state: 'ACTIVE', baseline_id: parent.baselineId, issue_id: 1, version: 3,
    tree_hash: f.args.approval.content_hash, content_hash: f.args.approval.content_hash, node_count: 2, total_field_count: 3,
    project_id: 1, issue_type_id: 'S', field_digests: '{}' });
  f.args.deps.readStableTree = async () => assert.fail('a published capture never rereads Jira');
  f.args.deps.publishChildBaselines = async () => ({ children: [{ issue_id: 2, issue_key: 'P-2', project_id: 1, issue_type_id: 'T',
    version: 5, baseline_id: Buffer.alloc(16, 4), content_hash: 'c', field_digests: '{"summary":"d"}' }] });
  f.args.deps.getReview = async () => ({ summary: 'kept' });
  const result = await writeCapturedTreeBaseline(f.args);
  assert.equal(result.alreadyCaptured, true);
  const child = f.itemStates.find(s => s.issueId === 2);
  assert.equal(child.baselineVersion, 5);
  assert.equal(child.summary, 'kept');
});

test('each child\'s version records the parent\'s rule as inherited from this capture, and the parent\'s signature', async () => {
  const f = captureFixture();
  await writeCapturedTreeBaseline(f.args);
  const [root, child] = f.evidenceEntries;
  assert.ok(root.baselineId.equals(parent.baselineId));
  assert.equal(root.evidence.rules[0].source, 'OWN');
  assert.equal(root.evidence.signatures[0].status_at_capture, '3');
  assert.ok(child.baselineId.equals(Buffer.alloc(16, 4)));
  const [rule] = child.evidence.rules;
  assert.equal(rule.source, 'INHERITED');
  assert.ok(rule.imposed_by_baseline_id.equals(parent.baselineId));
  assert.equal(rule.imposed_by_version, 3);
  assert.deepEqual(child.evidence.fields.map(field => field.field_id).sort(), ['description', 'summary']);
  const [signature] = child.evidence.signatures;
  assert.equal(signature.cause, 'PARENT_CAPTURE');
  assert.ok(signature.cause_baseline_id.equals(parent.baselineId));
  assert.equal(signature.status_at_capture, '1', 'the child\'s own status when it was captured');
});

test('a node\'s security level is recorded with the parent capture', async () => {
  const f = captureFixture();
  const tree = await f.args.deps.readStableTree();
  tree.tree.nodes[1].fields.security = { id: '10000' };
  f.args.deps.readStableTree = async () => tree;
  const levels = [];
  f.args.deps.recordNodeSecurity = async ({ levels: given }) => { levels.push(...given); };
  await writeCapturedTreeBaseline(f.args);
  assert.deepEqual(levels, [{ issueId: 2, securityLevelId: '10000' }]);
});

test('a node Jira returned without its security level is recorded with the level UNKNOWN', async () => {
  const f = captureFixture();
  const tree = await f.args.deps.readStableTree();
  delete tree.tree.nodes[1].fields.security;
  f.args.deps.readStableTree = async () => tree;
  const levels = [];
  f.args.deps.recordNodeSecurity = async ({ levels: given }) => { levels.push(...given); };
  await writeCapturedTreeBaseline(f.args);
  assert.deepEqual(levels, [{ issueId: 2, securityLevelId: 'UNKNOWN' }]);
});

test('security levels: absent is UNKNOWN, null is no level, otherwise the level\'s id', () => {
  assert.deepEqual(nodeSecurityLevels([
    { id: '1', fields: { security: { id: 10000 } } },
    { id: '2', fields: { security: null } },
    { id: '3', fields: { summary: 'no security key' } },
    { id: '4' }
  ]), [{ issueId: 1, securityLevelId: '10000' }, { issueId: 3, securityLevelId: 'UNKNOWN' },
    { issueId: 4, securityLevelId: 'UNKNOWN' }]);
  assert.deepEqual(nodeSecurityLevels([]), []);
});

test('a parent capture without its rule scope is refused before anything is written', async () => {
  const f = captureFixture();
  f.args.ruleScope = null;
  assert.equal((await writeCapturedTreeBaseline(f.args)).reason, 'BASELINE_POLICY_INCOMPLETE');
  assert.deepEqual(f.calls, []);
});

test('child publication can require each child\'s evidence', async () => {
  const writes = [];
  await publishChildBaselines({ parentBaselineId: parent.baselineId, requireEvidence: true,
    write: async (sql, params) => { writes.push(sql); return { result: true, data: { affectedRows: 0 } }; },
    query: async sql => (/COUNT\(\*\)/.test(sql) ? [{ n: 0 }] : []) });
  assert.match(writes[0], /controlled_fields_hash IS NOT NULL AND policy_recorded = TRUE/);
});

test('child publication that requires evidence refuses unless every capturing child of this parent published', async () => {
  const run = (capturing, activated) => {
    const log = [];
    const published = publishChildBaselines({ parentBaselineId: parent.baselineId, requireEvidence: true,
      write: async sql => { log.push(['activate', sql]); return { result: true, data: { affectedRows: activated } }; },
      query: async (sql, params) => {
        log.push(['query', sql.replace(/\s+/g, ' ').trim(), params]);
        return /COUNT\(\*\)/.test(sql) ? [{ n: capturing }] : [];
      } });
    return { log, published };
  };
  const short = run(2, 1);
  await assert.rejects(() => short.published, error => error.reason === 'CAPTURE_INCOMPLETE');
  assert.equal(short.log[0][0], 'query', 'the capturing children are counted before any is activated');
  assert.equal(short.log[0][1], 'SELECT COUNT(*) AS n FROM va_baseline '
    + 'WHERE captured_by_baseline_id = FROM_BASE64(?) AND state = \'CAPTURING\'');
  assert.deepEqual(short.log[0][2], [parent.baselineId.toString('base64')]);
  assert.equal(short.log[1][0], 'activate');
  assert.equal(short.log.length, 2, 'a short publication retires no older version');
  const unread = run(undefined, 0);
  await assert.rejects(() => unread.published, error => error.reason === 'CAPTURE_INCOMPLETE', 'an unreadable count refuses');
  const whole = run(2, 2);
  assert.equal((await whole.published).published, 2);
});

test('child publication without the evidence requirement counts nothing (a retry of a published parent)', async () => {
  const queries = [];
  await publishChildBaselines({ parentBaselineId: parent.baselineId,
    write: async () => ({ result: true, data: { affectedRows: 0 } }),
    query: async sql => { queries.push(sql); return []; } });
  assert.ok(!queries.some(sql => /COUNT\(\*\)/.test(sql)));
});

test('a tracked link field records each version\'s links with the version of the issue it points at', async () => {
  const f = captureFixture();
  const links = { field_id: 'issuelinks', field_kind: 'LINKS', store_values: true, materiality: 'MAJOR' };
  const fields = [...f.args.controlledFields, links];
  const tree = await f.args.deps.readStableTree();
  tree.tree.nodes[0].fields.issuelinks = [{ id: '700', type: { id: '10', name: 'Blocks' },
    outwardIssue: { id: '9', key: 'P-9' } }];
  tree.tree.nodes[1].fields.issuelinks = [];
  f.args.controlledFields = fields;
  f.args.approval.content_hash = planTreeCapture({ rootIssueId: '1', nodes: tree.tree.nodes, controlledFields: fields }).treeHash;
  f.args.deps.readStableTree = async () => tree;
  f.args.deps.beginTreeBaseline = async () => ({ baselineId: parent.baselineId, version: 3 });
  f.args.deps.verifyTreeCapture = async () => {};
  const asked = [];
  f.args.deps.activeBaselines = async ids => { asked.push(ids); return new Map([[9, { baseline_id: Buffer.alloc(16, 6), version: 4 }]]); };
  await writeCapturedTreeBaseline(f.args);
  assert.deepEqual(asked, [[9]], 'one lookup for every linked issue in the tree');
  const [root, child] = f.evidenceEntries;
  assert.equal(root.links.length, 1);
  assert.equal(root.links[0].other_issue_key, 'P-9');
  assert.equal(root.links[0].other_baseline_version, 4);
  assert.deepEqual(child.links, [], 'a tracked link field with no links records none');
});
