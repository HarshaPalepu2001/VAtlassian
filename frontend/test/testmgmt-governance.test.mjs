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
const { default: IntakeControls } = await import('../src/testmgmt/IntakeControls.tsx');
const { default: GovernanceView } = await import('../src/testmgmt/GovernanceView.tsx');
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
const chain = { steps: [{ label: 'Record', role: 'QA', meaning: 'I performed these steps' }], distinctSigners: true };
function execution(extra = {}) {
 const run = { runId: 'a'.repeat(32), state: 'IN_PROGRESS', result: 'PASSED', revision: 1, test: { id: '11', key: 'VAT-11', hidden: false },
 version: { versionId: 'b'.repeat(32), versionNo: 1, digest: 'd'.repeat(64) }, environment: '', configuration: '', release: null,
 createdAt: 1, steps: [], preconditions: '', contentHash: 'd'.repeat(64), signabilityProblem: null, chain, signatures: [], notExecuted: null,
 nextStep: { ...chain.steps[0], index: 0 }, canSign: true, canFinish: false, bug: null, ...extra };
 return { role: 'EXECUTION', issue: { id: '20', key: 'VAT-20', summary: 'Candidate', status: 'Open', done: false }, parent: { key: 'VAT-1' },
 canEdit: true, releases: [], attachments: [], runChain: chain, runs: [run] };
}
test('historical runs display missing provenance and metadata as Not recorded', async () => {
 await mount(ExecutionView, { model: execution(), onModel: () => {} });
 for (const label of ['Attempt sequence', 'Classification', 'Reported build (sender-attested)', 'Provenance']) assert.ok(container.textContent.includes(label), label);
 assert.ok(container.textContent.match(/Not recorded/g)?.length >= 4);
});
test('machine reviewers affirm review meaning and see sender attribution before signing', async () => {
 await mount(ExecutionView, { model: execution({ attemptSequence: 7, classification: { level: 'SYSTEM', method: 'AUTOMATED' },
 reportedBuild: { buildId: 'candidate-7', commit: 'abcdef' }, provenance: { kind: 'MACHINE', tokenId: 'ci-token' }, evidenceSchema: 2 }), onModel: () => {} });
 await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Open runner').click());
 assert.ok(container.textContent.includes('I reviewed these machine-recorded results and their evidence.'));
 assert.ok(container.textContent.includes('candidate-7'));
 assert.ok(container.textContent.includes('ci-token'));
 assert.ok(!container.textContent.includes('I performed these steps'));
});
test('unresolved receipt processing blocks machine review even if canSign is stale', async () => {
 await mount(ExecutionView, { model: execution({ provenance: { kind: 'MACHINE' }, intakeReceiptId: 'receipt-1', intakePending: true }), onModel: () => {} });
 await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Open runner').click());
 assert.ok(container.textContent.includes('APPLIED'));
 assert.equal(container.querySelector('.tm-signoff'), null);
});

test('intake marks partial receipts blocked and retries the exact authenticated receipt', async () => {
 const calls = [];
 await mount(IntakeControls, { issueKey: 'VAT-20', runs: [], canEdit: true }, async (key, payload) => {
  calls.push({ key, payload });
  return { tokens: [], grants: [], receipts: [{ receiptId: 'r1', status: 'PARTIAL', payloadDigest: 'abc', receivedAt: 1, progress: { completed: 1, total: 2 } }] };
 });
 assert.ok(container.textContent.includes('Receipt not APPLIED'));
 await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry receipt r1').click());
 assert.deepEqual(calls.find(call => call.key === 'tm:intake:retry').payload, { issueKey: 'VAT-20', receiptId: 'r1' });
});
test('new governance chain configuration is independently editable and saved', async () => {
 const calls = [];
 const data = { success: true, config: null, project: { style: 'classic', issueTypes: [] }, linkTypes: [],
 defaults: { runChain: chain, versionChain: chain, assignmentChain: chain, targetChain: chain, exceptionChain: chain, linkTypeName: 'Relates' } };
 await mount(Admin, { projects: [{ id: '100', name: 'Project', key: 'VAT' }] }, async (key, payload) => { calls.push({ key, payload }); return key === 'admin:tm:save' ? { success: true, config: { ...payload, revision: 1 } } : data; });
 await act(() => { const el = container.querySelector('select'); el.value = '100'; el.dispatchEvent(new window.Event('change', { bubbles: true })); });
 await flush();
 for (const title of ['Verification assignment approval', 'Closure target approval', 'Evidence exception approval']) {
  assert.ok(container.querySelector(`textarea[aria-label="${title} step 1 meaning"]`), title);
 }
 assert.ok(container.querySelector('input[aria-label="Governance authors cannot approve their own records"]'));
 await fill('Closure target approval step 1 meaning', 'I approve this candidate.');
 await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Save and enable').click());
 const saved = calls.find(call => call.key === 'admin:tm:save').payload;
 assert.equal(saved.targetChain.steps[0].meaning, 'I approve this candidate.');
 assert.equal(saved.assignmentChain.steps[0].meaning, chain.steps[0].meaning);
 assert.equal(saved.governanceAuthorSeparation, true);
});

function governance(extra = {}) { return { issueId: '30', issueKey: 'VAT-30', source: { governedReady: true, drifted: false, sourceDigest: 'a'.repeat(64), baseline: { version: 3 } }, complete: true, records: [], activeAssignment: null, activeTarget: null, evaluations: [], ...extra }; }
async function fill(label, value) {
 const el = container.querySelector(`[aria-label="${label}"]`); assert.ok(el, label);
 await act(() => { Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(el, value);
 el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
test('assignment preparation freezes exact mandatory context rows without signing or activating', async () => {
 const calls = [];
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async (key, payload) => { calls.push({ key, payload }); return governance(); });
 for (const [label, value] of [['Obligation identifier 1','REQ-1'],['Verification level 1','SYSTEM'],['Verification method 1','AUTOMATED'],['Exact signed test version ID 1','b'.repeat(32)],['Environment 1','bench'],['Assignment rationale','Approved coverage']]) await fill(label, value);
 const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Prepare assignment for approval'); assert.equal(button.disabled, false);
 await act(() => button.click());
 const payload = calls.find(call => call.key === 'tm:governance:prepareAssignment').payload;
 assert.deepEqual(payload, { issueKey: 'VAT-30', rationale: 'Approved coverage', buildPolicy: { mode: 'EXACT' }, obligations: [{ id: 'REQ-1', level: 'SYSTEM', method: 'AUTOMATED', tests: [{ testVersionId: 'b'.repeat(32), contexts: [{ environment: 'bench', configuration: '', release: null }] }] }] });
 assert.ok(!calls.some(call => call.key === 'tm:governance:sign'));
});
test('governance approvals show full frozen content and configured meaning before TOTP', async () => {
 const record = { recordId: 'r1', kind: 'ASSIGNMENT', content: { rationale: 'Frozen rationale', obligations: [{ id: 'required-system' }] }, digest: 'a'.repeat(64), state: 'SIGNING', chain,
 signatures: [], nextStep: { index: 0, label: 'Assignment approval', role: 'QA', meaning: 'I approve these mandatory obligations.' }, canSign: true, proofConfirmed: false };
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async () => governance({ records: [record] }));
 assert.ok(container.textContent.includes('required-system'));
 assert.ok(container.textContent.indexOf('required-system') < container.textContent.indexOf('I approve these mandatory obligations.'));
 assert.ok(container.querySelector('.tm-signoff'));
});
test('source drift blocks preparations and exposes stale assignments', async () => {
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async () => governance({ source: { governedReady: false, drifted: true }, activeAssignment: { recordId: 'a1', stale: true } }));
 assert.ok(container.textContent.includes('Source baseline is unavailable, stale or has drift'));
 assert.ok(container.textContent.includes('Stale assignment'));
 assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === 'Prepare assignment for approval').disabled, true);
});
test('denied frozen evaluations remain exportable and separate permission from transition facts', async () => {
 const evaluation = { evaluationId: 'eval-1', digest: 'a'.repeat(64), snapshot: { verdict: 'DENIED', evaluatedAt: 1, findings: [{ code: 'MISSING_REPORTEDBUILD' }], transition: { observed: false, linked: false } } };
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async () => governance({ evaluations: [evaluation] }));
 assert.ok(container.textContent.includes('DENIED'));
 assert.ok(container.textContent.includes('Observed Jira transition: Not observed'));
 assert.ok(container.textContent.includes('evaluation linkage: Not established'));
 assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === 'Download frozen dossier').disabled, false);
});
test('an unconfirmed evaluation cannot be exported or displayed as closure permission', async () => {
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async key => key === 'tm:governance:evaluate' ? { evaluationId: 'eval-2', verdict: 'DENIED', recorded: false, findings: [{ code: 'EVALUATION_NOT_CONFIRMED' }] } : governance());
 await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Evaluate closure').click());
 assert.ok(container.textContent.includes('not durably confirmed'));
 assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === 'Download frozen dossier').disabled, true);
});
test('adding an attempt permits an explicit classification and sender-attested candidate identity', async () => {
 await mount(ExecutionView, { model: execution(), onModel: () => {} });
 for (const label of ['Run verification level','Run verification method','Run reported build ID']) assert.ok(container.querySelector(`[aria-label="${label}"]`), label);
});
test('APPLIED receipt without confirmed audit is visibly blocked', async () => {
 await mount(IntakeControls, { issueKey: 'VAT-20', runs: [], canEdit: false }, async () => ({ tokens: [], grants: [], receipts: [{ receiptId: 'r2', status: 'APPLIED', payloadDigest: 'abc', receivedAt: 1, auditConfirmed: false }] }));
 assert.ok(container.textContent.includes('Audit confirmation pending'));
});

test('execution grant expiry cannot outlive the selected project token', async () => {
 const calls = [], tokenExpiry = Date.now() + 100000;
 await mount(IntakeControls, { issueKey: 'VAT-20', runs: execution({ evidenceSchema: 2 }).runs, canEdit: true }, async (key, payload) => { calls.push({ key, payload }); return { tokens: [{ tokenId: 'token-1', label: 'Build bot', expiresAt: tokenExpiry }], grants: [], receipts: [], canManage: true }; });
 await act(() => { const el = container.querySelector('select[aria-label="Project CI token"]'); el.value = 'token-1'; el.dispatchEvent(new window.Event('change', { bubbles: true })); });
 await act(() => container.querySelector('fieldset input[type="checkbox"]').click());
 await act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Grant selected runs').click());
 assert.ok(calls.find(call => call.key === 'tm:intake:grant').payload.expiresAt <= tokenExpiry);
});
test('exception-qualified attempts name the accepted gap and keep missing build identity unproved', async () => {
 const evaluation = { evaluationId: 'eval-3', digest: 'a'.repeat(64), snapshot: { verdict: 'ALLOWED', evaluatedAt: 1, findings: [], selectedAttempts: [{ obligationId: 'REQ-1', testVersionId: 'b'.repeat(32), context: { environment: 'bench' }, run: { runId: 'run-4', attemptSequence: 4, state: 'SIGNED', result: 'PASSED' }, qualification: 'VERIFIED_WITH_EXCEPTION', unresolvedMetadata: ['reportedBuild'] }] } };
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async () => governance({ evaluations: [evaluation] }));
 const table = container.querySelector('[aria-label="Selected frozen attempts"]'); assert.ok(table);
 assert.ok(table.textContent.includes('VERIFIED_WITH_EXCEPTION'));
 assert.ok(table.textContent.includes('reportedBuild'));
 assert.ok(table.textContent.includes('Missing build identity remains unproved'));
});

test('observed Jira moves remain separate from closure permission and correlation', async () => {
 await mount(GovernanceView, { issueKey: 'VAT-30' }, async () => governance({ observedTransitions: [{ observationId: 'observed-1', createdAt: 20,
 content: { fromStatusId: '10', toStatusId: '20', transitionId: '11', correlation: 'NOT_ESTABLISHED', evaluationId: null } }] }));
 assert.ok(container.textContent.includes('Observed Jira transitions'));
 assert.ok(container.textContent.includes('10 → 20'));
 assert.ok(container.textContent.includes('Evaluation linkage: Not established'));
});
