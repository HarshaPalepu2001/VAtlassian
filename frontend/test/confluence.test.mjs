import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';

const window = new Window({url:'https://tenant.atlassian.net/panel/index.html'});
Object.assign(globalThis, {window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const frontendReact=specifier=>new URL(`../node_modules/${specifier==='react'?'react/index':specifier}.js`,import.meta.url).href;

const hooks=registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@forge/bridge')return {url:'panel:bridge',shortCircuit:true};
  if(specifier==='@forge/react'||specifier==='@forge/react/jira')return {url:'panel:forge-react',shortCircuit:true};
  if(specifier.startsWith('@atlaskit/'))return {url:'panel:button',shortCircuit:true};
  if((specifier==='react'||specifier==='react/jsx-runtime')&&context.parentURL?.includes('/src/ui-kit/'))return {url:frontendReact(specifier),shortCircuit:true};
  if(specifier.startsWith('.')){
   const url=new URL(specifier,context.parentURL);
   for(const extension of ['.ts','.tsx'])if(fs.existsSync(fileURLToPath(url)+extension))return {url:url.href+extension,shortCircuit:true};
  }
  return next(specifier,context);
 },
 load(url,context,next){
  if(url==='panel:bridge')return {format:'module',shortCircuit:true,source:`
   export const invoke=(...args)=>globalThis.panelTransport.invoke(...args);
   export const events={on:async(name,cb)=>globalThis.panelTransport.on(name,cb),emit:async(...args)=>{globalThis.panelTransport.emitted.push(args);globalThis.panelTransport.deliver?.(...args);}};
   export const view={refresh:async()=>{},submit:v=>{globalThis.panelTransport.submitted.push(v);},getContext:async()=>globalThis.panelTransport.context};export const router={open:async()=>{}};`};
  if(url==='panel:button')return {format:'module',shortCircuit:true,source:`
   import React from '${frontendReact('react')}';
   export default function Button({children,onClick,isDisabled}){return React.createElement('button',{onClick,disabled:isDisabled},children);}`};
  if(url==='panel:forge-react')return {format:'module',shortCircuit:true,source:`
   import React from '${frontendReact('react')}';
   const h=React.createElement;
   export const useProductContext=()=>globalThis.panelTransport?.context;
   export default {render:element=>{globalThis.uiKitEdit=element;}};`};
  if(/\.(tsx?|jsx)$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(url),'utf8'),{fileName:fileURLToPath(url),compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
  return next(url,context);
 }
});

const React = await import('react');
const ReactDOMClient = await import('react-dom/client');
const { act } = await import('react');
const { default: ConfluencePageStatus } = await import('../src/confluence/ConfluencePageStatus.tsx');
const { default: ConfluenceSpaceSetup } = await import('../src/confluence/ConfluenceSpaceSetup.tsx');

let container;
let root;
function setup() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  globalThis.panelTransport = {
    invoke: async (name, args) => {
      if (name === 'confluence:getPageStatus') return { success: true, ok: true, status: globalThis.testPageStatus || 'UNPROTECTED' };
      if (name === 'confluence:getSpaceRole') {
        if (globalThis.testSpaceRoleReject) throw new Error('space status is unavailable');
        return { success: true, ok: true, ...(globalThis.testSpaceRole || { vault: false }) };
      }
      throw new Error(`Unhandled invoke: ${name}`);
    },
    context: { extension: { issue: { key: 'TEST-1' } }, accountId: 'test' }
  };
}
function teardown() {
  if (root) {
    act(() => { root.unmount(); });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  delete globalThis.testPageStatus;
  delete globalThis.testSpaceRole;
  delete globalThis.testSpaceRoleReject;
}

test('Confluence: page banner/byline states', async (t) => {
  const states = [
    { status: 'UNPROTECTED', text: 'Not protected yet' },
    { status: 'PROTECTED', text: 'Protected' },
    { status: 'WORKING_COPY', text: 'Working copy open' },
    { status: 'APPROVAL_PENDING', text: 'Approval pending' },
    { status: 'DRIFTED', text: 'Drifted' },
    { status: 'RESTORING', text: 'Restoring' },
    { status: 'ERROR_LOCKED', text: 'Error locked' },
    { status: 'DETECTION_ONLY', text: 'Detection only' }
  ];

  for (const { status, text } of states) {
    await t.test(`shows ${status}`, async () => {
      setup();
      globalThis.testPageStatus = status;
      await act(async () => {
        root.render(React.createElement(ConfluencePageStatus, { view: 'confluence-banner' }));
      });
      assert.match(container.textContent, new RegExp(text));
      teardown();
    });
  }
});

test('Confluence: the site vault reports the projects it holds and offers no settings', async () => {
  setup();
  globalThis.testSpaceRole = {
    vault: true,
    spaceKey: 'VATVAULT',
    projectCount: 3,
    lockedProjectCount: 2
  };

  await act(async () => {
    root.render(React.createElement(ConfluenceSpaceSetup));
  });

  assert.match(container.textContent, /Evidence vault/);
  assert.match(container.textContent, /VATVAULT/);
  assert.match(container.textContent, /Jira projects vaulted\s*3/);
  assert.match(container.textContent, /2 of 3 projects/);
  assert.equal(container.querySelectorAll('select').length, 0, 'a vault space must expose no policy dropdowns');
  teardown();
});

test('Confluence: an ordinary space points policy at the Jira admin console', async () => {
  setup();
  globalThis.testSpaceRole = { vault: false };

  await act(async () => {
    root.render(React.createElement(ConfluenceSpaceSetup));
  });

  assert.match(container.textContent, /Not governed by this app/);
  assert.match(container.textContent, /admin console in Jira/);
  assert.equal(container.querySelectorAll('select').length, 0, 'space setup must expose no policy dropdowns');
  teardown();
});

test('Confluence: space status surfaces a read failure', async () => {
  setup();
  globalThis.testSpaceRoleReject = true;
  await act(async () => {
    root.render(React.createElement(ConfluenceSpaceSetup));
  });
  assert.match(container.textContent, /space status is unavailable/);
  teardown();
});
