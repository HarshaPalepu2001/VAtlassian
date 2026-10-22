import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@forge/api') return { url: 'tm-hardening:forge', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'tm-hardening:forge') return { format: 'module', shortCircuit: true, source:
    `export const route=(parts,...args)=>parts.reduce((a,p,i)=>a+p+(args[i]??''),''); export default {asUser:()=>({requestJira:(...p)=>globalThis.tmJira('user',...p)}),asApp:()=>({requestJira:(...p)=>globalThis.tmJira('app',...p)})};` };
  return next(url, context);
} });
const jira = await import('../src/testmgmt/jira.js'); hooks.deregister();
const ok = data => ({ ok: true, status: 200, json: async () => data });
test('create metadata follows total even when Jira omits isLast', async () => {
  const calls = [];
  globalThis.tmJira = async (_actor, url) => { calls.push(url); return ok(calls.length === 1
    ? { total: 101, fields: Array.from({ length: 100 }, (_, i) => ({ fieldId: `field-${i}` })) }
    : { total: 101, fields: [{ fieldId: 'parent' }] }); };
  const fields = await jira.createScreenFields('100', '3');
  assert.equal(fields.size, 101); assert.equal(fields.has('parent'), true); assert.equal(calls.length, 2);
});
test('metadata that announces more fields and then stops fails closed', async () => {
  globalThis.tmJira = async () => ok({ total: 101, fields: [] });
  await assert.rejects(jira.createScreenFields('100', '3'));
});
test('Jira throttling preserves retry-after independently from unknown create results', async () => {
  globalThis.tmJira = async () => ({ ok: false, status: 429, headers: { get: key => key.toLowerCase() === 'retry-after' ? '3' : null } });
  await assert.rejects(jira.createIssueAsApp({}), e => e.status === 429 && e.retryAfterMs === 3_000);
});
test('required bug links reconcile idempotently and are read back before success', async () => {
  let postCount = 0; const links = [];
  globalThis.tmJira = async (_actor, _url, options) => {
    if (options?.method === 'POST') { postCount++; links.push({ type: { name: 'Relates' }, outwardIssue: { id: '11' } }); return ok({}); }
    return ok({ fields: { issuelinks: links } });
  };
  const link = { typeName: 'Relates', inwardId: '50', outwardId: '11' };
  await jira.linkIssueAsApp(link); await jira.linkIssueAsApp(link);
  assert.equal(postCount, 1);
});
test('a successful link write without a readable relationship fails closed', async () => {
  globalThis.tmJira = async (_actor, _url, options) => options?.method === 'POST' ? ok({}) : ok({ fields: { issuelinks: [] } });
  await assert.rejects(jira.linkIssueAsApp({ typeName: 'Relates', inwardId: '50', outwardId: '11' }));
});
