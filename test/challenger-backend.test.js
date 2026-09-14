import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';

// --- Mock Module Fixture Setup ---
globalThis.vaChallenger = {
  dbQueries: [],
  storeQueries: [],
  jiraRequests: [],
  config: { enabled: true, reviewerFieldId: 'customfield_1001' },
  controlledFields: [],
  gatedTransition: null,
  approval: null,
  baselineVersion: 0,
  writtenBaseline: null,
  itemState: null,
  auditEvents: []
};

const mockedModules = {
  'lib/db.js': ['executeQuery', 'toBinaryParam', 'fromBinaryColumn', 'limitClause', 'affectedRows'],
  'db/store.js': ['newId', 'throwing', 'tryAppend', 'isDuplicateKey'],
  'db/configStore.js': [
    'controlledFields', 'projectConfig', 'gatedTransition',
    'declaredFieldRows', 'seedControlledFields', 'countControlledFields'
  ],
  'db/baselineStore.js': ['writeBaseline', 'currentVersion', 'baselineForApproval'],
  'db/itemStateStore.js': ['upsertBaselined', 'getReview']
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(mockedModules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const route = (strings, ...values) => {
            const path = strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '');
            return { path, toString: () => path };
          };
          export default {
            asApp: () => ({
              requestJira: async (route, options) => {
                globalThis.vaChallenger.jiraRequests.push({ route, options });
                return globalThis.vaChallenger.handleJira(route, options);
              }
            })
          };
        `
      };
    }
    const moduleKey = url.slice(8);
    if (moduleKey === 'lib/db.js') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const toBinaryParam = (x) => Buffer.isBuffer(x) ? x : Buffer.from(String(x ?? ''));
          export const fromBinaryColumn = (x) => Buffer.isBuffer(x) ? x : Buffer.from(String(x ?? ''), 'base64');
          export const limitClause = (x) => \`LIMIT \${x}\`;
          export const affectedRows = (res) => Number(res?.affectedRows ?? 1);
          export const executeQuery = async (sql, params) => {
            globalThis.vaChallenger.dbQueries.push({ sql, params });
            return { result: true, data: globalThis.vaChallenger.dbResultData || [] };
          };
        `
      };
    }
    if (moduleKey === 'db/store.js') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const newId = () => Buffer.from('fixed_16_byte_id');
          export const throwing = async (sql, params) => {
            globalThis.vaChallenger.storeQueries.push({ sql, params });
            return globalThis.vaChallenger.storeResultData || { affectedRows: 1 };
          };
          export const tryAppend = async (event) => {
            globalThis.vaChallenger.auditEvents.push(event);
            return true;
          };
          export const isDuplicateKey = (err) => err?.code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(err?.message ?? '');
        `
      };
    }
    if (moduleKey === 'db/configStore.js') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const projectConfig = async (projectId) => globalThis.vaChallenger.config;
          export const controlledFields = async (query) => globalThis.vaChallenger.controlledFields;
          export const gatedTransition = async (query) => globalThis.vaChallenger.gatedTransition;
          export const declaredFieldRows = async (query) => globalThis.vaChallenger.controlledFields;
          export const seedControlledFields = async () => true;
          export const countControlledFields = async () => globalThis.vaChallenger.controlledFields.length;
        `
      };
    }
    if (moduleKey === 'db/baselineStore.js') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const writeBaseline = async (plan) => {
            globalThis.vaChallenger.writtenBaseline = plan;
            return { baselineId: Buffer.from('baseline_16_byte') };
          };
          export const currentVersion = async (issueId) => globalThis.vaChallenger.baselineVersion;
          export const baselineForApproval = async (issueId, approvalId) => globalThis.vaChallenger.existingBaseline || null;
        `
      };
    }
    if (moduleKey === 'db/itemStateStore.js') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const upsertBaselined = async (state) => {
            globalThis.vaChallenger.itemState = state;
            return true;
          };
          export const getReview = async (issueId) => globalThis.vaChallenger.review || null;
        `
      };
    }
    return next(url, context);
  }
});

// Dynamic imports after module hooks registered
const { captureBaseline } = await import('../src/lib/capture.js');
const { recordRecallFinding, clearRecallFindings } = await import('../src/db/incidentStore.js');
const { createTreeReader } = await import('../src/lib/tree/jira.js');
const { encodeValue, decodeValue, CHUNK_CHARS, ENCODING } = await import('../src/lib/valuestore.js');
const { MIGRATIONS } = await import('../src/db/migrations.js');
const {
  startRestore,
  markRestoreQueued,
  markRestoreQueueFailure,
  claimRestore,
  heartbeatRestore,
  beginRestoreVerification,
  finishQueuedRestore,
  failRestore
} = await import('../src/db/restoreStore.js');

// ============================================================================
// CHALLENGE 1: TDZ Fix and Edge Cases in `captureBaseline` (`src/lib/capture.js`)
// ============================================================================
test('Challenge 1.1: captureBaseline with unretained fields returns BASELINE_VALUES_REQUIRED without TDZ ReferenceError', async () => {
  globalThis.vaChallenger.jiraRequests = [];
  globalThis.vaChallenger.config = { enabled: true, reviewerFieldId: 'customfield_1001' };
  globalThis.vaChallenger.controlledFields = [
    { field_id: 'summary', field_kind: 'TEXT', store_values: 0, materiality: 'MAJOR' }
  ];
  globalThis.vaChallenger.gatedTransition = {
    capture_baseline: true,
    required_role: 'QA',
    required_assurance: 'ESIGNATURE'
  };
  globalThis.vaChallenger.dbResultData = [{
    approval_id: Buffer.from('approval_id_16b').toString('base64'),
    actor_account_id: 'user_123',
    actor_name: 'Tester',
    assurance_level: 'ESIGNATURE',
    decision: 'APPROVE',
    state: 'CONSUMED',
    content_hash: 'dummy_hash'
  }];
  globalThis.vaChallenger.handleJira = async (route) => {
    if (route.path.includes('/changelog')) {
      return { ok: true, json: async () => ({ values: [], total: 0 }) };
    }
    if (route.path.includes('/editmeta')) {
      return { ok: true, json: async () => ({ fields: { summary: { name: 'Summary' } } }) };
    }
    return {
      ok: true,
      json: async () => ({
        id: '1001',
        key: 'PROJ-1',
        fields: {
          project: { id: '10' },
          issuetype: { id: '1' },
          summary: 'My Summary'
        }
      })
    };
  };

  const result = await captureBaseline({
    issueId: 1001,
    issueKey: 'PROJ-1',
    transition: { from: { id: '10' }, to: { id: '20' }, transitionId: '31' },
    transitionAt: 1000
  });

  // Must NOT throw ReferenceError (TDZ on fields)
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'BASELINE_VALUES_REQUIRED');
});

test('Challenge 1.2: captureBaseline when gate.capture_baseline is false returns CAPTURE_DISABLED', async () => {
  globalThis.vaChallenger.config = { enabled: true };
  globalThis.vaChallenger.controlledFields = [{ field_id: 'summary', store_values: true }];
  globalThis.vaChallenger.gatedTransition = { capture_baseline: false };

  const result = await captureBaseline({
    issueId: 1001,
    transition: { from: { id: '10' }, to: { id: '20' } }
  });

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'CAPTURE_DISABLED');
});

test('Challenge 1.3: captureBaseline when config.enabled is false returns DISABLED', async () => {
  globalThis.vaChallenger.config = { enabled: false };
  globalThis.vaChallenger.gatedTransition = { capture_baseline: true };

  const result = await captureBaseline({
    issueId: 1001,
    transition: { from: { id: '10' }, to: { id: '20' } }
  });

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'DISABLED');
});

test('Challenge 1.4: captureBaseline when not a gated transition returns NOT_A_GATE', async () => {
  globalThis.vaChallenger.config = { enabled: true };
  globalThis.vaChallenger.gatedTransition = null;

  const result = await captureBaseline({
    issueId: 1001,
    transition: { from: { id: '10' }, to: { id: '20' } }
  });

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'NOT_A_GATE');
});

test('Challenge 1.5: captureBaseline when issue fetch fails returns ISSUE_UNREADABLE', async () => {
  globalThis.vaChallenger.handleJira = async () => ({ ok: false, status: 404 });

  const result = await captureBaseline({
    issueId: 9999,
    transition: { from: { id: '10' }, to: { id: '20' } }
  });

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'ISSUE_UNREADABLE');
});

test('Challenge 1.6: captureBaseline catches unexpected errors and returns reason ERROR without crashing', async () => {
  globalThis.vaChallenger.handleJira = async () => { throw new Error('Simulated network crash'); };

  const result = await captureBaseline({
    issueId: 1001,
    transition: { from: { id: '10' }, to: { id: '20' } }
  });

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'ERROR');
  assert.match(result.error, /Simulated network crash/);
});

// ============================================================================
// CHALLENGE 2: Status Swap in `recordRecallFinding` (`src/db/incidentStore.js`)
// ============================================================================
test('Challenge 2.1: recordRecallFinding maps currentStatusId to from_status_id and targetStatusId to to_status_id', async () => {
  globalThis.vaChallenger.dbQueries = [];

  const ok = await recordRecallFinding({
    baselineId: 'base_abc',
    baselineVersion: 3,
    issueId: 42,
    projectId: 100,
    issueTypeId: 5,
    failureType: 'SCREEN_BLOCKED',
    currentStatusId: 'STATUS_CURRENT',
    targetStatusId: 'STATUS_TARGET',
    offeredTransitionIds: ['TRANS_1'],
    hasScreen: true,
    jiraResponse: { error: 'screen required' },
    now: 55555
  });

  assert.equal(ok, true);
  assert.equal(globalThis.vaChallenger.dbQueries.length, 1);
  const { sql, params } = globalThis.vaChallenger.dbQueries[0];

  assert.match(sql, /INSERT INTO va_gate_finding/);
  assert.match(sql, /from_status_id,\s*to_status_id/);

  // Parameter index checks:
  // [0]: findingKey
  // [1]: finding_type ('RECALL_SCREEN_BLOCKED')
  // [2]: severity ('WARNING')
  // [3]: project_id ('100')
  // [4]: issue_type_id ('5')
  // [5]: transition_id ('TRANS_1')
  // [6]: from_status_id ('STATUS_CURRENT')
  // [7]: to_status_id ('STATUS_TARGET')
  assert.equal(params[0], 'RECALL:base_abc:3:SCREEN_BLOCKED');
  assert.equal(params[1], 'RECALL_SCREEN_BLOCKED');
  assert.equal(params[3], '100');
  assert.equal(params[5], 'TRANS_1');
  assert.equal(params[6], 'STATUS_CURRENT', 'Index 6 MUST be currentStatusId (from_status_id)');
  assert.equal(params[7], 'STATUS_TARGET', 'Index 7 MUST be targetStatusId (to_status_id)');
  assert.equal(params[9], 55555);
  assert.equal(params[10], 55555);
});

test('Challenge 2.2: recordRecallFinding transition_id behavior with zero or multiple offered transitions', async () => {
  globalThis.vaChallenger.dbQueries = [];

  // Zero offered transitions
  await recordRecallFinding({
    baselineId: 'b', baselineVersion: 1, issueId: 1, projectId: 1, issueTypeId: 1,
    failureType: 'NO_ROUTE', currentStatusId: '1', targetStatusId: '2',
    offeredTransitionIds: [], now: 100
  });
  assert.equal(globalThis.vaChallenger.dbQueries[0].params[5], null);

  // Multiple offered transitions (ambiguous)
  globalThis.vaChallenger.dbQueries = [];
  await recordRecallFinding({
    baselineId: 'b', baselineVersion: 1, issueId: 1, projectId: 1, issueTypeId: 1,
    failureType: 'MULTIPLE_ROUTES', currentStatusId: '1', targetStatusId: '2',
    offeredTransitionIds: ['T1', 'T2'], now: 100
  });
  assert.equal(globalThis.vaChallenger.dbQueries[0].params[5], null);
});

test('Challenge 2.3: clearRecallFindings issues proper wildcard update', async () => {
  globalThis.vaChallenger.dbQueries = [];

  const ok = await clearRecallFindings({
    baselineId: 'b_test',
    baselineVersion: 2,
    now: 9999
  });

  assert.equal(ok, true);
  assert.equal(globalThis.vaChallenger.dbQueries.length, 1);
  const { sql, params } = globalThis.vaChallenger.dbQueries[0];
  assert.match(sql, /UPDATE va_gate_finding/);
  assert.match(sql, /WHERE finding_key LIKE \? AND cleared_at IS NULL/);
  assert.equal(params[0], 9999);
  assert.equal(params[1], 'RECALL:b_test:2:%');
});

// ============================================================================
// CHALLENGE 3: Missing 'parent' Field in `createTreeReader` (`src/lib/tree/jira.js`)
// ============================================================================
test('Challenge 3.1: createTreeReader normalizes omitted parent field on root AND child issues without throwing', async () => {
  const api = {
    asApp: () => ({
      requestJira: async (route, options) => {
        if (route.path.includes('/issue/ROOT-1')) {
          // Jira REST v3: 'parent' property is completely absent on top-level root
          return {
            status: 200,
            json: async () => ({
              id: '100',
              key: 'ROOT-1',
              fields: {
                project: { id: '10' },
                issuetype: { id: '1' },
                status: { id: '10' },
                summary: 'Epic with no parent'
              }
            })
          };
        }
        if (route.path.includes('/search/jql')) {
          const body = JSON.parse(options.body);
          if (body.jql === 'parent IN ("ROOT-1")') {
            return {
              status: 200,
              json: async () => ({
                issues: [
                  {
                    id: '101',
                    key: 'CHILD-1',
                    fields: {
                      project: { id: '10' },
                      issuetype: { id: '2' },
                      status: { id: '10' },
                      summary: 'Child where parent was also omitted by Jira',
                      // 'parent' omitted
                    }
                  },
                  {
                    id: '102',
                    key: 'CHILD-2',
                    fields: {
                      project: { id: '10' },
                      issuetype: { id: '2' },
                      status: { id: '10' },
                      summary: 'Child where parent is present',
                      parent: { id: '100', key: 'ROOT-1' }
                    }
                  }
                ]
              })
            };
          }
          return { status: 200, json: async () => ({ issues: [] }) };
        }
        throw new Error('Unexpected route: ' + route.path);
      }
    })
  };

  const route = (strings, ...values) => {
    const path = strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '');
    return { path, toString: () => path };
  };

  const reader = createTreeReader({ api, route });
  const tree = await reader.read('ROOT-1', ['summary']);

  assert.equal(tree.nodes.length, 3);
  // Root node: parent normalized to null
  assert.equal(tree.nodes[0].key, 'ROOT-1');
  assert.equal(tree.nodes[0].fields.parent, null);

  // Child-1: parent normalized to null
  assert.equal(tree.nodes[1].key, 'CHILD-1');
  assert.equal(tree.nodes[1].fields.parent, null);

  // Child-2: existing parent preserved
  assert.equal(tree.nodes[2].key, 'CHILD-2');
  assert.deepEqual(tree.nodes[2].fields.parent, { id: '100', key: 'ROOT-1' });

  // Edges properly formed
  assert.equal(tree.edges.length, 2);
  assert.deepEqual(tree.edges[0], { source: '100', target: '101' });
  assert.deepEqual(tree.edges[1], { source: '100', target: '102' });
});

test('Challenge 3.2: createTreeReader detects cyclical issue graphs and aborts', async () => {
  const api = {
    asApp: () => ({
      requestJira: async (route, options) => {
        if (route.path.includes('/issue/ROOT-1')) {
          return {
            status: 200,
            json: async () => ({
              id: '100', key: 'ROOT-1',
              fields: { project: { id: '1' }, issuetype: { id: '1' }, status: { id: '1' } }
            })
          };
        }
        if (route.path.includes('/search/jql')) {
          // Cycle: ROOT-1 has child CHILD-1, which has child ROOT-1
          const body = JSON.parse(options.body);
          if (body.jql === 'parent IN ("ROOT-1")') {
            return {
              status: 200,
              json: async () => ({
                issues: [{
                  id: '101', key: 'CHILD-1',
                  fields: { project: { id: '1' }, issuetype: { id: '1' }, status: { id: '1' }, parent: { id: '100' } }
                }]
              })
            };
          }
          if (body.jql === 'parent IN ("CHILD-1")') {
            return {
              status: 200,
              json: async () => ({
                issues: [{
                  id: '100', key: 'ROOT-1',
                  fields: { project: { id: '1' }, issuetype: { id: '1' }, status: { id: '1' }, parent: { id: '101' } }
                }]
              })
            };
          }
        }
        return { status: 200, json: async () => ({ issues: [] }) };
      }
    })
  };
  const route = (strings, ...values) => {
    const path = strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '');
    return { path, toString: () => path };
  };
  const reader = createTreeReader({ api, route });

  await assert.rejects(
    () => reader.read('ROOT-1', []),
    /Cycle detected/
  );
});

// ============================================================================
// CHALLENGE 4: Large Chunk Storage & Migrations (`src/lib/valuestore.js`)
// ============================================================================
test('Challenge 4.1: encodeValue generates true multi-chunk payloads on large uncompressible data and fits 60KB bounds', async () => {
  assert.equal(CHUNK_CHARS, 60_000);

  // Generate 180 KB of random base64 data which gzip cannot compress away
  const largeRandom = crypto.randomBytes(180_000).toString('base64');
  const payload = { documentContent: largeRandom };

  const encoded = encodeValue(payload);
  assert.ok(encoded.chunks.length >= 3, `Expected at least 3 chunks, got ${encoded.chunks.length}`);

  for (let seq = 0; seq < encoded.chunks.length; seq++) {
    const chunk = encoded.chunks[seq];
    assert.ok(chunk.length <= CHUNK_CHARS, `Chunk ${seq} length ${chunk.length} > ${CHUNK_CHARS}`);
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 65_535, `Chunk ${seq} byteLength exceeds MySQL TEXT 64KB`);
  }

  // Simulate storing and reassembling out-of-order rows
  const rows = encoded.chunks.map((chunk, seq) => ({
    seq,
    encoding: encoded.encoding,
    raw_bytes: encoded.rawBytes,
    data: chunk
  }));
  rows.reverse(); // Reverse order to challenge reassembly sort

  const decoded = decodeValue(rows);
  assert.equal(decoded.present, true);
  assert.equal(decoded.value.documentContent, largeRandom);
});

test('Challenge 4.2: decodeValue rejects missing chunk sequences and corrupted encodings', async () => {
  // Missing intermediate chunk (has seq 0 and seq 2, missing seq 1)
  assert.throws(
    () => decodeValue([
      { seq: 0, encoding: ENCODING.PLAIN_B64, data: 'chunk0' },
      { seq: 2, encoding: ENCODING.PLAIN_B64, data: 'chunk2' }
    ]),
    /BASELINE_VALUE_INCOMPLETE/
  );

  // Duplicate chunk sequence (two seq 0 rows)
  assert.throws(
    () => decodeValue([
      { seq: 0, encoding: ENCODING.PLAIN_B64, data: 'chunk0' },
      { seq: 0, encoding: ENCODING.PLAIN_B64, data: 'chunk0' }
    ]),
    /BASELINE_VALUE_INCOMPLETE/
  );

  // Invalid encoding
  assert.throws(
    () => decodeValue([{ seq: 0, encoding: 'INVALID_ENCODING', data: 'abc' }]),
    /BASELINE_VALUE_ENCODING/
  );
});

test('Challenge 4.3: Migration schema integrity for MEDIUMTEXT columns', async () => {
  const v34 = MIGRATIONS.find(m => m.id === 'v034_baseline_node_value');
  assert.ok(v34, 'Migration v034 must exist');
  assert.match(v34.sql, /chunk MEDIUMTEXT NOT NULL/);

  const v41 = MIGRATIONS.find(m => m.id === 'v041_baseline_node_value_mediumtext');
  assert.ok(v41, 'Migration v041 must exist');
  assert.match(v41.sql, /ALTER TABLE va_baseline_node_value MODIFY COLUMN chunk MEDIUMTEXT NOT NULL/);

  const v40 = MIGRATIONS.find(m => m.id === 'v040_restore_progress');
  assert.ok(v40, 'Migration v040 must exist');
  assert.match(v40.sql, /ADD COLUMN total_steps INT NOT NULL DEFAULT 0/);
});

// ============================================================================
// CHALLENGE 5: Restored State in `src/db/restoreStore.js`
// ============================================================================
test('Challenge 5.1: startRestore properly maps state, detail, candidateDigests, totalSteps to correct placeholders', async () => {
  globalThis.vaChallenger.storeQueries = [];

  const restoreId = await startRestore({
    approvalId: Buffer.from('app_id_16_bytes!'),
    issueId: 100,
    projectId: 200,
    baselineId: Buffer.from('base_id_16_bytes'),
    baselineVersion: 4,
    actorAccountId: 'actor_999',
    now: 1234567,
    state: 'QUEUING',
    totalSteps: 15,
    detail: [{ step: 'CREATE', key: 'K1' }],
    candidateDigests: { 'summary': 'dig1' }
  });

  assert.ok(restoreId, 'Must return generated restoreId');
  assert.equal(globalThis.vaChallenger.storeQueries.length, 1);
  const { sql, params } = globalThis.vaChallenger.storeQueries[0];

  assert.match(sql, /INSERT INTO va_restore/);
  // Expected columns:
  // 1. restore_id -> param 0
  // 2. approval_id -> param 1
  // 3. issue_id -> param 2
  // 4. project_id -> param 3
  // 5. baseline_id -> param 4
  // 6. baseline_version -> param 5
  // 7. actor_account_id -> param 6
  // 8. started_at -> param 7
  // 9. state -> param 8
  // 10. detail -> param 9
  // 11. candidate_digests -> param 10
  // 12. total_steps -> param 11
  assert.equal(params.length, 12, 'Must have exactly 12 parameters matching 12 placeholders');
  assert.equal(params[2], 100, 'issue_id');
  assert.equal(params[3], 200, 'project_id');
  assert.equal(params[5], 4, 'baseline_version');
  assert.equal(params[6], 'actor_999', 'actor_account_id');
  assert.equal(params[7], 1234567, 'started_at');
  assert.equal(params[8], 'QUEUING', 'state MUST be param 8');
  assert.equal(params[9], JSON.stringify([{ step: 'CREATE', key: 'K1' }]), 'detail MUST be param 9');
  assert.equal(params[10], JSON.stringify({ summary: 'dig1' }), 'candidate_digests MUST be param 10');
  assert.equal(params[11], 15, 'total_steps MUST be param 11');
});

test('Challenge 5.2: Async restore state transitions in restoreStore', async () => {
  const dummyId = Buffer.from('restore_id_16byt');

  // markRestoreQueued
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const queuedOk = await markRestoreQueued({
    restoreId: dummyId, jobId: 'job_abc', now: 2000, totalSteps: 10
  });
  assert.equal(queuedOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET state = 'QUEUING'/);

  // claimRestore
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const claimedOk = await claimRestore({ restoreId: dummyId, now: 2100 });
  assert.equal(claimedOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET state = 'RESTORING'/);

  // heartbeatRestore
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const heartbeatOk = await heartbeatRestore({
    restoreId: dummyId, completedSteps: 5, totalSteps: 10, now: 2200
  });
  assert.equal(heartbeatOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET heartbeat_at = \?, completed_steps = \?/);

  // beginRestoreVerification
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const verifyOk = await beginRestoreVerification({ restoreId: dummyId, now: 2300 });
  assert.equal(verifyOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET state = 'VERIFYING'/);

  // finishQueuedRestore
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const finishOk = await finishQueuedRestore({
    restoreId: dummyId,
    now: 2400,
    counters: { attempted: 10, succeeded: 10, failed: 0, skipped: 0, irreversible: 0, completedSteps: 10 },
    state: 'COMPLETE',
    detail: [{ completed: true }]
  });
  assert.equal(finishOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET finished_at = \?, attempted = \?/);

  // failRestore
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const failOk = await failRestore({ restoreId: dummyId, error: new Error('Verification failed'), now: 2500 });
  assert.equal(failOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET state = \?, finished_at = \?, heartbeat_at = NULL, last_error = \?/);

  // markRestoreQueueFailure
  globalThis.vaChallenger.storeQueries = [];
  globalThis.vaChallenger.storeResultData = { affectedRows: 1 };
  const qFailOk = await markRestoreQueueFailure({ restoreId: dummyId, error: 'Queue push timeout', now: 2600 });
  assert.equal(qFailOk, true);
  assert.match(globalThis.vaChallenger.storeQueries[0].sql, /UPDATE va_restore SET state = 'QUEUING_FAILED'/);
});
