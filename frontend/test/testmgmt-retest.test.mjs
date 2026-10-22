import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({ url: 'https://tenant.atlassian.net/test' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@forge/bridge') return { url: 'retest-ui:bridge', shortCircuit: true };
  if (specifier.startsWith('@atlaskit/')) return { url: 'retest-ui:kit', shortCircuit: true };
  if (specifier.startsWith('.')) { const url = new URL(specifier, context.parentURL); for (const ext of ['.ts', '.tsx'])
    if (fs.existsSync(fileURLToPath(url) + ext)) return { url: url.href + ext, shortCircuit: true }; }
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'retest-ui:bridge') return { format: 'module', shortCircuit: true, source:
    `export const invoke=(...p)=>globalThis.retestTransport(...p); export const events={emit:async()=>{}}; export const router={open:async()=>{}};` };
  if (url === 'retest-ui:kit') return { format: 'module', shortCircuit: true, source:
    `import React from '${new URL('../node_modules/react/index.js', import.meta.url).href}';export default function Kit({children}){return React.createElement('div',{},children);}` };
  if (/\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'),
    { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
  return next(url, context);
} });
const { default: React, act } = await import('react'); const { createRoot } = await import('react-dom/client');
const { default: Controls } = await import('../src/testmgmt/RetestControls.tsx').catch(() => ({})); hooks.deregister();
let root, container;
const model = () => ({ issue: { key: 'VAT-12', done: true }, canEdit: true, runs: [
  { runId: '1'.repeat(32), state: 'SIGNED', result: 'FAILED', test: { key: 'VAT-21' }, version: { versionNo: 1 } },
  { runId: '2'.repeat(32), state: 'REJECTED', result: 'PASSED', test: { key: 'VAT-22' }, version: { versionNo: 2 } },
  { runId: '3'.repeat(32), state: 'NOT_EXECUTED', result: 'NOT_RUN', test: { key: 'VAT-23' }, version: { versionNo: 1 } },
  { runId: '4'.repeat(32), state: 'SIGNED', result: 'PASSED', test: { key: 'VAT-24' }, version: { versionNo: 1 } }
] });
async function mount(transport, m = model()) {
  assert.equal(typeof Controls, 'function', 'selective rerun controls must exist');
  globalThis.retestTransport = (key, p) => key === 'harness:logAction' ? { ok: true } : transport(key, p);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root.render(React.createElement(Controls, { model: m })));
}
const click = async text => { await act(() => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text)).click()); };
afterEach(async () => { if (root) await act(() => root.unmount()); container?.remove(); root = null; window.sessionStorage.clear(); });
test('selective rerun defaults select failed, rejected and not executed, leaving passed optional', async () => {
  await mount(async () => ({}));
  const selected = [...container.querySelectorAll('input[data-run-id]')].filter(el => el.checked).map(el => el.dataset.runId);
  assert.deepEqual(selected, ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
  assert.equal(container.querySelector('input[aria-label="Use latest signed versions"]').checked, false);
});
test('an uncertain response retries the same request without changing selected runs', async () => {
  const calls = [];
  await mount(async (key, payload) => { calls.push({ key, payload }); if (calls.length === 1) throw new Error('lost answer');
    return { requestId: payload.requestId, state: 'ADDING_RUNS', complete: false, execution: { id: '1000', key: 'VAT-1000' }, createdRuns: 1, totalRuns: 3 }; });
  await click('Create rerun'); await click('Retry rerun');
  assert.equal(calls[0].key, 'tm:exec:retest'); assert.equal(calls[0].payload.requestId, calls[1].payload.requestId);
  assert.deepEqual(calls[0].payload.runIds, calls[1].payload.runIds);
  assert.match(container.textContent, /VAT-1000/); assert.ok(container.querySelector('a[href="/browse/VAT-1000"]'));
});
test('unknown creates explicitly show administrator repair without offering a second create', async () => {
  await mount(async (_key, payload) => ({ requestId: payload.requestId, state: 'NEEDS_REPAIR', complete: false,
    execution: null, createdRuns: 0, totalRuns: 3, problem: 'CREATE_ABSENCE_OR_IDENTITY_UNPROVEN' }));
  await click('Create rerun'); assert.match(container.textContent, /administrator/i);
  assert.equal([...container.querySelectorAll('button')].some(b => b.textContent.includes('Create rerun')), false);
});

test('a definite Jira refusal permits a fresh selection while preserving the refused request', async () => {
  const requests = [];
  await mount(async (_key, payload) => { requests.push(payload.requestId); return { requestId: payload.requestId,
    state: 'NEEDS_REPAIR', complete: false, execution: null, createdRuns: 0, totalRuns: 3, problem: 'JIRA_REFUSED_403' }; });
  await click('Create rerun'); await click('Start another selection'); await click('Create rerun');
  assert.equal(requests.length, 2); assert.notEqual(requests[0], requests[1]);
});
