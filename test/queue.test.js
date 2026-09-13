import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const BUG_TYPE = '10004';
const SUBTASK_TYPE = '10005';

const modules = {
  'usecases/panelAccess.js': ['actorFrom', 'respond', 'fail'],
  'lib/reviewer.js': ['grantsFor'],
  'db/configStore.js': ['controlledFields', 'projectConfig', 'gateActiveOutOf', 'gatedReviewStatuses', 'gatedTransition',
    'listGatedTransitions', 'declaredFieldRows', 'seedControlledFields', 'countControlledFields'],
  'db/itemStateStore.js': ['driftedInProjects', 'reviewsByIds'],
  'db/baselineStore.js': ['activeBaseline'],
  'lib/transitions.js': ['availableTransitions']
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier);
  },
  load(url, context, next) {
    if (url === 'fixture:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({requestJira: (...a) => globalThis.vaQueue.request(...a)}) };` };
    const names = modules[url.slice(8)];
    if (url === 'fixture:usecases/panelAccess.js') return { format: 'module', shortCircuit: true, source: `
      export function actorFrom(context) { if (!context?.accountId) throw new Error('AUTHENTICATION_REQUIRED'); return { accountId: context.accountId }; }
      export async function respond(fn) { try { return await fn(); } catch (e) { return { error: e.message }; } }
      export function fail(reason) { throw new Error(reason); }` };
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaQueue.${n}(...a);`).join('\n') };
    return next(url, context);
  }
});
const { list } = await import('../src/usecases/queue.js');
hooks.deregister();

const response = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
const issue = ({ id, key, issueTypeId }) => ({
  id, key,
  fields: {
    summary: `${key} summary`,
    status: { id: '3', name: 'Backlog' },
    project: { id: '10001' },
    issuetype: { id: issueTypeId }
  }
});

test('My approvals includes wildcard controlled bug transitions and excludes unconfigured subtasks', async () => {
  const calls = [];
  const bug = issue({ id: '7', key: 'VJIRA-7', issueTypeId: BUG_TYPE });
  const subtask = issue({ id: '8', key: 'VJIRA-8', issueTypeId: SUBTASK_TYPE });
  globalThis.vaQueue = {
    grantsFor: async () => [{ account_id: 'actor-1', project_id: '10001', issue_type_id: '*', role: 'SDE-1', state: 'ACTIVE' }],
    controlledFields: async () => [],
    projectConfig: async () => ({ enabled: true }),
    gateActiveOutOf: async () => ({ gated: false }),
    listGatedTransitions: async () => [],
    declaredFieldRows: async () => [],
    seedControlledFields: async () => {},
    countControlledFields: async () => 0,
    gatedReviewStatuses: async () => [{
      projectId: 10001,
      issueTypeId: BUG_TYPE,
      statusId: '*',
      toStatusId: '5',
      role: 'SDE-1'
    }],
    driftedInProjects: async () => [],
    reviewsByIds: async () => [],
    availableTransitions: async (api, issueKey) => issueKey === 'VJIRA-7'
      ? [{ id: '101', name: 'Done', toStatusId: '5', toStatusName: 'Done' }]
      : [{ id: '102', name: 'Done', toStatusId: '5', toStatusName: 'Done' }],
    gatedTransition: async ({ issueTypeId, toStatusId }) => issueTypeId === BUG_TYPE && toStatusId === '5'
      ? { required_role: 'SDE-1', required_assurance: 'BIOMETRIC', meaning: 'Bug done', matched_any_status: true }
      : null,
    request: async (url, options) => {
      calls.push(JSON.parse(options.body).jql);
      return response({ issues: [bug, subtask], nextPageToken: null });
    }
  };

  const result = await list({ payload: {}, context: { accountId: 'actor-1' } });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].issueKey, 'VJIRA-7');
  assert.equal(result.items[0].transitionName, 'Done');
  assert.match(calls[0], /issuetype = 10004/);
});

/**
 * A signed item carries its drift wherever it goes.
 *
 * The status it sits in after approval is, by definition, the one the approval
 * MOVED it to — so asking "is this person an approver OUT OF the status it is
 * in now" asks about an edge that has already been travelled, and answers no
 * for exactly the items that have a decision outstanding. driftedInProjects had
 * already found the row and put it in the search; the authority filter then
 * threw it away, so the reviewer was never told the change existed.
 */
test('My approvals lists drift on a signed item whose current status is not a gated from-status', async () => {
  const drifted = issue({ id: '1', key: 'VJIRA-1', issueTypeId: BUG_TYPE });
  drifted.fields.status = { id: '5', name: 'Backlog' };
  globalThis.vaQueue = {
    grantsFor: async () => [{ account_id: 'actor-1', project_id: '10001', issue_type_id: '*', role: 'SDE-1', state: 'ACTIVE' }],
    controlledFields: async () => [],
    projectConfig: async () => ({ enabled: true }),
    gateActiveOutOf: async () => ({ gated: false }),
    listGatedTransitions: async () => [],
    declaredFieldRows: async () => [],
    seedControlledFields: async () => {},
    countControlledFields: async () => 0,
    // The only rule fires out of In-Review (3). The item is past it, in 5.
    gatedReviewStatuses: async () => [{
      projectId: 10001, issueTypeId: BUG_TYPE, statusId: '3', toStatusId: '5', role: 'SDE-1'
    }],
    driftedInProjects: async () => [{ issue_id: 1, state: 'DRIFTED', baseline_version: 2,
      drift_count: 1, drifted_field_count: 1, max_materiality: 'CRITICAL', last_drift_at: 1 }],
    reviewsByIds: async () => [{ issue_id: 1, state: 'DRIFTED', baseline_version: 2,
      drift_count: 1, drifted_field_count: 1, max_materiality: 'CRITICAL', last_drift_at: 1 }],
    // The baseline records the edge it was captured on: 3 -> 5.
    activeBaseline: async () => ({ issue_id: 1, version: 2, from_status_id: '3', to_status_id: '5' }),
    // Nothing is gated out of where it stands now.
    availableTransitions: async () => [{ id: '103', name: 'Reopen', toStatusId: '3', toStatusName: 'In-Review' }],
    gatedTransition: async ({ fromStatusId, toStatusId }) =>
      String(fromStatusId) === '3' && String(toStatusId) === '5'
        ? { required_role: 'SDE-1', required_assurance: 'ESIGNATURE', meaning: 'Bug done' }
        : null,
    request: async () => response({ issues: [drifted], nextPageToken: null })
  };

  const result = await list({ payload: {}, context: { accountId: 'actor-1' } });

  assert.equal(result.items.length, 1, 'the reviewer must be told the change exists');
  assert.equal(result.items[0].issueKey, 'VJIRA-1');
  assert.equal(result.items[0].driftCount, 1);
  assert.equal(result.items[0].materialCount, 1);
  assert.equal(result.items[0].state, 'DRIFTED');
});

test('drift is not offered to somebody who lacks the role the baseline edge requires', async () => {
  const drifted = issue({ id: '1', key: 'VJIRA-1', issueTypeId: BUG_TYPE });
  drifted.fields.status = { id: '5', name: 'Backlog' };
  globalThis.vaQueue = {
    // Holds SDE-2, but the rule the baseline was signed under needs SDE-1.
    grantsFor: async () => [{ account_id: 'actor-1', project_id: '10001', issue_type_id: '*', role: 'SDE-2', state: 'ACTIVE' }],
    controlledFields: async () => [],
    projectConfig: async () => ({ enabled: true }),
    gateActiveOutOf: async () => ({ gated: false }),
    listGatedTransitions: async () => [],
    declaredFieldRows: async () => [],
    seedControlledFields: async () => {},
    countControlledFields: async () => 0,
    gatedReviewStatuses: async () => [{
      projectId: 10001, issueTypeId: BUG_TYPE, statusId: '3', toStatusId: '5', role: 'SDE-2'
    }],
    driftedInProjects: async () => [{ issue_id: 1, state: 'DRIFTED', baseline_version: 2, drift_count: 1 }],
    reviewsByIds: async () => [{ issue_id: 1, state: 'DRIFTED', baseline_version: 2, drift_count: 1 }],
    activeBaseline: async () => ({ issue_id: 1, version: 2, from_status_id: '3', to_status_id: '5' }),
    availableTransitions: async () => [],
    gatedTransition: async () => ({ required_role: 'SDE-1', required_assurance: 'ESIGNATURE', meaning: 'Bug done' }),
    request: async () => response({ issues: [drifted], nextPageToken: null })
  };

  const result = await list({ payload: {}, context: { accountId: 'actor-1' } });

  assert.equal(result.items.length, 0, 'authority still comes from the gate, not from holding any role');
});
