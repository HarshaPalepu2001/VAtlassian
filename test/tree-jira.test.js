import test from 'node:test';
import assert from 'node:assert';
import { createTreeReader } from '../src/lib/tree/jira.js';

function sixteenFieldIds() {
  return Array.from({ length: 16 }, (_, i) => `field_${i}`);
}

test('reader walks every parent level', async () => {
  const api = {
    asApp: () => ({
      requestJira: async (route, options) => {
        const dummyFields = {
          ...Object.fromEntries(sixteenFieldIds().map(f => [f, 'value'])),
          project: { id: '10' }, issuetype: { id: '20' }, status: { id: '30' }
        };
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

test('reader always requests identity, structure, and status fields needed by capture and verification', async () => {
  const calls = [];
  const fields = { summary: 'Root', project: { id: '10' }, issuetype: { id: '20' }, status: { id: '30' }, parent: null };
  const api = { asApp: () => ({ requestJira: async (request, options) => {
    calls.push({ request: String(request), body: options?.body ? JSON.parse(options.body) : null });
    return request.path.includes('/issue/')
      ? { status: 200, json: async () => ({ id: '1', key: 'ROOT-1', fields }) }
      : { status: 200, json: async () => ({ issues: [] }) };
  } }) };
  const route = (strings, ...values) => {
    const path = strings.reduce((out, part, index) => out + part + encodeURIComponent(values[index] ?? ''), '').replace(/undefined$/, '');
    return { path, toString: () => path };
  };

  await createTreeReader({ api, route }).read('ROOT-1', ['summary']);
  for (const required of ['summary', 'project', 'issuetype', 'status', 'parent']) {
    assert.match(calls[0].request, new RegExp(required));
    assert.ok(calls[1].body.fields.includes(required));
  }
});

test('reader fails closed instead of truncating a tree above 500 nodes', async () => {
  const fieldIds = ['summary', 'project', 'issuetype', 'status', 'parent'];
  const root = {
    id: '1', key: 'ROOT-1',
    fields: {
      summary: 'Root', project: { id: '10' }, issuetype: { id: '20' },
      status: { id: '30' }, parent: null
    }
  };
  const children = Array.from({ length: 500 }, (_, index) => ({
    id: String(index + 2), key: `CHILD-${index + 1}`,
    fields: {
      summary: `Child ${index + 1}`, project: { id: '10' }, issuetype: { id: '20' },
      status: { id: '30' }, parent: { id: '1' }
    }
  }));
  const api = {
    asApp: () => ({
      requestJira: async (request, options) => {
        if (request.path.includes('/issue/ROOT-1')) {
          return { status: 200, json: async () => root };
        }
        const body = JSON.parse(options.body);
        return {
          status: 200,
          json: async () => ({ issues: body.jql === 'parent IN ("ROOT-1")' ? children : [] })
        };
      }
    })
  };
  const route = (strings, ...values) => {
    let path = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      path += encodeURIComponent(values[index]) + strings[index + 1];
    }
    return { path, toString: () => path };
  };

  const reader = createTreeReader({ api, route });
  await assert.rejects(
    () => reader.read('ROOT-1', fieldIds),
    error => error.reason === 'TREE_LIMIT_EXCEEDED'
  );
});

test('createTreeReader handles omitted parent field on top-level root issue and child issues', async () => {
  const dummyFields = {
    project: { id: '10' },
    issuetype: { id: '20' },
    status: { id: '30' },
    summary: 'Root issue without parent'
    // Notice: 'parent' property is completely absent, as in Jira REST API v3
  };

  const api = {
    asApp: () => ({
      requestJira: async (route) => {
        if (route.path.includes('/issue/ROOT-1')) {
          return { status: 200, json: async () => ({ id: '100', key: 'ROOT-1', fields: dummyFields }) };
        }
        if (route.path.includes('/search/jql')) {
          return { status: 200, json: async () => ({ issues: [] }) };
        }
        throw new Error(`Unexpected request: ${route.path}`);
      }
    })
  };

  const route = (strings, ...values) => {
    const path = strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '');
    return { path, toString: () => path };
  };

  const reader = createTreeReader({ api, route });
  const tree = await reader.read('ROOT-1', ['summary']);

  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0].key, 'ROOT-1');
  assert.equal(tree.nodes[0].fields.parent, null, 'Omitted parent should be normalized to null');
});
