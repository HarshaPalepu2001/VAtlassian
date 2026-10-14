import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({url:'https://tenant.atlassian.net/settings'});
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const reactURL = new URL('../node_modules/react/index.js', import.meta.url).href;
const hooks=registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@forge/bridge')return {url:'totp:bridge',shortCircuit:true};
  if(specifier==='qrcode.react')return {url:'totp:qr',shortCircuit:true};
  if(specifier.startsWith('@atlaskit/'))return {url:'totp:kit/'+specifier.split('/')[1],shortCircuit:true};
  if(specifier.startsWith('.')){const url=new URL(specifier,context.parentURL);for(const ext of ['.ts','.tsx'])if(fs.existsSync(fileURLToPath(url)+ext))return {url:url.href+ext,shortCircuit:true};}
  return next(specifier,context);
 },
 load(url,context,next){
  if(url==='totp:bridge')return {format:'module',shortCircuit:true,source:`export const invoke=(...args)=>globalThis.transport(...args);export const events={emit:async()=>{}};export const router={open:async()=>{}};`};
  if(url==='totp:qr')return {format:'module',shortCircuit:true,source:`import React from '${reactURL}';export function QRCodeSVG({value}){return React.createElement('svg',{'data-qr':value});}`};
  if(url.startsWith('totp:kit/'))return {format:'module',shortCircuit:true,source:`import React from '${reactURL}'; export default function Kit({children,onClick,isDisabled,disabled,title,...props}){const kind='${url.split('/').at(-1)}';if(kind==='textfield')return React.createElement('input',{...props,disabled:isDisabled||disabled});if(kind==='button')return React.createElement('button',{onClick,disabled:isDisabled||disabled},children);return React.createElement('div',{},title?React.createElement('h4',{},title):null,children);}`};
  if(/\.tsx?$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
  return next(url,context);
 }
});
const {default:React,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const TotpEnrollment=(await import('../src/totp/TotpEnrollment.tsx')).default;
hooks.deregister();
let root,container;
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
async function mount(invoke){const calls=[];globalThis.transport=(key,payload)=>{calls.push(key);return key==='harness:logAction'?Promise.resolve({ok:true}):invoke(key,payload);};container=document.createElement('div');document.body.append(container);root=createRoot(container);await act(()=>root.render(React.createElement(TotpEnrollment)));await flush();return calls;}
afterEach(async()=>{if(root)await act(()=>root.unmount());container?.remove();root=null;});
const text=()=>container.textContent;
const button=label=>[...container.querySelectorAll('button')].find(b=>b.textContent.includes(label));
const status=extra=>({success:true,state:'ACTIVE',isEnrolled:true,resetGrant:null,administrators:['Priya Naik'],onlyAdministrator:false,...extra});

test('an active authenticator without a reset grant does not offer a replacement the server will refuse',async()=>{
 const calls=await mount(key=>Promise.resolve(status()));
 assert.equal(Boolean(button('Set up a new authenticator')),false);
 assert.match(text(),/Priya Naik/);assert.match(text(),/Credentials & recovery/);
 await act(()=>button('Check again').click());await flush();
 assert.equal(calls.filter(k=>k==='totp:checkStatus').length,2);assert.equal(calls.includes('totp:enrol'),false);
});
test('a reset grant unlocks replacing an active authenticator',async()=>{
 const calls=await mount(key=>key==='totp:enrol'?Promise.resolve({success:true,uri:'otpauth://totp/x'}):Promise.resolve(status({resetGrant:{expiresAt:Date.now()+3600000}})));
 assert.match(text(),/authorized/i);
 await act(()=>button('Set up a new authenticator').click());await flush();
 assert.ok(calls.includes('totp:enrol'));assert.equal(Boolean(container.querySelector('[data-qr]')),true);
});
test('a locked authenticator can be set up again once a reset is granted',async()=>{
 const calls=await mount(key=>key==='totp:enrol'?Promise.resolve({success:true,uri:'otpauth://totp/x'}):Promise.resolve(status({state:'LOCKED',isEnrolled:false,resetGrant:{expiresAt:Date.now()+3600000}})));
 assert.doesNotMatch(text(),/Lockouts/);
 await act(()=>button('Set up my authenticator again').click());await flush();
 assert.ok(calls.includes('totp:enrol'));
});
test('a locked authenticator without a grant points at the real recovery page',async()=>{
 await mount(()=>Promise.resolve(status({state:'LOCKED',isEnrolled:false})));
 assert.doesNotMatch(text(),/Lockouts/);assert.match(text(),/Credentials & recovery/);assert.equal(Boolean(button('Set up my authenticator again')),false);
});
test('the only administrator is told to appoint a second one',async()=>{
 await mount(()=>Promise.resolve(status({administrators:[],onlyAdministrator:true})));
 assert.match(text(),/only VAtlassian administrator/);assert.match(text(),/Administrators/);
});
test('first-time setup still starts straight away',async()=>{
 const calls=await mount(key=>key==='totp:enrol'?Promise.resolve({success:true,uri:'otpauth://totp/x'}):Promise.resolve({success:true,state:'NONE',isEnrolled:false}));
 await act(()=>button('Set up my authenticator').click());await flush();
 assert.ok(calls.includes('totp:enrol'));assert.equal(Boolean(container.querySelector('[data-qr]')),true);
});
