import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request } from './admin-fixture.js';
import { getTestManagementConfig, saveTestManagementConfig } from '../src/usecases/testManagementAdmin.js';
import { DEFAULT_RUN_CHAIN, DEFAULT_VERSION_CHAIN } from '../src/testmgmt/chain.js';

for (const failingRead of ['readWorkflowForPair', 'lookupStatuses']) {
  test(`an enabled project's ${failingRead} outage keeps its configuration page available but still blocks saving`, async () => {
    const deps = fixture(); let saves = 0;
    const config = { projectId: '100', enabled: true, revision: 1, testTypeId: '1', executionTypeId: '2', defectTypeId: '3',
      linkTypeName: 'Relates', runChain: DEFAULT_RUN_CHAIN, versionChain: DEFAULT_VERSION_CHAIN };
    deps.lookupStatuses = async () => new Map([['2', { category: 'done' }]]);
    deps[failingRead] = async () => { throw new Error('Jira workflow service unavailable'); };
    deps.tm = {
      projectIssueTypes: async () => ({ style: 'classic', issueTypes: [{ id: '1', name: 'Test' }, { id: '2', name: 'Execution' }, { id: '3', name: 'Bug' }] }),
      readProject: async () => config, linkTypes: async () => [{ name: 'Relates' }],
      listProjectBugRepairs: async () => ({ items: [{ runId: 'a'.repeat(32), issueKey: null, lastError: 'CREATE_ABSENCE_UNPROVEN' }], complete: true }),
      createScreenFields: async () => new Set(['labels', 'parent']), issuesOfTypeWithParent: async () => ({ ids: [], complete: true }),
      saveProject: async () => { saves++; return true; }
    };
    const loaded = await getTestManagementConfig(request({ projectId: '100' }), deps);
    assert.equal(loaded.success, true, loaded.error); assert.deepEqual(loaded.config, config);
    assert.equal(loaded.workflowHealth.readable, false); assert.deepEqual(loaded.workflowHealth.missingDoneRoutes, []);
    assert.equal(loaded.repairs.items.length, 1);
    const saved = await saveTestManagementConfig(request({ ...config, expectedRevision: 1 }), deps);
    assert.equal(saved.success, false); assert.equal(saves, 0);
  });
}
