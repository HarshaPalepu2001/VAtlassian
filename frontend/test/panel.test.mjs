import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window();
Object.assign(globalThis, {window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const hooks=registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@forge/bridge')return {url:'panel:bridge',shortCircuit:true};
  if(specifier.startsWith('@atlaskit/'))return {url:'panel:button',shortCircuit:true};
  if(specifier.startsWith('.')){
   const url=new URL(specifier,context.parentURL);
   for(const extension of ['.ts','.tsx'])if(fs.existsSync(fileURLToPath(url)+extension))return {url:url.href+extension,shortCircuit:true};
  }
  return next(specifier,context);
 },
 load(url,context,next){
  if(url==='panel:bridge')return {format:'module',shortCircuit:true,source:`
   export const invoke=(...args)=>globalThis.panelTransport.invoke(...args);
   export const events={on:async(name,cb)=>globalThis.panelTransport.on(name,cb),emit:async(...args)=>globalThis.panelTransport.emitted.push(args)};
   export const view={refresh:async()=>{}};export const router={open:async()=>{}};`};
  if(url==='panel:button')return {format:'module',shortCircuit:true,source:`
   import React from '${new URL('../node_modules/react/index.js',import.meta.url).href}';
   export default function Button({children,onClick,isDisabled}){return React.createElement('button',{onClick,disabled:isDisabled},children);}`};
  if(/\.tsx?$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
  return next(url,context);
 }
});
const {default:React,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {default:IssuePanel}=await import('../src/panel/IssuePanel.tsx');
const {default:ApprovalControls}=await import('../src/panel/sections/ApprovalControls.tsx');
const {default:IssueContext}=await import('../src/context/IssueContext.tsx');
const {invoke}=await import('../src/lib/bridge.ts');
const {default:RestoreStatus}=await import('../src/panel/sections/RestoreStatus.tsx');
hooks.deregister();
let root,container;
afterEach(async()=>{if(root)await act(()=>root.unmount());container?.remove();root=null;});
function setup(handler){
 const listeners=new Map();const subscribers=new Map();
 globalThis.panelTransport={emitted:[],invoke:handler,on:(name,cb)=>{if(!subscribers.has(name))subscribers.set(name,new Set());const callbacks=subscribers.get(name);callbacks.add(cb);listeners.set(name,payload=>{for(const fn of callbacks)fn(payload);});return {unsubscribe:()=>{callbacks.delete(cb);if(!callbacks.size)listeners.delete(name);}};}};
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 return listeners;
}
const state=(summary='Current record')=>({issue:{key:'T-1',summary},eligibility:{eligible:false},approval:{requiredAssurance:'ESIGNATURE'},drift:{count:0,fields:[],evidenceHash:summary},transitions:[],controls:{incidents:[],gateFindings:[]}});
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
const refreshButton=()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Refresh');
test('initial load failure leaves a working Refresh control at the top',async()=>{
 let failure=true;let reads=0;
 setup(async key=>{if(key==='panel:getState'){reads++;if(failure)throw new Error('Temporary service failure');return state();}return {restores:[]};});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(container.textContent,/Temporary service failure/);assert.ok(refreshButton());
 failure=false;await act(()=>refreshButton().click());await flush();
 assert.ok(reads>=2);assert.doesNotMatch(container.textContent,/Temporary service failure/);
});
test('a rendering crash cannot remove Refresh and clicking it recovers the panel',async()=>{
 let broken=true;
 setup(async key=>key==='panel:getState'?{...state(),controls:broken?{incidents:[],gateFindings:[{detail:{bad:'cannot render object'}}]}:{incidents:[],gateFindings:[]}}:{restores:[]});
 const original=console.error;console.error=()=>{};
 try{
  await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
  assert.ok(refreshButton(),'Refresh must survive a child render error');
  broken=false;await act(()=>refreshButton().click());await flush();
  assert.match(container.textContent,/eligible approval role/);
 }finally{console.error=original;}
});
test('Jira issue changes reload the displayed data and unsubscribe on unmount',async()=>{
 let reads=0;
 const listeners=setup(async key=>key==='panel:getState'?{...state(),eligibility:{eligible:false,reason:`read ${++reads}`}}:{restores:[]});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(container.textContent,/read 1/);
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')({issueKey:'T-1'}));await flush();
 assert.match(container.textContent,/read 2/);
 await act(()=>root.unmount());root=null;assert.equal(listeners.size,0);
});
test('a decision in another app surface refreshes this panel',async()=>{
 let reads=0;
 const listeners=setup(async key=>key==='panel:getState'?{...state(),eligibility:{eligible:false,reason:`read ${++reads}`}}:{restores:[]});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(listeners.has('VA_ISSUE_CHANGED'));
 await act(()=>listeners.get('VA_ISSUE_CHANGED')({issueKey:'T-1'}));await flush();
 assert.match(container.textContent,/read 2/);
});

test('the signing screen displays the exact meaning returned by the server challenge',async()=>{
 setup(async key=>key==='signature:challenge'?{success:true,challengeId:'id',nonce:'nonce',meaning:'I reject and restore the approved record',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000}:{});
 const data={...state(),eligibility:{eligible:true},drift:{count:1,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',eligible:true,requiredAssurance:'ESIGNATURE',meaning:'Different transition declaration'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));
 await act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Reject and restore').click());
 assert.match(container.textContent,/I reject and restore the approved record/);
 assert.doesNotMatch(container.textContent,/Different transition declaration/);
});

test('an older panel request cannot overwrite newer issue data',async()=>{
 const pending=[];
 const listeners=setup(key=>key==='panel:getState'?new Promise(resolve=>pending.push(resolve)):Promise.resolve({restores:[]}));
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());
 assert.equal(pending.length,2);
 await act(()=>pending[1]({...state(),eligibility:{eligible:false,reason:'Newest data'}}));
 await act(()=>pending[0]({...state(),eligibility:{eligible:false,reason:'Obsolete data'}}));
 assert.match(container.textContent,/Newest data/);assert.doesNotMatch(container.textContent,/Obsolete data/);
});
test('the issue status display updates to v2 after a decision event',async()=>{
 let version=1;
 const listeners=setup(async()=>({state:'BASELINED',baselineVersion:version}));
 await act(()=>root.render(React.createElement(IssueContext)));await flush();
 assert.match(container.textContent,/Version 1/);version=2;
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();
 assert.match(container.textContent,/Version 2/);
});
test('approval and restore resolver outcomes notify other open app views',async()=>{
 setup(async()=>({success:true}));
 for(const key of ['signature:submit','approval:submit','approval:retryTransition','restore:retry']){
  await invoke(key,{issueKey:'T-1'});
 }
 assert.equal(globalThis.panelTransport.emitted.length,4);
 assert.deepEqual(globalThis.panelTransport.emitted[0],['VA_ISSUE_CHANGED',{issueKey:'T-1'}]);
});

test('restore completion refreshes even when the issue content hash is unchanged',async()=>{
 let restoreState='PENDING';
 const listeners=setup(async()=>({restores:[{restore_id:'id',state:restoreState}]}));
 await act(()=>root.render(React.createElement(RestoreStatus,{issueKey:'T-1',revision:'same'})));await flush();
 assert.match(container.textContent,/Restore in progress/);restoreState='COMPLETE';
 assert.ok(listeners.has('VA_ISSUE_CHANGED'));
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();
 assert.match(container.textContent,/Restored and verified/);
});
test('a reviewer eligible for the selected workflow edge can approve independently of the old baseline role',async()=>{
 setup(async()=>({success:true,challengeId:'id',nonce:'nonce',meaning:'Approve this edge',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000}));
 const data={...state(),eligibility:{eligible:false},drift:{count:1,evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',eligible:true,requiredAssurance:'ESIGNATURE',meaning:'Approve this edge'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));
 const approve=[...container.querySelectorAll('button')].find(b=>b.textContent==='Approve changes');
 assert.ok(approve);assert.equal(approve.disabled,false);
 const reject=[...container.querySelectorAll('button')].find(b=>b.textContent==='Reject and restore');
 assert.equal(reject.disabled,true);
 await act(()=>approve.click());assert.match(container.textContent,/Approve this edge/);
});
