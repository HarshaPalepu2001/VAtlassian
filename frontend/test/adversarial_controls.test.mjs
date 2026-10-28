import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://tenant.atlassian.net/panel/index.html' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const frontendReact = specifier => new URL(`../node_modules/${specifier === 'react' ? 'react/index' : specifier}.js`, import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/bridge') return { url: 'panel:bridge', shortCircuit: true };
    if (specifier === '@simplewebauthn/browser') return { url: 'panel:webauthn', shortCircuit: true };
    if (specifier === '@forge/react' || specifier === '@forge/react/jira') return { url: 'panel:forge-react', shortCircuit: true };
    if (specifier.startsWith('@atlaskit/')) return { url: 'panel:button', shortCircuit: true };
    if ((specifier === 'react' || specifier === 'react/jsx-runtime') && context.parentURL?.includes('/src/ui-kit/')) return { url: frontendReact(specifier), shortCircuit: true };
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL);
      for (const extension of ['.ts', '.tsx']) if (fs.existsSync(fileURLToPath(url) + extension)) return { url: url.href + extension, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'panel:bridge') return {
      format: 'module', shortCircuit: true, source: `
      export const invoke = (...args) => globalThis.panelTransport.invoke(...args);
      export const events = { on: async (name, cb) => globalThis.panelTransport.on(name, cb), emit: async (...args) => { globalThis.panelTransport.emitted.push(args); globalThis.panelTransport.deliver?.(...args); } };
      export const view = { refresh: async () => {}, submit: v => { globalThis.panelTransport.submitted.push(v); }, getContext: async () => globalThis.panelTransport.context }; export const router = { open: async () => {} };`
    };
    if (url === 'panel:webauthn') return {
      format: 'module', shortCircuit: true, source: `
      export const browserSupportsWebAuthn = () => globalThis.webauthnFixture.browserSupportsWebAuthn();
      export const platformAuthenticatorIsAvailable = () => globalThis.webauthnFixture.platformAuthenticatorIsAvailable();
      export const startAuthentication = args => globalThis.webauthnFixture.startAuthentication(args);
      export const startRegistration = args => globalThis.webauthnFixture.startRegistration(args);`
    };
    if (url === 'panel:button') return {
      format: 'module', shortCircuit: true, source: `
      import React from '${frontendReact('react')}';
      export default function Button({ children, onClick, isDisabled }) { return React.createElement('button', { onClick, disabled: isDisabled }, children); }`
    };
    if (url === 'panel:forge-react') return {
      format: 'module', shortCircuit: true, source: `
      import React from '${frontendReact('react')}';
      const h = React.createElement;
      const wrap = (tag, className) => ({ children }) => h(tag, { className }, children);
      export const Box = wrap('div', 'uk-box'); export const Inline = wrap('div', 'uk-inline'); export const Stack = wrap('div', 'uk-stack');
      export const Text = wrap('span', 'uk-text'); export const Heading = wrap('h4', 'uk-heading'); export const Lozenge = wrap('span', 'uk-lozenge');
      export const SectionMessage = ({ children, appearance }) => h('div', { className: 'uk-section uk-section--' + appearance }, children);
      export const Spinner = () => h('span', { className: 'uk-spinner' });
      export const Checkbox = ({ isChecked, onChange, label }) => h('label', { className: 'uk-checkbox' }, h('input', { type: 'checkbox', checked: !!isChecked, onChange }), label);
      export const Textfield = ({ value, onChange, isDisabled, name }) => h('input', { className: 'uk-textfield', name, value, onChange, disabled: isDisabled });
      export const Select = () => h('select', { className: 'uk-select' });
      export const CustomFieldEdit = ({ children }) => h('div', { className: 'uk-field' }, children);
      export const useProductContext = () => globalThis.panelTransport?.context;
      export default { render: element => { globalThis.uiKitEdit = element; } };`
    };
    if (/\.(tsx?|jsx)$/.test(url)) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), { fileName: fileURLToPath(url), compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    };
    return next(url, context);
  }
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ApprovalControls } = await import('../src/panel/sections/ApprovalControls.tsx');
const { default: RestoreStatus } = await import('../src/panel/sections/RestoreStatus.tsx');
const { default: TransitionsPage } = await import('../src/admin/pages/TransitionsPage.tsx');
const { restoreStateLabel } = await import('../src/panel/approvalModel.ts');
const { default: WebAuthnPopup } = await import('../src/panel/WebAuthnPopup.tsx');
const deviceAuth = await import('../src/panel/deviceAuth.ts');
hooks.deregister();

let root, container;
const openWindow = window.open;
afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove();
  root = null;
  window.open = openWindow;
  globalThis.webauthnFixture = defaultWebauthnFixture();
});

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const h = (type, props) => React.createElement(type, props);
const text = () => container?.textContent ?? '';
const clickButton = label => [...(container?.querySelectorAll('button') ?? [])].find(b => label instanceof RegExp ? label.test(b.textContent) : b.textContent === label);
const fieldSelect = label => [...(container?.querySelectorAll('.va-field') ?? [])].find(f => f.querySelector('.va-label')?.textContent === label)?.querySelector('select');
const selectValue = (select, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
};

const defaultWebauthnFixture = () => ({
  browserSupportsWebAuthn: () => true,
  platformAuthenticatorIsAvailable: async () => true,
  startAuthentication: async () => { throw new Error('No test authenticator response configured.'); },
  startRegistration: async () => { throw new Error('No test authenticator response configured.'); }
});
globalThis.webauthnFixture = defaultWebauthnFixture();

function setup(handler, { context = { extension: { issue: { key: 'T-1', id: '10' } } } } = {}) {
  const listeners = new Map();
  globalThis.panelTransport = {
    emitted: [], submitted: [], context, invoke: handler,
    on: (name, cb) => {
      listeners.set(name, cb);
      return { unsubscribe: () => listeners.delete(name) };
    }
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return listeners;
}

function summary(over = {}) {
  return {
    issue: { id: '1', key: 'T-1', summary: 'Current record', status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    controlled: true, tier: 'actor', state: 'Waiting on signature', actorName: 'Tester',
    eligibility: { eligible: true, reason: null }, credentialEnrolled: true,
    transitions: [], baseline: { baselineId: 'base-1', version: 1 }, latestApproval: null,
    drift: { count: 1, materialCount: 1, decidesDrift: true, policyIncomplete: false, canApprove: true, canReject: true },
    restore: null, approval: { requiredRole: 'QA', requiredAssurance: 'ESIGNATURE', meaning: 'Approve', pending: null },
    ...over
  };
}

function dummyEvidence() {
  return {
    baselineId: 'b-1', baselineVersion: 1, evidenceHash: 'sha256-evidence-test',
    record: { version: 1, approvedName: 'Tester', approvedAt: 1000, fieldCount: 1, retainedCount: 1, fields: [] },
    drift: { fields: [] }, rejection: { deleteIssueKeys: [], recreateCount: 0 }, restoreHistory: []
  };
}

// ── 1. WebAuthn Cross-Frame Spoofing Adversarial Tests ────────────────────────

test('CHALLENGE 1.1: deviceAuth rejects spoofed message from window, other frames, or alien sources', async () => {
  const originalOpen = window.open;
  try {
    let popup;
    window.open = () => (popup = { closed: false, close() { popup.closed = true; }, postMessage() {} });
    setup(key => key === 'webauthn:assertStart' ? { ok: true, challengeId: 'ch-1', options: { challenge: 'abc' } } : {});

    const outcome = deviceAuth.confirmBiometric({ approvalChallengeId: 'ch-1' });
    await flush();

    // Adversarial vector 1: Same origin, source is top window
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'webauthn-result', success: true, response: { id: 'evil-1' } },
      origin: window.location.origin,
      source: window
    }));
    await flush();

    // Adversarial vector 2: Different window proxy object claiming to be a popup
    const alienPopup = { closed: false, close() {}, postMessage() {} };
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'webauthn-result', success: true, response: { id: 'evil-2' } },
      origin: window.location.origin,
      source: alienPopup
    }));
    await flush();

    // Adversarial vector 3: Source is null
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'webauthn-result', success: true, response: { id: 'evil-3' } },
      origin: window.location.origin,
      source: null
    }));
    await flush();

    // Verify neither resolved the outcome
    const probe = await Promise.race([outcome, new Promise(r => setTimeout(() => r('still waiting'), 30))]);
    assert.equal(probe, 'still waiting', 'Outcome must not resolve when spoofed messages are received');

    // Legitimate response from actual popup:
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'webauthn-result', success: true, response: { id: 'legit-cred' } },
      origin: window.location.origin,
      source: popup
    }));
    await flush();

    // Now it resolves with legitimate credential
    const legitResult = await Promise.race([outcome, new Promise(r => setTimeout(() => r('timed_out'), 100))]);
    assert.notEqual(legitResult, 'timed_out');
  } finally {
    window.open = originalOpen;
  }
});

// ── 2. Drift Decision Button Guards in ApprovalControls ───────────────────────

test('CHALLENGE 2.1: drift decision buttons strictly disabled across all invalid evidence permutations', async () => {
  setup(() => ({}));
  const driftSummary = summary();

  // Permutation A: evidenceLoading=true, evidence=null
  await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: null, evidenceLoading: true, onDone: async () => {} })));
  await flush();
  assert.equal(clickButton('Approve changes').disabled, true, 'Approve must be disabled when loading');
  assert.equal(clickButton('Reject and restore').disabled, true, 'Reject must be disabled when loading');

  // Permutation B: evidenceLoading=false, evidence=null (e.g. error loading evidence)
  await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: null, evidenceLoading: false, onDone: async () => {} })));
  await flush();
  assert.equal(clickButton('Approve changes').disabled, true, 'Approve must be disabled when evidence is null');
  assert.equal(clickButton('Reject and restore').disabled, true, 'Reject must be disabled when evidence is null');

  // Permutation C: evidenceLoading=true, evidence is non-null (re-fetch in flight)
  await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: dummyEvidence(), evidenceLoading: true, onDone: async () => {} })));
  await flush();
  assert.equal(clickButton('Approve changes').disabled, true, 'Approve must be disabled when evidence is reloading even if stale evidence exists');
  assert.equal(clickButton('Reject and restore').disabled, true, 'Reject must be disabled when evidence is reloading even if stale evidence exists');

  // Permutation D: evidenceLoading=false, evidence is loaded and valid
  await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: dummyEvidence(), evidenceLoading: false, onDone: async () => {} })));
  await flush();
  assert.equal(clickButton('Approve changes').disabled, false, 'Approve must be enabled once evidence is fully loaded');
  assert.equal(clickButton('Reject and restore').disabled, false, 'Reject must be enabled once evidence is fully loaded');
});

test('CHALLENGE 2.2: requestChallenge function rejects early when drift evidence is missing or loading', async () => {
  let challengeInvoked = false;
  setup(key => {
    if (key === 'signature:challenge') challengeInvoked = true;
    return {};
  });

  const driftSummary = summary();
  await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: null, evidenceLoading: true, onDone: async () => {} })));
  await flush();

  // Synthetic invocation: Click directly on disabled button
  const approveBtn = clickButton('Approve changes');
  await act(() => approveBtn.click());
  await flush();
  assert.equal(challengeInvoked, false, 'signature:challenge must NOT be called when driftEvidenceBlocked is true');
});

// ── 3. TransitionsPage Out-of-Order Async & Stale Closure Safety ──────────────

test('CHALLENGE 3.1: TransitionsPage handles 3 rapid project switches (P1 -> P2 -> P3) with reverse arrivals', async () => {
  let resolveP1, resolveP2, resolveP3;
  setup(async (key, payload) => {
    if (key === 'admin:listControlledTransitions') return { success: true, transitions: [] };
    if (key === 'admin:listStatusesForProject') {
      if (payload.projectId === 'P1') return new Promise(r => { resolveP1 = () => r({ success: true, statuses: [{ id: 's1', name: 'Status 1' }] }); });
      if (payload.projectId === 'P2') return new Promise(r => { resolveP2 = () => r({ success: true, statuses: [{ id: 's2', name: 'Status 2' }] }); });
      if (payload.projectId === 'P3') return new Promise(r => { resolveP3 = () => r({ success: true, statuses: [{ id: 's3', name: 'Status 3' }] }); });
    }
    if (key === 'admin:listIssueTypesForProject') return { success: true, issueTypes: [{ id: 'it1', name: 'Bug' }] };
    return { success: true };
  });

  await act(() => root.render(h(TransitionsPage, { projects: [{ id: 'P1', name: 'Proj 1' }, { id: 'P2', name: 'Proj 2' }, { id: 'P3', name: 'Proj 3' }] })));
  await flush();

  // Rapid switching P1 -> P2 -> P3
  await act(() => selectValue(fieldSelect('Project'), 'P1'));
  await flush();
  await act(() => selectValue(fieldSelect('Project'), 'P2'));
  await flush();
  await act(() => selectValue(fieldSelect('Project'), 'P3'));
  await flush();

  // Reversed resolution: resolve P3, then resolve P1, then resolve P2
  await act(() => resolveP3());
  await flush();
  await act(() => resolveP1());
  await flush();
  await act(() => resolveP2());
  await flush();

  // Status 3 must be present, while Status 1 and Status 2 must NOT be rendered
  assert.match(text(), /Status 3/, 'Current project P3 statuses must be rendered');
  assert.doesNotMatch(text(), /Status 1/, 'Stale P1 statuses must be dropped');
  assert.doesNotMatch(text(), /Status 2/, 'Stale P2 statuses must be dropped');
});

test('CHALLENGE 3.1b: a late all-types status read cannot overwrite a selected work-item type', async () => {
  let resolveAll, resolveBug;
  setup(async (key, payload) => {
    if (key === 'admin:listControlledTransitions') return { success: true, transitions: [] };
    if (key === 'admin:listIssueTypesForProject') return { success: true, issueTypes: [{ id: 'bug', name: 'Bug' }] };
    if (key === 'admin:listStatusesForProject' && payload.issueTypeId === '') {
      return new Promise(resolve => { resolveAll = () => resolve({ success: true, statuses: [{ id: 'all', name: 'All-types status' }] }); });
    }
    if (key === 'admin:listStatusesForProject' && payload.issueTypeId === 'bug') {
      return new Promise(resolve => { resolveBug = () => resolve({ success: true, statuses: [{ id: 'bug-status', name: 'Bug-only status' }] }); });
    }
    return { success: true };
  });

  await act(() => root.render(h(TransitionsPage, { projects: [{ id: 'P1', name: 'Proj 1' }] })));
  await flush();
  await act(() => selectValue(fieldSelect('Project'), 'P1'));
  await flush();
  await act(() => selectValue(fieldSelect('Work item type'), 'bug'));
  await flush();
  assert.ok(resolveAll && resolveBug, 'both reads are in flight for the race');
  await act(() => resolveBug());
  await flush();
  await act(() => resolveAll());
  await flush();
  assert.match(text(), /Bug-only status/);
  assert.doesNotMatch(text(), /All-types status/);
});

test('CHALLENGE 3.2: TransitionsPage functional role updater preserves valid role and resets invalid role', async () => {
  const roleResolvers = new Map();
  setup(async (key, payload) => {
    if (key === 'admin:listControlledTransitions') return { success: true, transitions: [] };
    if (key === 'admin:listStatusesForProject') return { success: true, statuses: [] };
    if (key === 'admin:listIssueTypesForProject') return {
      success: true,
      issueTypes: [{ id: 'it1', name: 'Task' }, { id: 'it2', name: 'Bug' }, { id: 'it3', name: 'Story' }]
    };
    if (key === 'admin:listAvailableRoles') {
      return new Promise(r => { roleResolvers.set(payload.issueTypeId, r); });
    }
    if (key === 'admin:listWorkflowTransitions') return { success: true, transitions: [] };
    return { success: true };
  });

  await act(() => root.render(h(TransitionsPage, { projects: [{ id: 'P1', name: 'Proj 1' }] })));
  await flush();

  await act(() => selectValue(fieldSelect('Project'), 'P1'));
  await flush();
  await act(() => selectValue(fieldSelect('Work item type'), 'it1'));
  await flush();

  // Server returns roles for it1: Admin, QA Lead
  const r1 = roleResolvers.get('it1');
  assert.ok(r1, 'Role resolver for it1 should be registered');
  await act(() => r1({ success: true, roles: ['Admin', 'QA Lead'] }));
  await flush();

  const roleSelect = fieldSelect('Who must sign');
  assert.ok(roleSelect, 'Who must sign role select must be rendered');
  await act(() => selectValue(roleSelect, 'QA Lead'));
  await flush();
  assert.equal(roleSelect.value, 'QA Lead', 'QA Lead should be selected');

  // Switch to it2 where QA Lead is still valid
  await act(() => selectValue(fieldSelect('Work item type'), 'it2'));
  await flush();
  const r2 = roleResolvers.get('it2');
  assert.ok(r2, 'Role resolver for it2 should be registered');
  await act(() => r2({ success: true, roles: ['Developer', 'QA Lead'] }));
  await flush();
  assert.equal(fieldSelect('Who must sign').value, 'QA Lead', 'QA Lead must be preserved because it is still in the roles list');

  // Switch to it3 where QA Lead is NOT valid
  await act(() => selectValue(fieldSelect('Work item type'), 'it3'));
  await flush();
  const r3 = roleResolvers.get('it3');
  assert.ok(r3, 'Role resolver for it3 should be registered');
  await act(() => r3({ success: true, roles: ['Developer', 'Security'] }));
  await flush();
  assert.equal(fieldSelect('Who must sign').value, '', 'Role must be cleared to empty string because QA Lead is not available in it3');
});

// ── 4. UI Kit Missing evidenceHash Error Banner ───────────────────────────────

// ── 5. Restoration Status Machine & Labels ───────────────────────────────────

test('CHALLENGE 5.1: restoreStateLabel produces accurate human-readable text for all states', () => {
  assert.equal(restoreStateLabel('QUEUING_FAILED'), 'Queuing failed');
  assert.equal(restoreStateLabel('ERROR'), 'Restore error');
  assert.equal(restoreStateLabel('FAILED'), 'Restore failed');
  assert.equal(restoreStateLabel('PARTIAL'), 'Partly restored');
  assert.equal(restoreStateLabel('COMPLETE'), 'Restored and verified');
  assert.equal(restoreStateLabel('COMPLETE_WITH_REPLACEMENTS'), 'Complete with replacement identities');
  assert.equal(restoreStateLabel('RUNNING'), 'Restoration in progress');
  assert.equal(restoreStateLabel('QUEUED'), 'Restoration in progress');
});

test('CHALLENGE 5.2: RestoreStatus shows the latest restore with a danger badge and one Retry restore', async () => {
  let retriedId = null;
  setup(async (key, payload) => {
    if (key === 'restore:getState') {
      return {
        success: true,
        restores: [
          { restore_id: 'res-qf', state: 'QUEUING_FAILED', error: 'Queue connection lost' },
          { restore_id: 'res-err', state: 'ERROR', error: 'Database constraint violation' },
          { restore_id: 'res-ok', state: 'COMPLETE' }
        ]
      };
    }
    if (key === 'restore:retry') {
      retriedId = payload.restoreId;
      return { success: true };
    }
    return {};
  });

  const restoreProp = { restoreId: 'res-qf', state: 'QUEUING_FAILED', succeeded: 0, failed: 1, skipped: 0 };
  await act(() => root.render(h(RestoreStatus, { issueKey: 'T-1', restore: restoreProp })));
  await flush();

  assert.match(text(), /Queuing failed/);
  // Older restores belong to the Baseline record's log, not the panel.
  assert.doesNotMatch(text(), /Restore error/);
  assert.doesNotMatch(text(), /Restored and verified/);

  const qfBadge = [...container.querySelectorAll('.va-badge')].find(b => b.textContent.includes('Queuing failed'));
  assert.ok(qfBadge?.className.includes('danger'), 'QUEUING_FAILED badge must have danger tone');

  const retryButtons = [...container.querySelectorAll('button')].filter(b => b.textContent.includes('Retry restore'));
  assert.equal(retryButtons.length, 1, 'only the latest restore can be retried from the panel');

  await act(() => retryButtons[0].click());
  await flush();
  assert.equal(retriedId, 'res-qf', 'Retry restore should invoke restore:retry with res-qf');
});

test('CHALLENGE 1.2: WebAuthnPopup rejects message when source !== opener or origin mismatches', async () => {
  setup(() => ({}));
  const originalOpener = Object.getOwnPropertyDescriptor(window, 'opener');
  const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  try {
    const fakeOpener = { postMessage() {} };
    Object.defineProperty(window, 'opener', { value: fakeOpener, configurable: true, writable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true });

    await act(() => root.render(h(WebAuthnPopup)));
    await flush();

    // Verify initial rendering
    assert.match(text(), /Getting this check ready/);

    // Adversarial vector 1: Wrong source (posted with source = window instead of opener)
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'webauthn-options', action: 'confirm', optionsJSON: {} },
      origin: window.location.origin,
      source: window
    }));
    await flush();
    // Phase should still be 'waiting' ('Getting this check ready')
    assert.match(text(), /Getting this check ready/, 'WebAuthnPopup must ignore options from source !== opener');

    // Adversarial vector 2: Wrong origin
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'webauthn-options', action: 'confirm', optionsJSON: {} },
      origin: 'https://attacker.com',
      source: fakeOpener
    }));
    await flush();
    assert.match(text(), /Getting this check ready/, 'WebAuthnPopup must ignore options from wrong origin');
  } finally {
    if (originalOpener) Object.defineProperty(window, 'opener', originalOpener);
    else delete window.opener;
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    else delete window.isSecureContext;
  }
});

test('CHALLENGE 1.2b: duplicate valid options start only one device prompt', async () => {
  setup(() => ({}));
  const originalOpener = Object.getOwnPropertyDescriptor(window, 'opener');
  const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  let starts = 0;
  try {
    const fakeOpener = { postMessage() {} };
    Object.defineProperty(window, 'opener', { value: fakeOpener, configurable: true, writable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true });
    globalThis.webauthnFixture = {
      browserSupportsWebAuthn: () => true,
      platformAuthenticatorIsAvailable: async () => true,
      startAuthentication: async () => { starts++; return new Promise(() => {}); },
      startRegistration: async () => { throw new Error('unexpected enrolment'); }
    };
    await act(() => root.render(h(WebAuthnPopup)));
    await flush();
    const options = { type: 'webauthn-options', action: 'confirm', optionsJSON: { challenge: 'one' } };
    window.dispatchEvent(new window.MessageEvent('message', { data: options, origin: window.location.origin, source: fakeOpener }));
    window.dispatchEvent(new window.MessageEvent('message', { data: options, origin: window.location.origin, source: fakeOpener }));
    await flush();
    assert.equal(starts, 1, 'a repeated valid options message must not open a second authenticator prompt');
  } finally {
    if (originalOpener) Object.defineProperty(window, 'opener', originalOpener);
    else delete window.opener;
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    else delete window.isSecureContext;
  }
});

test('CHALLENGE 1.3: WebAuthnPopup fails safe when opened directly without opener', async () => {
  setup(() => ({}));
  const originalOpener = Object.getOwnPropertyDescriptor(window, 'opener');
  try {
    Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true });
    await act(() => root.render(h(WebAuthnPopup)));
    await flush();
    assert.match(text(), /This window was opened directly\. Start the approval from the work item instead\./);
  } finally {
    if (originalOpener) Object.defineProperty(window, 'opener', originalOpener);
    else delete window.opener;
  }
});

test('CHALLENGE 5.3: RestoreStatus handles retry failure gracefully and displays error notice', async () => {
  setup(async (key) => {
    if (key === 'restore:getState') {
      return { success: true, restores: [{ restore_id: 'res-err', state: 'ERROR' }] };
    }
    if (key === 'restore:retry') {
      return { success: false, error: 'Forge backend timeout during restore retry' };
    }
    return {};
  });

  const restoreProp = { restoreId: 'res-err', state: 'ERROR', succeeded: 0, failed: 1, skipped: 0 };
  await act(() => root.render(h(RestoreStatus, { issueKey: 'T-1', restore: restoreProp })));
  await flush();

  const retryBtn = clickButton('Retry restore');
  assert.ok(retryBtn, 'Retry button should exist');
  assert.equal(retryBtn.disabled, false);

  await act(() => retryBtn.click());
  await flush();

  assert.match(text(), /Forge backend timeout during restore retry/, 'Error message should be rendered in danger notice');
  assert.equal(retryBtn.disabled, false, 'Retry button must become re-enabled after failure');
});
