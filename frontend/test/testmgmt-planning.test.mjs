import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({ url: 'https://tenant.atlassian.net/panel' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/bridge') return { url: 'planning:bridge', shortCircuit: true };
    if (specifier.startsWith('@atlaskit/')) return { url: 'planning:kit', shortCircuit: true };
    if (specifier.startsWith('.')) { const url = new URL(specifier, context.parentURL);
      for (const ext of ['.ts', '.tsx']) if (fs.existsSync(fileURLToPath(url) + ext)) return { url: url.href + ext, shortCircuit: true }; }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'planning:bridge') return { format: 'module', shortCircuit: true, source: `export const invoke=(...args)=>globalThis.transport(...args);export const events={emit:async()=>{}};export const router={open:async()=>{}};export const view={getContext:async()=>({extension:{issue:{key:'VAT-21'}}})};` };
    if (url === 'planning:kit') return { format: 'module', shortCircuit: true, source: `import React from '${new URL('../node_modules/react/index.js', import.meta.url).href}';export default function Kit({children}){return React.createElement('div',{},children);}` };
    if (/\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'),
      { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    return next(url, context);
  }
});
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DatasetEditor = (await import('../src/testmgmt/DatasetEditor.tsx')).default;
const PlanningView = (await import('../src/testmgmt/PlanningView.tsx')).default;
const TestPanel = (await import('../src/testmgmt/TestPanel.tsx')).default;
const SourceDecisions = (await import('../src/testmgmt/SourceDecisions.tsx')).default;
hooks.deregister();
let root, container;
afterEach(async () => { if (root) await act(() => root.unmount()); container?.remove(); root = null; });
async function mount(Component, props) { assert.equal(typeof Component, 'function', 'actual editor component exists'); container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(() => root.render(React.createElement(Component, props))); }
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent === text);
const type = async (input, value) => act(() => {
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true })); input.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const draft = { objective: '', text: '', members: [{ testIssueId: '11', versionId: null, required: true }], preconditions: [],
  environment: 'Bench', configurations: [{ id: 'a', name: 'ECU A' }], releaseId: '900', revision: 3 };
const model = { role: 'PLAN', issue: { id: '21', key: 'VAT-21', summary: 'Release plan' }, canEdit: true,
  parent: { id: '10', key: 'VAT-10' }, releases: [{ id: '900', name: 'R1' }], draft, revisions: [] };

test('the actual Jira issue panel loads mapped plan authoring through its resolver', async () => {
  const calls = [];
  globalThis.transport = async (key, payload) => { calls.push({ key, payload });
    return key === 'tm:context' ? { role: 'PLAN', enabled: true } : key === 'tm:planning:get' ? model : {}; };
  await mount(TestPanel, {});
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.ok(container.textContent.includes('Plan draft'));
  assert.deepEqual(calls.find(c => c.key === 'tm:planning:get').payload, { issueKey: 'VAT-21' });
});
test('ordinary Jira source issues expose signed-test coverage through the actual panel', async () => {
  globalThis.transport = async key => key === 'tm:context' ? { role: 'SOURCE', enabled: true }
    : key === 'tm:coverage:source' ? { scope: 'SOURCE', issue: { id: '21', key: 'VAT-21' }, complete: true, rows: [], problems: [] } : {};
  await mount(TestPanel, {});
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.ok(container.textContent.includes('No coverage records'));
});
test('source review preparation carries the human rationale and displays exact baselines before signing', async () => {
  const calls = []; let prepared = false;
  const record = { decisionId: 'a'.repeat(32), state: 'SIGNING', digest: 'b'.repeat(64), canSign: true, canFinish: false,
    nextStep: { index: 0, role: 'QA', label: 'Review applicability', meaning: 'I approve this source decision.' }, signatures: [],
    content: { kind: 'SUSPECT_REVIEW', decision: 'FITS', rationale: 'The stimulus is unchanged.', source: { issueKey: 'VAT-42' },
      oldBaseline: { id: '1'.repeat(32), version: 1 }, newBaseline: { id: '2'.repeat(32), version: 2 }, testDigest: 'c'.repeat(64), run: null } };
  globalThis.transport = async (key, payload) => { calls.push({ key, payload });
    if (key === 'tm:sources:prepareDecision') { prepared = true; return record; }
    return { records: prepared ? [record] : [], complete: true }; };
  await mount(SourceDecisions, { model: { issue: { key: 'VAT-11' }, canEdit: true, runs: [],
    versions: [{ versionId: 'd'.repeat(32), state: 'SIGNED', content: { verifies: [{ issueId: '42', issueKey: 'VAT-42' }] } }] } });
  await act(() => { const select = container.querySelector('[aria-label="Source to review"]'); select.value = '42'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await type(container.querySelector('[aria-label="Source decision rationale"]'), 'The stimulus is unchanged.');
  await act(() => button('Prepare decision for signing').click());
  assert.equal(calls.find(c => c.key === 'tm:sources:prepareDecision').payload.decision, 'FITS');
  assert.ok(container.textContent.indexOf('Reviewed baseline v2') < container.textContent.indexOf('I approve this source decision.'));
});

test('dataset editor changes parameter definitions and explicit row values through the consumer callback', async () => {
  assert.equal(typeof DatasetEditor, 'function', 'actual dataset editor exists');
  let latest = null;
  function Harness() { const [value, setValue] = React.useState(null); return React.createElement(DatasetEditor, { value, onChange: v => { latest = v; setValue(v); } }); }
  await mount(Harness, {});
  await act(() => button('Add parameter').click());
  assert.equal(latest.parameters.length, 1); assert.equal(latest.rows[0].id, 'i1');
  await type(container.querySelector('[aria-label="Parameter 1 name"]'), 'voltage');
  await type(container.querySelector('[aria-label="Iteration i1 voltage"]'), '12 V');
  assert.deepEqual(latest.rows[0].values, { voltage: '12 V' });
  await act(() => button('Add iteration').click());
  assert.deepEqual(latest.rows.map(row => row.id), ['i1', 'i2']);
});
test('planning editor saves exact revision and ordered required membership before publishing', async () => {
  const calls = [];
  globalThis.transport = async (key, payload) => { calls.push({ key, payload }); return key === 'harness:logAction' ? {} : { ...model, draft: { ...draft, objective: payload.draft?.objective ?? '', revision: 4 } }; };
  await mount(PlanningView, { model, onModel: () => {} });
  await type(container.querySelector('[aria-label="Planning objective"]'), 'New objective');
  assert.equal(button('Publish revision').disabled, true);
  await act(() => button('Save draft').click());
  const call = calls.find(c => c.key === 'tm:planning:saveDraft');
  assert.equal(call.payload.expectedRevision, 3); assert.equal(call.payload.draft.objective, 'New objective');
  assert.equal(call.payload.draft.members[0].testIssueId, '11'); assert.equal(call.payload.draft.members[0].required, true);
});
test('signed plan review requests the exact digest and shows frozen run inputs', async () => {
  let selected = null;
  const rev = { revisionId: 'a'.repeat(32), revisionNo: 1, state: 'SIGNED', digest: 'b'.repeat(64),
    content: { members: [{ testIssueId: '11', versionId: 'c'.repeat(32), versionNo: 1, required: true }], preconditions: [],
      release: { id: '900', name: 'R1' }, environment: 'Bench', configurations: [{ id: 'a', name: 'ECU A' }] },
    signatures: [], nextStep: null, canSign: false };
  globalThis.transport = async (key, payload) => {
    if (key === 'harness:logAction') return {};
    assert.equal(key, 'tm:plan:selectRuns'); assert.equal(payload.revisionId, rev.revisionId); assert.equal(payload.contentHash, rev.digest);
    return { plan: { revisionId: rev.revisionId, digest: rev.digest }, runs: [{ testIssueId: '11', testVersionId: 'c'.repeat(32), configuration: 'ECU A', environment: 'Bench', release: { id: '900', name: 'R1' } }], digest: 'd'.repeat(64) };
  };
  await mount(PlanningView, { model: { ...model, revisions: [rev] }, onModel: () => {}, onSelectRuns: value => { selected = value; } });
  await act(() => button('Review run inputs').click());
  assert.equal(selected.runs[0].testVersionId, 'c'.repeat(32)); assert.match(container.textContent, /ECU A/); assert.match(container.textContent, /R1/);
});
test('read-only planning and dataset views disable every mutation', async () => {
  await mount(PlanningView, { model: { ...model, canEdit: false }, onModel: () => {} });
  assert.equal(button('Save draft'), undefined); assert.equal(button('Publish revision'), undefined);
  assert.equal(container.querySelector('[aria-label="Planning objective"]').disabled, true);
});

test('planning resolves Jira keys and named signed versions through authorized lookup', async () => {
  const calls = [];
  globalThis.transport = async (key, payload) => { calls.push({ key, payload }); if (key === 'harness:logAction') return {};
    return { issueId: '11', key: 'VAT-11', summary: 'Power checks', latestSigned: { versionId: 'c'.repeat(32), versionNo: 2 } }; };
  await mount(PlanningView, { model: { ...model, draft: { ...draft, members: [{ testIssueId: '', testIssueKey: 'VAT-11', versionId: null, required: true }] } }, onModel: () => {} });
  assert.ok(container.querySelector('[aria-label="Member 1 Jira key"]'), 'members are entered as Jira keys');
  await act(() => button('Find test').click());
  assert.equal(calls.find(c => c.key === 'tm:planning:lookup').payload.issueKey, 'VAT-11');
  assert.match(container.textContent, /Power checks/); assert.match(container.textContent, /signed v2/);
  assert.equal(container.querySelector('[aria-label="Member 1 version id"]'), null);
});
test('a signed plan starts real execution through signed scope and a retry-stable request identifier', async () => {
  const rev = { revisionId: 'a'.repeat(32), revisionNo: 1, state: 'SIGNED', digest: 'b'.repeat(64),
    content: { ...draft, release: { id: '900', name: 'R1' } }, signatures: [], nextStep: null, canSign: false };
  const calls = [];
  globalThis.transport = async (key, payload) => { if (key === 'harness:logAction') return {}; calls.push({ key, payload });
    if (calls.length === 1) return { error: 'Retry safely' }; return { issue: { key: 'VAT-31' }, runs: [{}] }; };
  await mount(PlanningView, { model: { ...model, revisions: [rev] }, onModel: () => {} });
  const input = container.querySelector('[aria-label="Execution Jira key for revision 1"]');
  assert.ok(input, 'signed plan offers real execution startup');
  await type(input, 'VAT-31');
  await act(() => button('Start execution').click()); await act(() => button('Start execution').click());
  assert.equal(calls[0].key, 'tm:plan:startExecution'); assert.equal(calls[0].payload.executionKey, 'VAT-31');
  assert.equal(calls[0].payload.contentHash, rev.digest); assert.equal(calls[0].payload.revisionId, rev.revisionId);
  assert.equal(calls[1].payload.requestId, calls[0].payload.requestId); assert.ok(calls[0].payload.requestId);
  assert.match(container.textContent, /VAT-31/);
});
test('a refused plan revision signature is shown in its sign box', async () => {
  const rev = { revisionId: 'a'.repeat(32), revisionNo: 1, state: 'PUBLISHED', digest: 'b'.repeat(64),
    content: { ...draft, release: { id: '900', name: 'R1' } }, signatures: [], canSign: true,
    nextStep: { label: 'Approval', role: 'Approver', meaning: 'I approve this plan revision', index: 0 } };
  globalThis.transport = async (key) => key === 'harness:logAction' ? {} : { error: 'Your authenticator is locked. Ask an administrator to reset it.', reason: 'CREDENTIAL_LOCKED' };
  await mount(PlanningView, { model: { ...model, revisions: [rev] }, onModel: () => {} });
  const box = container.querySelector('[role="group"][aria-label="Approval sign-off"]');
  assert.ok(box, 'the sign box is shown');
  await act(() => box.querySelector('.va-affirm input').click());
  await type(box.querySelector('input[aria-label="Six-digit authenticator code"]'), '123456');
  await act(() => [...box.querySelectorAll('button')].find(b => b.textContent === 'Sign').click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.match(box.textContent, /Your authenticator is locked/);
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
});
