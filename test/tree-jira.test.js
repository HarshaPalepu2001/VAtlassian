import test from 'node:test';
import assert from 'node:assert';
import { createTreeReader } from '../src/lib/tree/jira.js';

function sixteenFieldIds() {
  return Array.from({ length: 16 }, (_, i) => `field_${i}`);
}

test('reader walks every parent level and stops at 500 nodes', async () => {
  const api = {
    asApp: () => ({
      requestJira: async (route, options) => {
        const dummyFields = Object.fromEntries(sixteenFieldIds().map(f => [f, 'value']));
        if (route.path.includes('/issue/FEAT-1')) {
          return { status: 200, json: async () => ({ id: '10001', key: 'FEAT-1', fields: { parent: null, ...dummyFields } }) };
        }
        if (route.path.includes('/search/jql') && options && options.body) {
          const body = JSON.parse(options.body);
          if (body.jql === 'parent IN ("FEAT-1")') {
            return {
              status: 200,
              json: async () => ({
                issues: [{ id: '10002', key: 'STORY-1', fields: { parent: { id: '10001', key: 'FEAT-1' }, ...dummyFields } }]
              })
            };
          }
          if (body.jql === 'parent IN ("STORY-1")') {
            return {
              status: 200,
              json: async () => ({
                issues: [{ id: '10003', key: 'SUB-1', fields: { parent: { id: '10002', key: 'STORY-1' }, ...dummyFields } }]
              })
            };
          }
          if (body.jql === 'parent IN ("SUB-1")') {
            return { status: 200, json: async () => ({ issues: [] }) };
          }
        }
        throw new Error('Unexpected request');
      }
    })
  };

  const route = (strings, ...values) => {
    let path = strings[0];
    for (let i = 0; i < values.length; i++) {
      path += encodeURIComponent(values[i]) + strings[i + 1];
    }
    return { path, toString: () => path };
  };

  const reader = createTreeReader({ api, route });
  const tree = await reader.read('FEAT-1', sixteenFieldIds());
  assert.deepEqual(tree.nodes.map(node => node.key), ['FEAT-1', 'STORY-1', 'SUB-1']);
});
