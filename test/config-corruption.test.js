import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { withRequestCache } from '../src/lib/cache.js';

// Keep configStore, the SQL adapter, runtime loading and the validator real.
// Only Forge's external transports are replaced with table/Jira fixtures.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/sql') return { url: 'config-corruption:sql', shortCircuit: true };
    if (specifier === '@forge/api') return { url: 'config-corruption:api', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'config-corruption:sql') return {
      format: 'module', shortCircuit: true,
      source: `export const sql = { prepare(statement) { return {
        bindParams(...params) { return {
          execute: async () => globalThis.vaConfigQuery(statement, params)
        }; }
      }; } };`
    };
    if (url === 'config-corruption:api') return {
      format: 'module', shortCircuit: true,
      source: `export const route = (s, ...v) => s.reduce((a, b, i) => a + b + (i < v.length ? encodeURIComponent(String(v[i])) : ''), '');
        const client = { requestJira: async path => globalThis.vaConfigJira(path) };
        export default { asApp: () => client, asUser: () => client };`
    };
    return next(url, context);
  }
});
const { getConfig, projectConfig, readConfigRecord } = await import('../src/db/configStore.js');
const { createGate } = await import('../src/gate.js');
const { gateRuntime } = await import('../src/lib/approval/runtime.js');
// gateRuntime performs lazy imports, so keep transport hooks active in this process.

function table(records = {}) {
  globalThis.vaConfigQuery = async (statement, params) => {
    if (/FROM va_config\b/.test(statement)) {
      assert.match(statement, /cfg_key (?:IN \(\?, \?\)|= \?)/);
      return { rows: params.filter(key => Object.hasOwn(records, key))
        .map(key => ({ cfg_key: key, cfg_value: records[key] })), metadata: {} };
    }
    assert.match(statement, /^\s*SELECT\b/);
    return { rows: [], metadata: {} };
  };
  globalThis.vaConfigJira = async path => {
    assert.match(String(path), /\/rest\/api\/3\/issue\/T-1\?fields=/);
    return { ok: true, json: async () => ({ id: '101', key: 'T-1', fields: {
      project: { id: '1' }, issuetype: { id: '10001' }, status: { id: '3' }, summary: 'Governed record'
    } }) };
  };
}
const read = () => withRequestCache(() => projectConfig(1));
const invalidSaved = error => {
  assert.equal(error.reason, 'CONFIGURATION_INVALID');
  assert.match(error.message, /saved|configuration|settings/i);
  assert.match(error.message, /administrator/i);
  assert.match(error.message, /repair|correct|fix/i);
  assert.doesNotMatch(error.message, /secret-value|SyntaxError|Unexpected token/);
  return true;
};

for (const key of ['site', 'project:1']) {
  test(`malformed ${key} configuration refuses instead of silently applying defaults`, async () => {
    table({ [key]: '{"secret-value":' });
    await assert.rejects(read, invalidSaved);
  });
  for (const value of ['null', 'false', '7', '"secret-value"', '[]']) {
    test(`saved ${key} ${value} is an invalid governed configuration shape`, async () => {
      table({ [key]: value });
      await assert.rejects(read, invalidSaved);
    });
  }
}

for (const config of [
  { enabled: 'false' }, { enabled: null },
  { ai: null }, { ai: false }, { ai: [] }, { ai: { enabled: 'false' } },
  { ai: { models: [] } }, { ai: { maxCompletionTokens: '1024' } },
  { restore: null }, { restore: [] }, { restore: { actAs: 'secret-value' } },
  { restore: { notifyUsers: 'false' } }, { restore: { perFieldRetries: -1 } },
  { policy: [] }, { policy: { mode: false } },
  { vault: false }, { vault: { lockAttachmentDeletion: 'true' } }
]) {
  test(`invalid saved setting types refuse: ${JSON.stringify(config)}`, async () => {
    // An overriding valid project record cannot hide corrupt site controls.
    table({ site: JSON.stringify(config), 'project:1': '{"enabled":false}' });
    await assert.rejects(read, invalidSaved);
  });
}

test('missing site and project records alone use documented defaults', async () => {
  table();
  const config = await read();
  assert.equal(config.enabled, true);
  assert.equal(config.ai.enabled, true);
  assert.equal(config.restore.actAs, 'app');
  assert.equal(config.restore.notifyUsers, false);
});

test('valid merged settings retain explicit false values and user restore identity', async () => {
  table({ site: JSON.stringify({ enabled: false, ai: { enabled: false, maxCompletionTokens: 1024 },
    restore: { actAs: 'user', notifyUsers: true, perFieldRetries: 3 } }),
    'project:1': JSON.stringify({ ai: { maxCompletionTokens: 2048 }, restore: { notifyUsers: false } }) });
  const config = await read();
  assert.equal(config.enabled, false);
  assert.equal(config.ai.enabled, false);
  assert.equal(config.ai.maxCompletionTokens, 2048);
  assert.deepEqual(config.restore, { actAs: 'user', notifyUsers: false, perFieldRetries: 3 });
});

test('explicit project false controls override enabled site defaults', async () => {
  table({ site: '{"enabled":true,"ai":{"enabled":true},"restore":{"actAs":"app"}}',
    'project:1': '{"enabled":false,"ai":{"enabled":false},"restore":{"actAs":"user"}}' });
  const config = await read();
  assert.equal(config.enabled, false);
  assert.equal(config.ai.enabled, false);
  assert.equal(config.restore.actAs, 'user');
});

test('legacy STRICT remains readable without changing save-time support', async () => {
  table({ site: '{"policy":{"mode":"STRICT"}}' });
  assert.equal((await read()).policy.mode, 'STRICT');
  assert.equal((await readConfigRecord('site')).config.policy.mode, 'STRICT');
});

test('valid retired settings do not prevent reads of active legacy controls', async () => {
  table({ site: JSON.stringify({ enabled: false, visibility: 'ALL', notifications: { digest: true },
    reviewStatusIds: ['3'], queueThreshold: 3, restore: { commentOnRestore: true, actAs: 'user' } }) });
  const config = await read();
  assert.equal(config.enabled, false);
  assert.equal(config.restore.actAs, 'user');
  assert.equal(Object.hasOwn(config, 'visibility'), false);
  assert.equal(Object.hasOwn(config.restore, 'commentOnRestore'), false);
});

test('generic config fallback applies only to an absent row', async () => {
  table({ generic: '{"secret-value":' });
  await assert.rejects(() => withRequestCache(() => getConfig('generic', 'fallback')), invalidSaved);
  assert.equal(await withRequestCache(() => getConfig('missing', 'fallback')), 'fallback');
});

for (const value of [false, 0, 'value', null, ['one', 'two'], { anyGenericKey: 1 }]) {
  test(`generic config preserves valid JSON ${JSON.stringify(value)}`, async () => {
    table({ generic: JSON.stringify(value) });
    assert.deepEqual(await withRequestCache(() => getConfig('generic', 'fallback')), value);
  });
}

test('administrative corruption errors are actionable and contain no saved content', async () => {
  for (const value of ['{"secret-value":', 'null', '{"enabled":"secret-value"}']) {
    table({ site: value });
    await assert.rejects(() => readConfigRecord('site'), invalidSaved);
  }
});

for (const records of [{ site: '{"secret-value":' }, { 'project:1': '[]' }]) {
  test(`real runtime gate refuses saved corruption: ${Object.keys(records)[0]}`, async () => {
    table(records);
    const audits = [];
    const gate = createGate({ ...await gateRuntime(), audit: async event => audits.push(event), log: () => {} });
    const verdict = await withRequestCache(() => gate({ issue: { key: 'T-1' },
      transition: { id: '31', from: { id: '3' }, to: { id: '4' } } }));
    assert.equal(verdict.result, false);
    assert.match(verdict.errorMessage, /administrator/i);
    assert.match(verdict.errorMessage, /repair|correct|fix/i);
    assert.doesNotMatch(verdict.errorMessage, /secret-value/);
    assert.equal(audits.at(-1).payload.reason, 'CONFIGURATION_INVALID');
    assert.equal(audits.at(-1).eventType, 'TRANSITION_BLOCKED');
  });
}

test('real runtime gate still permits an uncontrolled edge with absent settings', async () => {
  table();
  const audits = [];
  const gate = createGate({ ...await gateRuntime(), audit: async event => audits.push(event), log: () => {} });
  const verdict = await withRequestCache(() => gate({ issue: { key: 'T-1' },
    transition: { id: '31', from: { id: '3' }, to: { id: '4' } } }));
  assert.deepEqual(verdict, { result: true });
  assert.equal(audits.length, 0);
});
