import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const requests = [];
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:forge-api', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:forge-api') {
      return {
        format: 'module', shortCircuit: true,
        source: `
          export const route = (strings, ...values) => strings.reduce((path, part, index) => path + part + (values[index] ?? ''), '');
          const response = body => ({ ok: true, json: async () => body });
          export default {
            asApp: () => ({ requestJira: async url => {
              globalThis.vaDiagnostics.requests.push(String(url));
              return String(url).includes('/editmeta')
                ? response({ fields: { summary: {} } })
                : response({ issues: [{ id: '10001' }] });
            }}),
            asUser: () => ({ requestJira: async url => {
              globalThis.vaDiagnostics.requests.push(String(url));
              return response({ fields: { summary: {} } });
            }})
          };
        `
      };
    }
    return next(url, context);
  }
});

globalThis.vaDiagnostics = { requests };
const { checkWriteIdentity } = await import('../src/usecases/diagnostics.js');
hooks.deregister();

test('write-identity diagnostics uses the supported Jira JQL search route', async () => {
  const result = await checkWriteIdentity();

  assert.deepEqual(result, { canEdit: true, issueId: '10001' });
  assert.equal(requests[0], '/rest/api/3/search/jql?jql=order%20by%20created%20DESC&maxResults=1');
});
