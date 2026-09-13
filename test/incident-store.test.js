import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const executed = [];
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/lib/db.js')) return { url: 'fixture:db', shortCircuit: true };
    if (specifier.endsWith('/db/store.js')) return { url: 'fixture:store', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:db') return { format: 'module', shortCircuit: true, source: `
      export const toBinaryParam = (x) => x;
      export const fromBinaryColumn = (x) => x;
      export const limitClause = (x) => \`LIMIT \${x}\`;
      export const executeQuery = async (sql, params) => {
        globalThis.executedQueries.push({ sql, params });
        return { result: true };
      };
    ` };
    if (url === 'fixture:store') return { format: 'module', shortCircuit: true, source: `
      export const newId = () => Buffer.from('id');
      export const throwing = async (sql, params) => {
        globalThis.executedQueries.push({ sql, params });
        return [];
      };
    ` };
    return next(url, context);
  }
});

const { recordRecallFinding, clearRecallFindings } = await import('../src/db/incidentStore.js');

test('recordRecallFinding builds a deduplicated finding with correct parameters', async () => {
  globalThis.executedQueries = [];
  
  await recordRecallFinding({
    baselineId: 'b1', baselineVersion: 1, issueId: 10, projectId: 20, issueTypeId: 30, failureType: 'SCREEN_BLOCKED',
    currentStatusId: '40', targetStatusId: '50', offeredTransitionIds: ['60'], hasScreen: true, jiraResponse: null, now: 1000
  });

  assert.equal(globalThis.executedQueries.length, 1);
  const { sql, params } = globalThis.executedQueries[0];
  
  assert.match(sql, /INSERT INTO va_gate_finding/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(sql, /last_seen_at = VALUES\(last_seen_at\)/);
  assert.match(sql, /cleared_at\s*=\s*NULL/);
  
  // 11 parameters in the INSERT list
  assert.equal(params.length, 11);
  assert.equal(params[0], 'RECALL:b1:1:SCREEN_BLOCKED'); // finding_key
  assert.equal(params[1], 'RECALL_SCREEN_BLOCKED'); // finding_type
  assert.equal(params[3], '20'); // project_id
  assert.equal(params[5], '60'); // transition_id
  assert.equal(params[6], '50'); // from_status_id (targetStatusId)
  assert.equal(params[7], '40'); // to_status_id (currentStatusId)
});

test('clearRecallFindings clears findings for a baseline', async () => {
  globalThis.executedQueries = [];
  
  await clearRecallFindings({
    baselineId: 'b1', baselineVersion: 1, now: 2000
  });

  assert.equal(globalThis.executedQueries.length, 1);
  const { sql, params } = globalThis.executedQueries[0];
  
  assert.match(sql, /UPDATE va_gate_finding/);
  assert.match(sql, /SET cleared_at = \?/);
  assert.match(sql, /finding_key LIKE \?/);
  
  assert.equal(params.length, 2);
  assert.equal(params[0], 2000);
  assert.equal(params[1], 'RECALL:b1:1:%');
});
