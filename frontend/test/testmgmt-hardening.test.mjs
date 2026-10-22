import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({ url: 'https://tenant.atlassian.net/test' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/bridge') return { url: 'tm-ui:bridge', shortCircuit: true };
    if (specifier.startsWith('@atlaskit/')) return { url: 'tm-ui:kit', shortCircuit: true };
    if (specifier.startsWith('.')) { const url = new URL(specifier, context.parentURL);
      for (const ext of ['.ts', '.tsx']) if (fs.existsSync(fileURLToPath(url) + ext)) return { url: url.href + ext, shortCircuit: true }; }
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === 'tm-ui:bridge') return { format: 'module', shortCircuit: true, source:
      `export const invoke=(...args)=>globalThis.tmTransport(...args); export const router={open:async()=>{}}; export const events={emit:async()=>{}};` };
    if (url === 'tm-ui:kit') return { format: 'module', shortCircuit: true, source:
      `import React from '${new URL('../node_modules/react/index.js', import.meta.url).href}'; export default function Kit({children}) { return React.createElement('div',{},children); }` };
    if (/\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'),
      { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    return next(url, context);
  }
});
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TestView } = await import('../src/testmgmt/TestView.tsx');
const { default: Admin } = await import('../src/admin/pages/TestManagementPage.tsx');
const { default: ExecutionView } = await import('../src/testmgmt/ExecutionView.tsx');
hooks.deregister();
let root, container;
async function mount(Component, props, transport = async () => ({})) {
  globalThis.tmTransport = (key, payload) => key === 'harness:logAction' ? { ok: true } : transport(key, payload);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(Component, props)));
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.ok(check(), 'The expected asynchronous UI result must settle.');
}
afterEach(async () => { if (root) await act(() => root.unmount()); container?.remove(); root = null; window.sessionStorage.clear(); });
const chain = { steps: [{ label: 'Review', role: 'QA', meaning: 'I approve the frozen definition' }], distinctSigners: true };
function model() { return { role: 'TEST', issue: { id: '11', key: 'VAT-11', summary: 'Test' }, parent: { id: '10', key: 'VAT-10' }, canEdit: true,
  draft: { objective: 'Draft objective B', preconditions: 'Draft prerequisite B', steps: [{ id: 'draft', action: 'Draft action B', data: '', expected: '' }], verifies: [], revision: 2 },
  versions: [{ versionId: '1'.repeat(32), versionNo: 1, state: 'PUBLISHED', digest: 'a'.repeat(64), publishedAt: Date.now(), content: {
    objective: 'Frozen objective A', preconditions: 'Frozen prerequisite A', steps: [{ id: 'frozen', action: 'Frozen action A', data: 'Frozen data A', expected: 'Frozen expected A' }]
  }, chain, signatures: [], nextStep: { ...chain.steps[0], index: 0 }, canSign: true }], runs: [] }; }
test('the signer can read every exact frozen field before the version sign control', async () => {
  await mount(TestView, { model: model(), onModel: () => {} });
  for (const value of ['Frozen objective A', 'Frozen prerequisite A', 'Frozen action A', 'Frozen data A', 'Frozen expected A']) {
    assert.ok(container.textContent.includes(value), `${value} must be readable`);
  }
  assert.ok(container.textContent.indexOf('Frozen expected A') < container.textContent.indexOf('I approve the frozen definition'));
});
test('signed and superseded versions retain readable complete definitions', async () => {
  const m = model(); m.versions[0].state = 'SUPERSEDED'; m.versions[0].canSign = false; m.versions[0].nextStep = null;
  await mount(TestView, { model: m, onModel: () => {} });
  assert.ok(container.textContent.includes('Frozen action A'));
});
test('frozen source baselines and dataset rows are readable before version sign-off', async () => {
  const m = model();
  m.versions[0].content.verifies = [{ issueId: '21', issueKey: 'VAT-21', sourceDigest: 'b'.repeat(64),
    baseline: { id: '2'.repeat(32), version: 4, hash: 'c'.repeat(64) } }];
  m.versions[0].content.dataset = { schema: 1, mode: 'ROWS', parameters: [{ name: 'voltage', type: 'TEXT' }],
    rows: [{ id: 'high', values: { voltage: 'Frozen 14 V' } }] };
  await mount(TestView, { model: m, onModel: () => {} });
  for (const value of ['VAT-21', 'baseline v4', 'Frozen 14 V', 'voltage', 'high']) assert.ok(container.textContent.includes(value), value);
});
test('draft edits save the dataset and expose dataset and source authoring controls', async () => {
  const m = model(); m.draft.dataset = { schema: 1, mode: 'ROWS', parameters: [{ name: 'voltage', type: 'TEXT' }], rows: [{ id: 'high', values: { voltage: '14 V' } }] };
  const calls = [];
  await mount(TestView, { model: m, onModel: () => {} }, async (key, payload) => { calls.push({ key, payload }); return m; });
  assert.ok(container.querySelector('section[aria-label="Test dataset"]'));
  assert.ok([...container.querySelectorAll('button')].some(b => b.textContent === 'Add source'));
  await act(() => { const el = container.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, 'Updated objective');
    el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Save draft').click()); await flush();
  assert.deepEqual(calls.find(call => call.key === 'tm:test:saveDraft').payload.draft.dataset, m.draft.dataset);
});
test('a settled-signature version exposes its finish operation', async () => {
  const m = model(); m.versions[0].canFinishVersion = true; m.versions[0].canSign = false; m.versions[0].nextStep = null;
  const calls = [];
  await mount(TestView, { model: m, onModel: () => {} }, async (key, payload) => { calls.push({ key, payload }); return m; });
  const finish = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Finish version'));
  assert.ok(finish); await act(() => finish.click()); await flush();
  assert.equal(calls[0].key, 'tm:test:finishVersion');
});

test('a signed version with protected native links explains the blocked projection and offers recovery', async () => {
  const m = model(); Object.assign(m.versions[0], { state: 'SIGNED', canSign: false, nextStep: null,
    canFinishVersion: true, sourceLinks: { state: 'BLOCKED', problem: 'SOURCE_LINK_POLICY_BLOCKED' } });
  const calls = [];
  await mount(TestView, { model: m, onModel: () => {} }, async (key, payload) => { calls.push({ key, payload }); return m; });
  assert.ok(container.textContent.includes('An approved Jira baseline protects these links'));
  assert.ok(!container.textContent.includes('Jira source links synchronized.'));
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Finish version').click()); await flush();
  assert.equal(calls[0].key, 'tm:test:finishVersion');
});
test('administrators have a concrete audited defect repair form', async () => {
  const data = { success: true, config: null, project: { style: 'classic', issueTypes: [] }, linkTypes: [], roles: [],
    defaults: { runChain: chain, versionChain: chain, linkTypeName: 'Relates' }, repairs: { items: [], complete: true } };
  await mount(Admin, { projects: [{ id: '100', name: 'Project', key: 'VAT' }] }, async () => data);
  await act(() => { const select = container.querySelector('select'); select.value = '100'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await flush();
  assert.ok(container.textContent.includes('Repair automatic bug'));
  assert.ok(container.querySelector('input[aria-label="Run ID"]'));
  assert.ok(container.querySelector('input[aria-label="Existing bug key"]'));
  assert.ok(container.querySelector('textarea[aria-label="Repair reason"]'));
});
test('repair submission carries the selected full run, existing bug and audit reason', async () => {
  const calls = [];
  const data = { success: true, config: null, project: { style: 'classic', issueTypes: [] }, linkTypes: [], roles: [],
    defaults: { runChain: chain, versionChain: chain, linkTypeName: 'Relates' },
    repairs: { items: [{ runId: '1'.repeat(32), issueKey: 'VAT-50', lastError: 'LINK_MISSING' }], complete: true } };
  await mount(Admin, { projects: [{ id: '100', name: 'Project', key: 'VAT' }] }, async (key, payload) => {
    calls.push({ key, payload }); return key === 'admin:tm:repairBug' ? { success: true } : data;
  });
  await act(() => { const select = container.querySelector('select'); select.value = '100'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await flush();
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent.includes('Select run')).click());
  await act(() => { const el = container.querySelector('textarea[aria-label="Repair reason"]');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, 'Checked Jira history');
    el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const record = [...container.querySelectorAll('button')].find(b => b.textContent === 'Record repair');
  assert.equal(record.disabled, false);
  await act(() => record.click()); await flush();
  assert.deepEqual(calls.find(call => call.key === 'admin:tm:repairBug').payload,
    { projectId: '100', runId: '1'.repeat(32), bugKey: 'VAT-50', reason: 'Checked Jira history' });
  assert.match(container.textContent, /Repair audited/);
});
function executionModel() { return { role: 'EXECUTION', issue: { id: '12', key: 'VAT-12', summary: 'Execution', done: true, status: 'Done' },
  parent: { id: '10', key: 'VAT-10' }, canEdit: false, releases: [], attachments: [], runChain: chain,
  runs: [{ runId: '1'.repeat(32), state: 'SIGNED', result: 'FAILED', revision: 1, test: { id: '11', key: 'VAT-11', hidden: false },
    version: { versionId: '2'.repeat(32), versionNo: 1, digest: 'a'.repeat(64) }, environment: '', configuration: '', release: null,
    retestOf: null, createdAt: Date.now(), steps: [{ id: 's1', position: 1, action: 'Action', data: '', expected: 'Expected', actual: '', comment: '', status: 'FAILED',
      evidence: [{ attachmentId: '50', filename: 'proof.txt', sha256: 'a'.repeat(64), size: 5 }], recordedBy: 'tester' }],
    preconditions: '', contentHash: 'b'.repeat(64), chain, signatures: [], notExecuted: null, nextStep: null, canSign: false,
    canFinish: true, bug: { state: 'INTENT', issueKey: null, lastError: 'CREATE_ANSWER_LOST' } }] }; }
test('uncertain bug wording never promises an automatic second create', async () => {
  await mount(ExecutionView, { model: executionModel(), onModel: () => {} });
  assert.doesNotMatch(container.textContent, /before it would create another/);
  assert.match(container.textContent, /never automatically creates another/);
});
test('a saved run evidence entry exposes a retained download action', async () => {
  await mount(ExecutionView, { model: executionModel(), onModel: () => {} });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Show steps').click());
  assert.ok([...container.querySelectorAll('button')].some(b => b.textContent.includes('Download retained evidence')));
});
test('frozen reusable preconditions and iteration values are readable before run sign-off', async () => {
  const m = executionModel(), run = m.runs[0]; run.state = 'SIGNING'; run.canSign = true; run.nextStep = { ...chain.steps[0], index: 0 };
  run.planningSnapshot = { plan: { issueId: '40', revisionNo: 3, digest: 'd'.repeat(64) }, required: true,
    preconditions: [{ issueId: '41', revisionNo: 2, digest: 'e'.repeat(64), text: 'Power safe before connecting' }] };
  run.iterations = [{ id: 'high', values: { voltage: '14 V' }, stepIds: ['s1'] }];
  await mount(ExecutionView, { model: m, onModel: () => {} });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Show steps').click());
  for (const text of ['Power safe before connecting', 'high', 'voltage', '14 V']) assert.ok(container.textContent.includes(text), text);
  assert.ok(container.textContent.indexOf('14 V') < container.textContent.indexOf('I approve the frozen definition'));
});
test('retained download sends only record identities and blocks mismatched bytes', async () => {
  const m = executionModel(); const calls = [];
  await mount(ExecutionView, { model: m, onModel: () => {} }, async (key, payload) => { calls.push({ key, payload });
    return { filename: 'proof.txt', mimeType: 'text/plain', sha256: 'a'.repeat(64), totalBytes: 5, offset: 0, nextOffset: 5, complete: true, dataBase64: 'aGVsbG8=' }; });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Show steps').click());
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Download retained evidence').click());
  await until(() => container.textContent.includes('failed its SHA-256 integrity check'));
  assert.equal(calls[0].key, 'tm:run:getEvidence');
  assert.deepEqual(calls[0].payload, { issueKey: 'VAT-12', runId: '1'.repeat(32), stepId: 's1', attachmentId: '50', offset: 0 });
  assert.match(container.textContent, /failed its SHA-256 integrity check/);
});
test('verified retained bytes produce a downloadable file with the saved filename', async () => {
  const m = executionModel(), sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  m.runs[0].steps[0].evidence[0].sha256 = sha256;
  const blobs = []; let filename;
  const oldCreate = URL.createObjectURL, oldClick = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:verified-proof'; };
  window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  try {
    await mount(ExecutionView, { model: m, onModel: () => {} }, async () => ({ filename: 'proof.txt', mimeType: 'text/plain', sha256,
      totalBytes: 5, offset: 0, nextOffset: 5, complete: true, dataBase64: 'aGVsbG8=' }));
    await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Show steps').click());
    await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Download retained evidence').click());
    await until(() => blobs.length === 1);
    assert.equal(filename, 'proof.txt'); assert.equal(blobs.length, 1); assert.equal(await blobs[0].text(), 'hello');
  } finally { URL.createObjectURL = oldCreate; window.HTMLAnchorElement.prototype.click = oldClick; }
});
test('single Add run retains its request and submitted context through uncertainty and remount', async () => {
  const m = executionModel(); m.issue.done = false; m.canEdit = true; m.runs = [];
  const calls = [];
  const transport = async (key, payload) => { calls.push({ key, payload }); if (calls.length === 1) throw new Error('lost answer'); return m; };
  await mount(ExecutionView, { model: m, onModel: () => {} }, transport);
  await act(() => { const el = container.querySelector('input[placeholder="e.g. VAT-11"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'VAT-11');
    el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Add run').click());
  assert.match(calls[0].payload.requestId ?? '', /^[0-9a-f]{32}$/);
  assert.equal(container.querySelector('input[placeholder="e.g. VAT-11"]').disabled, true);
  await act(() => root.unmount()); root = null; container.remove();
  await mount(ExecutionView, { model: m, onModel: () => {} }, transport);
  assert.equal(container.querySelector('input[placeholder="e.g. VAT-11"]').value, 'VAT-11');
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent.includes('Retry Add run')).click());
  assert.deepEqual(calls[0].payload, calls[1].payload);
  assert.equal(container.querySelector('input[placeholder="e.g. VAT-11"]').disabled, false);
  assert.equal(window.sessionStorage.getItem('va-tm-add-run:12'), null);
});

test('a confirmed Add run validation refusal lets the user correct the submitted form', async () => {
  const m = executionModel(); m.issue.done = false; m.canEdit = true; m.runs = [];
  await mount(ExecutionView, { model: m, onModel: () => {} }, async () => ({ error: 'No signed version', reason: 'NO_SIGNED_VERSION' }));
  await act(() => { const el = container.querySelector('input[placeholder="e.g. VAT-11"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'VAT-11');
    el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Add run').click());
  const input = container.querySelector('input[placeholder="e.g. VAT-11"]');
  assert.equal(input.disabled, false); assert.equal(input.value, 'VAT-11');
  assert.equal(window.sessionStorage.getItem('va-tm-add-run:12'), null);
});
test('a backend audit or persistence failure keeps the Add run retry identity', async () => {
  const m = executionModel(); m.issue.done = false; m.canEdit = true; m.runs = [];
  await mount(ExecutionView, { model: m, onModel: () => {} }, async () => ({ error: 'Audit unavailable', reason: 'LEDGER_UNAVAILABLE' }));
  await act(() => { const el = container.querySelector('input[placeholder="e.g. VAT-11"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'VAT-11');
    el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Add run').click());
  assert.equal(container.querySelector('input[placeholder="e.g. VAT-11"]').disabled, true);
  assert.ok(window.sessionStorage.getItem('va-tm-add-run:12'));
});
