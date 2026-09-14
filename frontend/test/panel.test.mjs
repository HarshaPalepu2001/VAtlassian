import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({url:'https://tenant.atlassian.net/panel/index.html'});
Object.assign(globalThis, {window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
// src/ui-kit/edit.jsx lives outside the frontend package and would otherwise
// load the root React 18 copy; one React instance is required for hooks.
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
  // A DOM stand-in for the UI Kit components edit.jsx uses. It renders every
  // prop that carries meaning, so a selector or checkbox cannot hide.
  if(url==='panel:forge-react')return {format:'module',shortCircuit:true,source:`
   import React from '${frontendReact('react')}';
   const h=React.createElement;
   const wrap=(tag,className)=>({children})=>h(tag,{className},children);
   export const Box=wrap('div','uk-box');export const Inline=wrap('div','uk-inline');export const Stack=wrap('div','uk-stack');
   export const Text=wrap('span','uk-text');export const Heading=wrap('h4','uk-heading');export const Lozenge=wrap('span','uk-lozenge');
   export const SectionMessage=({children,appearance})=>h('div',{className:'uk-section uk-section--'+appearance},children);
   export const Spinner=()=>h('span',{className:'uk-spinner'});
   export const Checkbox=({isChecked,onChange,label})=>h('label',{className:'uk-checkbox'},h('input',{type:'checkbox',checked:!!isChecked,onChange}),label);
   export const Textfield=({value,onChange,isDisabled,name})=>h('input',{className:'uk-textfield',name,value,onChange,disabled:isDisabled});
   export const Select=()=>h('select',{className:'uk-select'});
   export const CustomFieldEdit=({children})=>h('div',{className:'uk-field'},children);
   export const useProductContext=()=>globalThis.panelTransport?.context;
   export default {render:element=>{globalThis.uiKitEdit=element;}};`};
  if(/\.(tsx?|jsx)$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(url),'utf8'),{fileName:fileURLToPath(url),compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
  return next(url,context);
 }
});
const {default:React,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {default:IssuePanel}=await import('../src/panel/IssuePanel.tsx');
const {default:ApprovalControls}=await import('../src/panel/sections/ApprovalControls.tsx');
const {default:usePanelState}=await import('../src/panel/usePanelState.ts');
const {default:IssueContext}=await import('../src/context/IssueContext.tsx');
const {invoke}=await import('../src/lib/bridge.ts');
const {approvalMode}=await import('../src/lib/assurance.ts');
const {default:RestoreStatus}=await import('../src/panel/sections/RestoreStatus.tsx');
const {default:ApprovalField}=await import('../src/field/ApprovalField.tsx');
const {default:QueueList}=await import('../src/queue/QueueList.tsx');
const {default:TransitionsPage}=await import('../src/admin/pages/TransitionsPage.tsx');
await import('../../src/ui-kit/edit.jsx');
const UiKitEdit=globalThis.uiKitEdit;
const deviceAuth=await import('../src/panel/deviceAuth.ts');
hooks.deregister();

// A device window closed without answering must be noticed as soon as the
// reviewer comes back to this frame — by focus, visibility, or a click — not
// by a polling timer and not only after the ceremony's long deadline.
test('closing the device window without an answer is detected when the reviewer returns, without polling',async()=>{
 const originalOpen=window.open;
 try{
  for(const [target,type] of [[window,'focus'],[document,'visibilitychange'],[document,'pointerdown']]){
   let popup;
   window.open=()=>(popup={closed:false,close(){popup.closed=true;},postMessage(){}});
   globalThis.panelTransport={emitted:[],submitted:[],invoke:async key=>key==='webauthn:assertStart'?{ok:true,challengeId:'wa-1',options:{challenge:'abc'}}:{},on:()=>({unsubscribe(){}})};
   const outcome=deviceAuth.confirmBiometric({approvalChallengeId:'c'.repeat(32)});
   await new Promise(r=>setTimeout(r,0));
   popup.closed=true;
   target.dispatchEvent(new window.Event(type));
   const result=await Promise.race([outcome,new Promise(r=>setTimeout(()=>r('still waiting'),0))]);
   assert.notEqual(result,'still waiting',`a closed device window must be noticed on ${type}`);
   assert.equal(result.ok,false);
   assert.match(result.error,/did not complete/);
  }
 }finally{window.open=originalOpen;}
});
let root,container;
const openWindow=window.open;
afterEach(async()=>{if(root)await act(()=>root.unmount());container?.remove();root=null;window.open=openWindow;});
// Stands in for the top-level device window: it announces itself, accepts the
// ceremony options, and answers with whatever the authenticator would have said.
function stubCeremony(outcome={success:true,response:{id:'cred-1',rawId:'cred-1'}}){
 const seen={opened:[],action:null,optionsJSON:null};
 window.open=url=>{
  seen.opened.push(String(url));
  const popup={closed:false,close(){popup.closed=true;},postMessage(data){
   if(!data||data.type!=='webauthn-options')return;
   seen.action=data.action;seen.optionsJSON=data.optionsJSON;
   setTimeout(()=>window.postMessage({type:'webauthn-result',...outcome},window.location.origin),0);
  }};
  setTimeout(()=>window.postMessage({type:'webauthn-ready'},window.location.origin),0);
  return popup;
 };
 return seen;
}
// A device window that opens and then says nothing, so a test can observe the
// state while the ceremony is still in progress.
function silentCeremony(){window.open=()=>({closed:false,close(){},postMessage(){}});}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
// React tracks a controlled input's value, so assigning `.value` directly is
// swallowed. Go through the native setter the way a real keystroke does.
const typeInto=(input,value)=>{
 Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);
 input.dispatchEvent(new window.Event('input',{bubbles:true}));
};
const selectValue=(select,value)=>{
 Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(select,value);
 select.dispatchEvent(new window.Event('change',{bubbles:true}));
};
const h=(type,props)=>React.createElement(type,props);
const text=()=>container.textContent;
const clickButton=label=>[...container.querySelectorAll('button')].find(b=>label instanceof RegExp?label.test(b.textContent):b.textContent===label);
const fieldSelect=label=>[...container.querySelectorAll('.va-field')].find(f=>f.querySelector('.va-label')?.textContent===label)?.querySelector('select');
const refreshButton=()=>clickButton('Refresh');
const affirm=()=>container.querySelector('.va-affirm input');
const codeBox=()=>container.querySelector('.va-code');
const liveStatus=()=>container.querySelector('[role="status"][aria-live="polite"]');
const disclosure=()=>[...container.querySelectorAll('.va-collapse')].find(b=>/tracked field/i.test(b.textContent));
function setup(handler,{context={extension:{issue:{key:'T-1',id:'10'}}},loopback=false}={}){
 const listeners=new Map();const subscribers=new Map();
 globalThis.panelTransport={emitted:[],submitted:[],context,invoke:handler,
  on:(name,cb)=>{if(!subscribers.has(name))subscribers.set(name,new Set());const callbacks=subscribers.get(name);callbacks.add(cb);listeners.set(name,payload=>{for(const fn of callbacks)fn(payload);});return {unsubscribe:()=>{callbacks.delete(cb);if(!callbacks.size)listeners.delete(name);}};},
  // An app event can echo back to the view that emitted it.
  deliver:loopback?(name,payload)=>listeners.get(name)?.(payload):undefined};
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 return listeners;
}

// ── Summary fixtures ──────────────────────────────────────────────────────
// Matches src/usecases/panelSummary.js's getSummary() payload exactly.
function summary(over={}){
 return {
  issue:{id:'1',key:'T-1',summary:'Current record',status:{id:'3',name:'In Progress',statusCategory:{key:'indeterminate'}}},
  controlled:true,tier:'observer',state:'Waiting on signature',actorName:null,
  eligibility:{eligible:false,reason:null},credentialEnrolled:undefined,
  transitions:[],baseline:null,latestApproval:null,
  drift:{count:0,materialCount:0,decidesDrift:false,policyIncomplete:false,canApprove:false,canReject:false},
  restore:null,approval:{requiredRole:null,requiredAssurance:null,meaning:null,pending:null},
  ...over
 };
}
const actor=(transitions=[],over={})=>summary({tier:'actor',eligibility:{eligible:true,reason:null},transitions,...over});
function transition(over={}){
 return {transitionId:'5',toStatusId:'2',toStatusName:'Done',name:'Done',meaning:'Approved',requiredRole:'QA',requiredAssurance:'ESIGNATURE',capturesBaseline:false,blocksOnDrift:false,anyStatus:false,label:'Sign to move to Done',canApprove:true,...over};
}
const blocked=(over={})=>transition({transitionId:'6',toStatusId:'3',toStatusName:'Blocked',name:'Block',label:'Sign to move to Blocked',...over});
function evidence(over={}){
 return {baselineId:'ab'.repeat(8),baselineVersion:1,evidenceHash:'hash-1',description:'',descriptionEmpty:true,descriptionTruncated:false,
  record:{version:1,approvedName:'Priya',approvedAt:1000,fieldCount:1,retainedCount:1,fields:[{fieldId:'summary',fieldName:'Summary',retained:true,digest:'d1',preview:{text:'hi'}}]},
  drift:{fields:[]},rejection:{deleteIssueKeys:[],recreateCount:0},restoreHistory:[],...over};
}
const evidenceWithField=(fieldName,over={})=>evidence({record:{...evidence().record,fields:[{fieldId:fieldName,fieldName,retained:true,digest:'d',preview:{text:'value'}}]},...over});
function baseline(over={}){
 return {baselineId:'ab'.repeat(8),version:1,approvedName:'Priya',transitionAt:1000,capturedAt:1000,assuranceLevel:'ESIGNATURE',fidelity:'EXACT',nodeCount:1,edgeCount:0,totalFieldCount:1,treeHash:null,policyIncomplete:false,...over};
}
const driftOn=(over={})=>({count:1,materialCount:1,decidesDrift:true,policyIncomplete:false,canApprove:true,canReject:true,...over});
const challengeOk=(over={})=>({success:true,challengeId:'c'.repeat(32),nonce:'n',meaning:'Approved',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000,...over});
// Signs the open challenge with an authenticator code.
async function signWithCode(code='123456'){
 await act(()=>affirm().click());
 await act(()=>typeInto(codeBox(),code));
 await act(()=>clickButton('Sign and approve').click());
}

// ── Useful shell, compact summary, refresh ────────────────────────────────

test('the panel paints issue identity from Forge context and labelled skeleton rows before any request completes',async()=>{
 const pending=deferred();
 setup(key=>key==='panel:getSummary'?pending.promise:Promise.resolve({restores:[]}),{context:{extension:{issue:{key:'T-9',id:'9'}}}});
 await act(()=>root.render(h(IssuePanel)));
 for(const label of ['Control state','Latest baseline','Latest approval','Available actions'])assert.match(text(),new RegExp(label),`missing skeleton row: ${label}`);
 assert.ok(container.querySelector('[aria-busy="true"]'),'the loading shell must announce that it is busy');
 assert.doesNotMatch(text(),/undefined/);
 await flush();
 assert.match(text(),/T-9/,'issue identity from Forge context must appear while the summary is still in flight');
 await act(()=>pending.resolve(summary()));await flush();
 assert.equal(container.querySelector('[aria-busy="true"]'),null);
});

test('initial load failure leaves a working Refresh control at the top',async()=>{
 let failure=true;let reads=0;
 setup(async key=>{if(key==='panel:getSummary'){reads++;if(failure)throw new Error('Temporary service failure');return summary();}return {restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Temporary service failure/);assert.ok(refreshButton());
 failure=false;await act(()=>refreshButton().click());await flush();
 assert.ok(reads>=2);assert.doesNotMatch(text(),/Temporary service failure/);
});

test('a failed summary keeps the labelled shell visible and recovers through a scoped retry',async()=>{
 let failure=true;let reads=0;
 setup(async key=>{if(key==='panel:getSummary'){reads++;if(failure)throw new Error('Temporary service failure');return summary({state:'Recovered state'});}return {restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Temporary service failure/);
 assert.match(text(),/Control state/,'the useful shell must stay visible when the summary fails');
 failure=false;await act(()=>clickButton('Try again').click());await flush();
 assert.equal(reads,2);
 assert.doesNotMatch(text(),/Temporary service failure/);
 assert.match(text(),/Recovered state/);
});

test('a rendering crash cannot remove Refresh and clicking it recovers the panel',async()=>{
 let broken=true;
 setup(async key=>key==='panel:getSummary'?{...summary(),adminIncidentCount:broken?{bad:'cannot render object'}:1}:{restores:[]});
 const original=console.error;console.error=()=>{};
 try{
  await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
  assert.ok(refreshButton(),'Refresh must survive a child render error');
  broken=false;await act(()=>refreshButton().click());await flush();
  assert.match(text(),/workflow control incident/i);
 }finally{console.error=original;}
});

test('summary loading uses panel:getSummary and never the retired monolithic resolver',async()=>{
 const calls=[];
 setup(async key=>{calls.push(key);return key==='panel:getSummary'?summary():{restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(calls.includes('panel:getSummary'));
 assert.ok(!calls.includes('panel:getState'),'the frontend must not call the retired panel:getState resolver');
});

test('Jira issue changes reload the displayed data and unsubscribe on unmount',async()=>{
 let reads=0;
 const listeners=setup(async key=>key==='panel:getSummary'?summary({state:`read ${++reads}`}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/read 1/);
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')({issueKey:'T-1'}));await flush();
 assert.match(text(),/read 2/);
 await act(()=>root.unmount());root=null;assert.equal(listeners.size,0);
});

test('a decision in another app surface refreshes this panel',async()=>{
 let reads=0;
 const listeners=setup(async key=>key==='panel:getSummary'?summary({state:`read ${++reads}`}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(listeners.has('VA_ISSUE_CHANGED'));
 await act(()=>listeners.get('VA_ISSUE_CHANGED')({issueKey:'T-1'}));await flush();
 assert.match(text(),/read 2/);
});

test('window focus reloads the panel without any polling interval',async()=>{
 let reads=0;
 setup(async key=>key==='panel:getSummary'?summary({state:`read ${++reads}`}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/read 1/);
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.match(text(),/read 2/);
});

test('returning to a visible document refreshes, and a hidden document does not',async()=>{
 let reads=0;let visibility='visible';
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
 try{
  setup(async key=>key==='panel:getSummary'?summary({state:`read ${++reads}`}):{restores:[]});
  await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
  visibility='hidden';await act(()=>document.dispatchEvent(new window.Event('visibilitychange')));await flush();
  assert.equal(reads,1,'a hidden document must not refresh');
  visibility='visible';await act(()=>document.dispatchEvent(new window.Event('visibilitychange')));await flush();
  assert.equal(reads,2);assert.match(text(),/read 2/);
 }finally{delete document.visibilityState;}
});

test('no production interval timer exists under frontend/src',()=>{
 const sourceRoot=fileURLToPath(new URL('../src',import.meta.url));
 const offenders=[];
 (function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())walk(full);
   else if(/\.(ts|tsx|js|jsx)$/.test(entry.name)&&/\bsetInterval\s*\(/.test(fs.readFileSync(full,'utf8')))offenders.push(full);
  }
 })(sourceRoot);
 assert.deepEqual(offenders,[],`setInterval must not appear in production frontend source: ${offenders.join(', ')}`);
});

test('simultaneous refresh triggers coalesce into one in-flight request, then catch up to the latest',async()=>{
 const pending=[];let calls=0;
 const listeners=setup(key=>{if(key!=='panel:getSummary')return Promise.resolve({restores:[]});calls++;const d=deferred();pending.push(d);return d.promise;});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));
 await act(()=>{listeners.get('JIRA_ISSUE_CHANGED')();listeners.get('VA_ISSUE_CHANGED')();window.dispatchEvent(new window.Event('focus'));});
 assert.equal(calls,1,'concurrent triggers must not open a second request while one is already in flight');
 await act(()=>pending[0].resolve(summary({state:'first read'})));await flush();
 assert.match(text(),/first read/);
 assert.equal(calls,2,'a trigger that arrived mid-flight must still be honoured once the current request settles');
 await act(()=>pending[1].resolve(summary({state:'second read'})));await flush();
 assert.match(text(),/second read/);
 assert.equal(calls,2,'the triggers collapse into exactly one follow-up');
});

function SummaryProbe({issueKey}){const {state,error}=usePanelState(issueKey);return h('p',{children:state?state.state:error||'loading'});}

test('an older summary response cannot replace a newer one',async()=>{
 const requests=[];
 setup((key,payload)=>{if(key!=='panel:getSummary')return Promise.resolve({});const d=deferred();requests.push({payload,...d});return d.promise;});
 await act(()=>root.render(h(SummaryProbe,{issueKey:'T-1'})));
 await act(()=>root.render(h(SummaryProbe,{issueKey:'T-2'})));
 assert.deepEqual(requests.map(r=>r.payload.issueKey),['T-1','T-2'],'the newer issue must be requested at once, not queued behind the older read');
 await act(()=>requests[1].resolve(summary({state:'newer T-2'})));await flush();
 await act(()=>requests[0].resolve(summary({state:'older T-1'})));await flush();
 assert.equal(text(),'newer T-2');
 assert.equal(requests.length,2,'the older read must not trigger a follow-up request for the old issue');
});

test('async completions after unmount are ignored safely',async()=>{
 const summaryRead=deferred();const evidenceRead=deferred();const errors=[];
 const original=console.error;console.error=(...args)=>errors.push(args);
 try{
  setup(key=>key==='panel:getSummary'?summaryRead.promise:key==='panel:getEvidence'?evidenceRead.promise:Promise.resolve({restores:[]}));
  await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));
  await act(()=>root.unmount());root=null;
  summaryRead.resolve(actor([],{baseline:baseline(),drift:driftOn()}));evidenceRead.resolve(evidence());
  await flush();
  assert.deepEqual(errors,[]);
 }finally{console.error=original;}
});

// ── Facts every viewer sees; zero / one / many actions ────────────────────

test('an ineligible observer sees control, scope, role, method, policy, baseline, approval, and restoration facts but no decision control',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({tier:'observer',state:'Waiting on a signature from QA',
  transitions:[transition({canApprove:false,capturesBaseline:true,blocksOnDrift:true,requiredAssurance:'BIOMETRIC'})],
  baseline:baseline({approvedName:'Priya',version:3,assuranceLevel:'ESIGNATURE',totalFieldCount:12}),
  latestApproval:{decision:'REJECT',state:'CONSUMED',actorName:'Sam',decidedAt:500,transitionId:'5'},
  restore:{restoreId:'r1',state:'COMPLETE',attempted:1,succeeded:1,failed:0,skipped:0}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 const t=text();
 assert.match(t,/Waiting on a signature from QA/,'control state');
 assert.match(t,/Current status\s*In Progress/,'current Jira status');
 assert.match(t,/In Progress -> Done/,'exact transition scope and destination');
 assert.match(t,/QA/,'required role');
 assert.match(t,/Biometric approval/,'required signing method');
 assert.match(t,/Captures a new baseline/,'baseline capture policy');
 assert.match(t,/Blocked while changes are unapproved/,'drift policy');
 assert.match(t,/Priya/);assert.match(t,/Version 3/);assert.match(t,/Electronic signature/);assert.match(t,/12 tracked fields/);
 assert.match(t,/Sam/,'latest approval owner');assert.match(t,/Rejected/,'latest approval outcome');
 assert.match(t,/Restored and verified/,'restoration state');
 assert.match(t,/only QA can approve/,'a clear explanation replaces the controls');
 assert.equal(clickButton(/^Approve/),undefined);assert.equal(clickButton(/Reject/),undefined);
});

test('an observer sees the living state sentence instead of decision action buttons',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({tier:'observer',state:'Waiting on a signature from SDE-1'}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Waiting on a signature from SDE-1/);
 assert.equal(clickButton('Approve'),undefined,'no approve button for observer');
 assert.equal(clickButton(/Reject/i),undefined,'no reject button for observer');
});

test('zero applicable actions renders the controlled facts with no enabled approval control',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({tier:'observer',transitions:[transition({canApprove:false,requiredRole:'QA'})]}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/QA/,'the required role must still be visible');
 assert.equal(clickButton(/Approve/),undefined);
 assert.equal(fieldSelect('Approval transition'),undefined);
});

test('exactly one applicable action is shown directly, without a selector, labelled "Approve -> destination"',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([transition(),transition({transitionId:'8',canApprove:false,toStatusName:'Rejected',label:'Sign to move to Rejected'})]):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.equal(fieldSelect('Approval transition'),undefined,'a single applicable action must never show a selector');
 assert.ok(clickButton('Approve -> Done'));
 assert.equal(clickButton('Approve -> Rejected'),undefined,'an action the viewer cannot perform is a fact, not a control');
});

test('two or more applicable actions show a selector, and every eligible control is visible without a disclosure',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([transition(),blocked()],{approval:{requiredRole:null,requiredAssurance:null,meaning:null,pending:{approvalId:'p'.repeat(32),transitionId:'5',state:'PENDING'}}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 const select=fieldSelect('Approval transition');
 assert.ok(select,'two applicable actions must show a selector');
 assert.deepEqual([...select.querySelectorAll('option')].map(o=>o.value).filter(Boolean),['5','6']);
 const retry=clickButton('Retry transition');
 assert.ok(retry,'a resumable transition is offered directly');
 assert.equal(retry.closest('details'),null,'no eligible control may sit behind a disclosure');
 assert.equal(select.closest('details'),null);
 await act(()=>selectValue(select,'6'));
 const approve=clickButton('Approve -> Blocked');
 assert.ok(approve);assert.equal(approve.closest('details'),null);
});

test('My Approvals embeds the same panel, including the selector for two applicable actions',async()=>{
 setup(async key=>{
  if(key==='queue:list')return {success:true,items:[{issueId:'1',issueKey:'T-1',summary:'Current record',status:'In Progress',state:'x',baselineVersion:0,driftCount:0,materialCount:0}]};
  if(key==='panel:getSummary')return actor([transition(),blocked()]);
  return {restores:[]};
 });
 await act(()=>root.render(h(QueueList)));await flush();
 await act(()=>clickButton('Review').click());await flush();
 assert.ok(fieldSelect('Approval transition'),'My Approvals must render the shared selector');
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 assert.ok(clickButton('Approve -> Done'));
});

test('wildcard and directed controls landing on the same destination display different exact scope labels',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([
  transition({transitionId:'5',anyStatus:false}),
  transition({transitionId:'6',name:'Fast-track',anyStatus:true})
 ]):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 const options=[...fieldSelect('Approval transition').querySelectorAll('option')].filter(o=>o.value);
 const byValue=Object.fromEntries(options.map(o=>[o.value,o.textContent]));
 assert.ok(byValue['5'].startsWith('In Progress -> Done'),byValue['5']);
 assert.ok(byValue['6'].startsWith('Any status -> Done'),byValue['6']);
 assert.ok(options.every(o=>o.textContent.includes('Sign to move to Done')),'options use transition.label');
});

test('two sibling transitions into the same status stay distinguishable and sign with their exact ids',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signature:challenge'?challengeOk():{};});
 const data=actor([transition({transitionId:'5',name:'Done'}),transition({transitionId:'7',name:'Close as fixed'})]);
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));
 const select=fieldSelect('Approval transition');
 const options=[...select.querySelectorAll('option')].filter(o=>o.value);
 assert.deepEqual(options.map(o=>o.value),['5','7']);
 assert.equal(new Set(options.map(o=>o.textContent)).size,2,'identical destinations must not collapse into identical labels');
 assert.equal(clickButton('Approve -> Done'),undefined,'with two siblings nothing is chosen on the reviewer\'s behalf');
 await act(()=>selectValue(select,'7'));
 await act(()=>clickButton('Approve -> Done').click());await flush();
 const challenge=calls.find(([k])=>k==='signature:challenge');
 assert.equal(challenge[1].transitionId,'7');
});

test('drift decisions are labelled exactly "Approve changes" and "Reject and restore"',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([],{baseline:baseline(),drift:driftOn({count:2,materialCount:2})}):key==='panel:getEvidence'?evidence():{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(clickButton('Approve changes'));
 assert.ok(clickButton('Reject and restore'));
 assert.equal(clickButton(/^Reject$/),undefined,'the label must never be shortened to plain "Reject"');
});

// Approving drift captures a new baseline and rejecting restores the old one;
// neither is a workflow move, so an empty `transitions` must still leave both
// decisions reachable.
test('a change since approval is decidable even when no transition is offered',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([],{state:'Changes since approval need a decision',baseline:baseline(),drift:driftOn()}):key==='panel:getEvidence'?evidence():{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/1 change since approval/);
 assert.ok(clickButton('Approve changes'),'the drift decision must be reachable');
 assert.ok(clickButton(/Reject and restore/i),'and so must its refusal');
 assert.doesNotMatch(text(),/Nothing needs a signature/);
});

test('baseline, approval, drift, and restoration "not yet available" states render deliberately',async()=>{
 const calls=[];
 setup(async key=>{calls.push(key);return key==='panel:getSummary'?summary({controlled:false,state:'Nothing needs a signature at this status'}):{restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/No baseline has been captured yet/);
 assert.match(text(),/No approval has been recorded/);
 assert.match(text(),/Not tracked until a baseline is captured/);
 assert.match(text(),/No restoration has run/);
 assert.match(text(),/Not controlled/);
 assert.ok(!calls.includes('restore:getState'),'restoration detail is only read when the summary reports a restoration');
});

test('admin-only incident detail is never shown to an ordinary user, and is shown as a count-only fact to an admin',async()=>{
 setup(async key=>key==='panel:getSummary'?summary():{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.doesNotMatch(text(),/workflow control incident/i);
 assert.doesNotMatch(text(),/Workflow protection needs attention/);
 await act(()=>root.unmount());root=null;
 setup(async key=>key==='panel:getSummary'?summary({adminIncidentCount:2}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/2 workflow control incidents/i);
});

test('a reviewer eligible for the offered edge can approve independently of the old baseline role',async()=>{
 setup(async()=>challengeOk({meaning:'Approve this edge'}));
 const data=summary({eligibility:{eligible:false},transitions:[transition({meaning:'Approve this edge'})]});
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));
 const approve=clickButton('Approve -> Done');
 assert.ok(approve);assert.equal(approve.disabled,false);
 assert.equal(clickButton('Reject and restore'),undefined);
 await act(()=>approve.click());await flush();
 assert.match(text(),/Approve this edge/);
});

test('a clean controlled transition is signed for the named move, not generic approval',async()=>{
 setup(async()=>({}));
 const data=actor([transition({name:'Selected for Development',toStatusName:'Selected for Development',label:'Sign to move to Selected for Development',meaning:'Ready for development'})]);
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));await flush();
 assert.ok(clickButton('Approve -> Selected for Development'));
 assert.match(text(),/Sign the configured transition to Selected for Development/);
 assert.ok(!clickButton('Approve'),'the button must say what transition is being signed');
});

test('the signing screen displays the exact meaning returned by the server challenge',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk({meaning:'I reject and restore the approved record'}):{});
 const data=actor([transition({meaning:'Different transition declaration'})],{baseline:baseline(),drift:driftOn()});
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));
 await act(()=>clickButton('Reject and restore').click());await flush();
 assert.match(text(),/I reject and restore the approved record/);
 assert.doesNotMatch(text(),/Different transition declaration/);
});

test('non-capturing approval never promises a baseline',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk({meaning:'Approve for release'}):{});
 const data=actor([transition({meaning:'Approve for release',capturesBaseline:false})]);
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());await settle();
 assert.doesNotMatch(text(),/baseline will be captured/i);
});

test('reject confirmation names every added descendant to be deleted, once evidence has loaded',async()=>{
 setup(async key=>{
  if(key==='panel:getSummary')return actor([transition()],{state:'Changes since approval need a decision',baseline:baseline({version:2}),drift:driftOn()});
  if(key==='panel:getEvidence')return evidence({baselineVersion:2,rejection:{deleteIssueKeys:['NEW-1','NEW-2'],recreateCount:5}});
  if(key==='signature:challenge')return challengeOk({meaning:'Reject and restore'});
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>clickButton('Reject and restore').click());await flush();
 assert.match(text(),/NEW-1, NEW-2/);
 assert.match(text(),/Recreate 5 missing nodes/i);
});

// ── Assurance modes ───────────────────────────────────────────────────────

// The server raises any policy below an electronic signature to that floor
// (MINIMUM_ASSURANCE in src/lib/approval/levels.js). A screen that does not
// mirror that shows "not configured" for an edge the server would happily sign.
test('every configured assurance level offers a signing method, matching the server floor',()=>{
 assert.equal(approvalMode('BIOMETRIC'),'biometric');
 assert.equal(approvalMode('ESIGNATURE'),'totp');
 assert.equal(approvalMode('NATIVE_TRANSITION'),'totp','workflow approval is raised to the signature floor');
 assert.equal(approvalMode('JSM_APPROVAL'),'totp','a JSM edge is served by the signature floor, not refused');
 assert.equal(approvalMode('NONSENSE'),'totp','an unreadable policy falls back to the floor, never below it');
});

test('biometric assurance is an available signing mode, not an unavailable provider',async()=>{
 setup(async key=>{
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return challengeOk({meaning:'Confirm on this device',requiredAssurance:'BIOMETRIC'});
  return {};
 });
 const data=actor([transition({requiredAssurance:'BIOMETRIC',meaning:'Confirm on this device'})]);
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));await flush();
 assert.doesNotMatch(text(),/provider is not configured/i);
 assert.ok(clickButton('Approve -> Done'));
});

const biometricSummary=()=>actor([transition({requiredAssurance:'BIOMETRIC'})]);

test('biometric signing runs the device ceremony and submits that assertion, never a signature code',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return challengeOk({meaning:'I approve this record',requiredAssurance:'BIOMETRIC'});
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  if(key==='signature:submit')return {success:true,approvalId:'a-1',transitioned:true};
  return {};});
 await act(()=>root.render(h(ApprovalControls,{summary:biometricSummary(),onDone:async()=>{}})));await settle();
 await act(()=>clickButton('Approve -> Done').click());await settle();
 await act(()=>affirm().click());await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 assert.equal(ceremony.action,'confirm','the reviewer must be asked to confirm on their device');
 assert.ok(calls.some(([k])=>k==='webauthn:assertStart'),'the assertion must be started against the open approval challenge');
 const submit=calls.find(([k])=>k==='signature:submit');
 assert.ok(submit,'the approval must still be recorded through the same signature:submit row');
 assert.equal(submit[1].webauthn?.challengeId,'wa-1');
 assert.deepEqual(submit[1].webauthn?.response,{id:'cred-1',rawId:'cred-1'});
 assert.ok(!('code' in submit[1]),'a biometric approval must not carry a signature code, which the server reads as an electronic signature');
});

test('a cancelled WebAuthn ceremony reports the refusal, records nothing, emits nothing, and leaves signing usable',async()=>{
 stubCeremony({success:false,errorName:'NotAllowedError',errorMessage:'cancelled'});const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return challengeOk({meaning:'I approve this record',requiredAssurance:'BIOMETRIC'});
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  return {};});
 await act(()=>root.render(h(ApprovalControls,{summary:biometricSummary(),onDone:async()=>{}})));await settle();
 await act(()=>clickButton('Approve -> Done').click());await settle();
 await act(()=>affirm().click());await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 assert.ok(!calls.some(([k])=>k==='signature:submit'),'a failed device check must not record an approval');
 assert.match(text(),/device check/i);
 assert.equal(globalThis.panelTransport.emitted.length,0,'a cancelled device check must not be treated as durable');
 assert.equal(liveStatus().textContent,'','no progress message may outlive the cancelled ceremony');
 assert.equal(clickButton('Sign and approve').disabled,false,'the reviewer can try the device check again');
 assert.equal(clickButton('Cancel').disabled,false);
});

test('a reviewer with no registered device is offered setup on this screen, not a dead end',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:false,usableHere:false};
  if(key==='webauthn:enrolStart')return {ok:true,challengeId:'e-1',options:{challenge:'abc'}};
  if(key==='webauthn:enrolFinish')return {ok:true,enrolled:true};
  return {};});
 await act(()=>root.render(h(ApprovalControls,{summary:biometricSummary(),onDone:async()=>{}})));await settle();
 const setupButton=clickButton(/set up/i);
 assert.ok(setupButton,'the panel must offer biometric setup when the reviewer has no registered device');
 await act(()=>setupButton.click());await settle();
 assert.equal(ceremony.action,'enrol');
 assert.ok(calls.some(([k])=>k==='webauthn:enrolFinish'),'the registration must be completed on the server');
});

test('a JSM-configured transition is signable rather than a dead end',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk({meaning:'I approve'}):{});
 const data=actor([transition({toStatusName:null,name:null,label:'Sign to move to 2',requiredAssurance:'JSM_APPROVAL'})],{approval:{requiredAssurance:'JSM_APPROVAL',pending:null}});
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));await settle();
 assert.doesNotMatch(text(),/provider is not configured/i);
 assert.ok(clickButton('Approve -> 2'),'the reviewer must be able to start the signature');
});

// ── Drift payloads carry no server-owned facts ────────────────────────────

const SERVER_OWNED=['transitionId','toStatusId','destination','requiredRole','role','requiredAssurance','assurance','provider','providerId','meaning','actorAccountId','accountId','actorName','baselineId','baselineVersion'];
function assertNoServerOwnedFacts(payload,label){
 for(const key of SERVER_OWNED)assert.equal(payload[key],undefined,`${label} must omit ${key}`);
}

test('electronic-signature drift approval and rejection carry no client-selected transition, provider, role, meaning, destination, actor, or baseline facts',async()=>{
 for(const [button,decision] of [['Approve changes','APPROVE'],['Reject and restore','REJECT']]){
  const calls=[];
  setup(async(key,payload)=>{calls.push([key,payload]);
   if(key==='signature:challenge')return challengeOk({meaning:'I decide these changes'});
   if(key==='signature:submit')return {success:true,approvalId:'a',transitioned:false};
   return {};});
  const data=actor([transition({requiredAssurance:'BIOMETRIC',meaning:'Bug done'})],{baseline:baseline(),approval:{requiredRole:'QA',requiredAssurance:'ESIGNATURE',meaning:'x',pending:null},drift:driftOn()});
  await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));await settle();
  assert.match(text(),/Review the tracked changes since baseline/);
  assert.match(text(),/Electronic signature/);
  assert.doesNotMatch(text(),/Approval transition/);
  await act(()=>clickButton(button).click());await settle();
  const challenge=calls.find(([k])=>k==='signature:challenge');
  assert.equal(challenge[1].decision,decision);
  assertNoServerOwnedFacts(challenge[1],`${decision} challenge`);
  await act(()=>affirm().click());
  await act(()=>typeInto(codeBox(),'123456'));
  await act(()=>clickButton(decision==='APPROVE'?'Sign and approve':'Sign and restore').click());await settle();
  const submit=calls.find(([k])=>k==='signature:submit');
  assert.equal(submit[1].code,'123456');
  assert.equal(submit[1].webauthn,undefined);
  assertNoServerOwnedFacts(submit[1],`${decision} submit`);
  await act(()=>root.unmount());root=null;container.remove();
 }
});

test('biometric drift decisions follow the baseline-owned assurance without signing a transition',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return challengeOk({meaning:'I approve these changes',requiredAssurance:'BIOMETRIC'});
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  if(key==='signature:submit')return {success:true,approvalId:'a',transitioned:false};
  return {};});
 const data=actor([transition({requiredAssurance:'ESIGNATURE',meaning:'Bug done'})],{baseline:baseline(),approval:{requiredRole:'QA',requiredAssurance:'BIOMETRIC',meaning:'x',pending:null},drift:driftOn()});
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));await settle();
 assert.match(text(),/Review the tracked changes since baseline/);
 assert.match(text(),/Biometric approval/);
 assert.doesNotMatch(text(),/Approval transition/);
 await act(()=>clickButton('Approve changes').click());await settle();
 assertNoServerOwnedFacts(calls.find(([k])=>k==='signature:challenge')[1],'biometric drift challenge');
 await act(()=>affirm().click());await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 assert.equal(ceremony.action,'confirm');
 const submit=calls.find(([k])=>k==='signature:submit');
 assert.equal(submit[1].webauthn?.challengeId,'wa-1');
 assert.ok(!('code' in submit[1]));
 assertNoServerOwnedFacts(submit[1],'biometric drift submit');
});

// ── Selection changes, fail-closed refresh, duplicate submission ──────────

test('switching between "In Progress -> Done" and "Any status -> Done" clears code, confirmation, challenge, evidence, and errors',async()=>{
 const calls=[];let evidenceReads=0;
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='panel:getSummary')return actor([transition({transitionId:'5',anyStatus:false}),transition({transitionId:'6',anyStatus:true,name:'Fast-track'})],{baseline:baseline()});
  if(key==='panel:getEvidence')return evidenceWithField(++evidenceReads===1?'Evidence field':'Second evidence field');
  if(key==='signature:challenge')return challengeOk({meaning:`Statement for edge ${payload.transitionId}`});
  if(key==='signature:submit')return {success:false,error:'That code was not accepted.'};
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 const optionFor=scope=>[...fieldSelect('Approval transition').querySelectorAll('option')].find(o=>o.textContent.startsWith(scope)).value;
 await act(()=>selectValue(fieldSelect('Approval transition'),optionFor('In Progress -> Done')));await flush();
 await act(()=>disclosure().click());await flush();
 assert.match(text(),/Evidence field/);
 await act(()=>clickButton('Approve -> Done').click());await flush();
 assert.match(text(),/Statement for edge 5/);
 await signWithCode();await flush();
 assert.match(text(),/That code was not accepted/);
 await act(()=>typeInto(codeBox(),'654321'));
 assert.ok(affirm().checked);
 // One change of selection, observed before any further async work runs.
 await act(()=>selectValue(fieldSelect('Approval transition'),optionFor('Any status -> Done')));
 assert.doesNotMatch(text(),/Statement for edge 5/,'the open challenge for the old edge is withdrawn');
 assert.doesNotMatch(text(),/That code was not accepted/,'errors from the old edge are cleared');
 assert.equal(codeBox(),null,'the code typed for the old edge is gone');
 assert.equal(affirm(),null,'the confirmation for the old edge is gone');
 assert.doesNotMatch(text(),/Evidence field/,'evidence loaded for the old edge is not shown for the new one');
 await flush();
 assert.equal(calls.filter(([k])=>k==='panel:getEvidence').length,2,'evidence reloads for the new action key');
 await act(()=>clickButton('Approve -> Done').click());await flush();
 assert.match(text(),/Statement for edge 6/);
 assert.equal(affirm().checked,false,'confirmation must not carry to the new edge');
 assert.equal(codeBox(),null);
});

test('switching the selected action clears in-flight progress and a late challenge never opens for the new action',async()=>{
 const pending=deferred();
 setup(key=>key==='signature:challenge'?pending.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition(),blocked()]),onDone:async()=>{}})));
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 await act(()=>clickButton('Approve -> Done').click());
 assert.match(liveStatus().textContent,/Preparing signature/);
 await act(()=>selectValue(fieldSelect('Approval transition'),'6'));
 assert.doesNotMatch(text(),/Preparing signature/,'progress for the old action must not survive');
 assert.equal(clickButton('Approve -> Blocked').disabled,false,'the new action is immediately usable');
 await act(()=>pending.resolve(challengeOk({meaning:'Old edge statement'})));await flush();
 assert.doesNotMatch(text(),/Old edge statement/);
 assert.equal(clickButton('Sign and approve'),undefined);
});

test('a success message for one action does not survive choosing another',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:true,approvalId:'a',transitioned:true}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition(),blocked()]),onDone:async()=>{}})));
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 await act(()=>clickButton('Approve -> Done').click());await flush();
 await signWithCode();await flush();
 assert.match(text(),/Approval recorded/);
 await act(()=>selectValue(fieldSelect('Approval transition'),'6'));
 assert.doesNotMatch(text(),/Approval recorded/);
});

test('a selected action that disappears or loses eligibility during refresh fails closed',async()=>{
 let reads=0;
 const listeners=setup(async key=>{
  if(key==='panel:getSummary'){reads++;
   if(reads===1)return actor([transition(),blocked()]);
   if(reads===2)return actor([transition(),blocked({canApprove:false})]);
   return summary({transitions:[transition({canApprove:false}),blocked({canApprove:false})]});
  }
  if(key==='signature:challenge')return challengeOk({meaning:'Blocked statement'});
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>selectValue(fieldSelect('Approval transition'),'6'));
 await act(()=>clickButton('Approve -> Blocked').click());await flush();
 assert.match(text(),/Blocked statement/);
 await act(()=>affirm().click());
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();
 assert.doesNotMatch(text(),/Blocked statement/,'a challenge for an action that lost eligibility is withdrawn');
 assert.equal(clickButton('Sign and approve'),undefined);
 assert.equal(clickButton('Approve -> Blocked'),undefined);
 assert.match(text(),/no longer available/,'the reviewer is told why the action vanished');
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();
 assert.equal(clickButton(/^Approve/),undefined,'no action remains once none is authorized');
});

test('duplicate clicks on the primary action are disabled synchronously, before the network resolves',async()=>{
 let calls=0;const pending=deferred();
 setup(key=>{if(key!=='signature:challenge')return Promise.resolve({});calls++;return pending.promise;});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 const button=clickButton('Approve -> Done');
 await act(()=>{button.click();button.click();button.click();});
 assert.equal(calls,1,'only the first click may reach the resolver');
 assert.equal(clickButton('Preparing signature').disabled,true);
 await act(()=>pending.resolve(challengeOk()));await flush();
});

test('duplicate clicks on Sign are disabled synchronously',async()=>{
 let submits=0;const pending=deferred();
 setup(key=>{if(key==='signature:challenge')return Promise.resolve(challengeOk());if(key==='signature:submit'){submits++;return pending.promise;}return Promise.resolve({});});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());await flush();
 await act(()=>affirm().click());
 await act(()=>typeInto(codeBox(),'123456'));
 const sign=clickButton('Sign and approve');
 await act(()=>{sign.click();sign.click();});
 assert.equal(submits,1);
 await act(()=>pending.resolve({success:true,approvalId:'a',transitioned:true}));await flush();
});

// ── Progress copy appears in the same click ───────────────────────────────

test('"Preparing signature" then "Publishing baseline" appear synchronously for a capturing edge',async()=>{
 const challenge=deferred();const submit=deferred();
 setup(key=>key==='signature:challenge'?challenge.promise:key==='signature:submit'?submit.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition({capturesBaseline:true})]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());
 assert.match(liveStatus().textContent,/Preparing signature/);
 await act(()=>challenge.resolve(challengeOk()));await flush();
 await act(()=>affirm().click());
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign and approve').click());
 assert.match(liveStatus().textContent,/Publishing baseline/,'capturing an edge must announce baseline publication');
 await act(()=>submit.resolve({success:true,approvalId:'a',transitioned:true}));await flush();
});

test('a non-capturing transition announces "Moving to Done", not "Publishing baseline"',async()=>{
 const submit=deferred();
 setup(key=>key==='signature:challenge'?Promise.resolve(challengeOk()):key==='signature:submit'?submit.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition({capturesBaseline:false})]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());await flush();
 await act(()=>affirm().click());
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign and approve').click());
 assert.match(liveStatus().textContent,/Moving to Done/);
 assert.equal(clickButton('Moving to Done').disabled,true);
 await act(()=>submit.resolve({success:true,approvalId:'a',transitioned:true}));await flush();
});

test('a biometric edge announces "Checking biometric" while the device check runs',async()=>{
 silentCeremony();
 setup(key=>{
  if(key==='webauthn:status')return Promise.resolve({ok:true,enrolled:true,usableHere:true});
  if(key==='signature:challenge')return Promise.resolve(challengeOk({requiredAssurance:'BIOMETRIC'}));
  if(key==='webauthn:assertStart')return new Promise(()=>{});
  return Promise.resolve({});
 });
 await act(()=>root.render(h(ApprovalControls,{summary:biometricSummary(),onDone:async()=>{}})));await flush();
 await act(()=>clickButton('Approve -> Done').click());await flush();
 await act(()=>affirm().click());
 await act(()=>clickButton('Sign and approve').click());
 assert.match(liveStatus().textContent,/Checking biometric/);
 assert.equal(clickButton('Checking biometric').disabled,true);
});

test('a drift rejection announces "Starting restoration"',async()=>{
 const submit=deferred();
 setup(key=>key==='signature:challenge'?Promise.resolve(challengeOk({meaning:'Reject'})):key==='signature:submit'?submit.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([],{baseline:baseline(),drift:driftOn()}),onDone:async()=>{}})));
 await act(()=>clickButton('Reject and restore').click());await flush();
 await act(()=>affirm().click());
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign and restore').click());
 assert.match(liveStatus().textContent,/Starting restoration/);
 await act(()=>submit.resolve({success:true,approvalId:'a',transitioned:false}));await flush();
});

test('retrying a stranded transition announces "Moving to Done" synchronously',async()=>{
 const retry=deferred();let calls=0;
 setup(key=>{if(key==='approval:retryTransition'){calls++;return retry.promise;}return Promise.resolve({});});
 const data=actor([transition()],{approval:{pending:{approvalId:'p'.repeat(32),transitionId:'5',state:'PENDING'}}});
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));
 const button=clickButton('Retry transition');
 await act(()=>{button.click();button.click();});
 assert.equal(calls,1);
 assert.match(liveStatus().textContent,/Moving to Done/);
 await act(()=>retry.resolve({success:true,transitioned:true}));await flush();
});

test('restoration in progress is reported with the exact required copy, and a retry announces it synchronously',async()=>{
 const retry=deferred();let retries=0;
 setup(key=>{
  if(key==='restore:getState')return Promise.resolve({restores:[{restore_id:'r1',state:'PARTIAL'}]});
  if(key==='restore:retry'){retries++;return retry.promise;}
  return Promise.resolve({});
 });
 await act(()=>root.render(h(RestoreStatus,{issueKey:'T-1',restore:{restoreId:'r1',state:'PARTIAL',attempted:2,succeeded:1,failed:1,skipped:0},onDone:async()=>{}})));await flush();
 const button=clickButton('Retry restore');
 await act(()=>{button.click();button.click();});
 assert.equal(retries,1);
 assert.match(text(),/Restoration in progress/);
 assert.equal(clickButton('Restoration in progress').disabled,true);
 await act(()=>retry.resolve({success:true}));await flush();
 await act(()=>root.unmount());root=null;
 setup(async()=>({restores:[{restore_id:'r2',state:'PENDING'}]}));
 await act(()=>root.render(h(RestoreStatus,{issueKey:'T-1',restore:{restoreId:'r2',state:'PENDING',attempted:0,succeeded:0,failed:0,skipped:0}})));await flush();
 assert.match(text(),/Restoration in progress/);
});

test('a queueing failure stays actionable with Retry restore',async()=>{
 let retries=0;
 setup(key=>{if(key==='restore:getState')return Promise.resolve({restores:[{restore_id:'r3',state:'QUEUING_FAILED',last_error:'queue unavailable'}]});if(key==='restore:retry'){retries++;return Promise.resolve({success:true,state:'RESTORING'});}return Promise.resolve({});});
 await act(()=>root.render(h(RestoreStatus,{issueKey:'T-1',restore:{restoreId:'r3',state:'QUEUING_FAILED',attempted:0,succeeded:0,failed:0,skipped:2},onDone:async()=>{}})));await flush();
 assert.match(text(),/Queuing failed/);
 await act(()=>clickButton('Retry restore').click());await flush();
 assert.equal(retries,1);
});

test('restore completion refreshes the panel even when the issue content is unchanged',async()=>{
 let restoreState='PENDING';
 const listeners=setup(async key=>{
  if(key==='panel:getSummary')return summary({baseline:baseline(),restore:{restoreId:'r1',state:restoreState,attempted:1,succeeded:0,failed:0,skipped:0}});
  if(key==='restore:getState')return {restores:[{restore_id:'r1',state:restoreState}]};
  return {};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Restoration in progress/);
 restoreState='COMPLETE';
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();await flush();
 assert.match(text(),/Restored and verified/);
 assert.doesNotMatch(text(),/Restoration in progress/);
});

// ── Accessibility ─────────────────────────────────────────────────────────

test('the selector is labelled, progress is a live status, and Enter in the code box signs',async()=>{
 const submit=deferred();const calls=[];
 setup((key)=>{calls.push(key);if(key==='signature:challenge')return Promise.resolve(challengeOk());if(key==='signature:submit')return submit.promise;return Promise.resolve({});});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition(),blocked()]),onDone:async()=>{}})));
 const select=fieldSelect('Approval transition');
 assert.equal(select.closest('label')?.querySelector('.va-label')?.textContent,'Approval transition','the selector must carry its label');
 await act(()=>selectValue(select,'5'));
 await act(()=>clickButton('Approve -> Done').click());await flush();
 await act(()=>affirm().click());
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>codeBox().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 assert.ok(calls.includes('signature:submit'),'Enter in the code box must sign without a pointer');
 assert.match(liveStatus().textContent,/Moving to Done/);
 assert.equal(clickButton('Moving to Done').disabled,true);
 await act(()=>submit.resolve({success:true,approvalId:'a',transitioned:true}));await flush();
});

// ── Evidence: lazy, scoped, keyed, and never blocking controls ───────────

test('evidence is not requested during ordinary summary loading',async()=>{
 const calls=[];
 setup(async key=>{calls.push(key);return key==='panel:getSummary'?summary({baseline:baseline()}):{restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(!calls.includes('panel:getEvidence'),'evidence must not be requested until the disclosure opens or drift review requires it');
});

test('evidence loads lazily once the baseline disclosure is opened, and controls stay visible while it loads',async()=>{
 const evidenceRead=deferred();const calls=[];
 setup(key=>{calls.push(key);
  if(key==='panel:getSummary')return Promise.resolve(actor([transition()],{baseline:baseline()}));
  if(key==='panel:getEvidence')return evidenceRead.promise;
  return Promise.resolve({restores:[]});
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(!calls.includes('panel:getEvidence'));
 await act(()=>disclosure().click());await flush();
 assert.ok(calls.includes('panel:getEvidence'));
 assert.match(text(),/Loading tracked fields/);
 assert.ok(clickButton('Approve -> Done'),'the primary control must remain usable while evidence is still loading');
 assert.equal(clickButton('Approve -> Done').disabled,false);
 await act(()=>evidenceRead.resolve(evidence()));await flush();
 assert.match(text(),/Summary/);
});

test('drift review is an approval flow that requires evidence, keyed to the current baseline version',async()=>{
 const evidenceRequests=[];
 setup(async(key,payload)=>{
  if(key==='panel:getSummary')return actor([],{baseline:baseline(),drift:driftOn()});
  if(key==='panel:getEvidence'){evidenceRequests.push(payload);return evidence();}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.equal(evidenceRequests.length,1,'reviewing drift must trigger exactly one evidence load');
 assert.equal(evidenceRequests[0].expectedBaselineVersion,1);
 assert.equal(evidenceRequests[0].expectedBaselineId,'ab'.repeat(8));
});

test('a failed evidence load keeps the summary and controls visible, with a scoped retry',async()=>{
 let evidenceCalls=0;let summaryCalls=0;
 setup(async key=>{
  if(key==='panel:getSummary'){summaryCalls++;return actor([transition()],{baseline:baseline()});}
  if(key==='panel:getEvidence'){evidenceCalls++;if(evidenceCalls===1)throw new Error('Evidence service unavailable');return evidence();}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>disclosure().click());await flush();
 assert.match(text(),/could not be loaded/);
 assert.ok(clickButton('Approve -> Done'),'controls must remain usable after an evidence failure');
 await act(()=>clickButton('Retry').click());await flush();
 assert.equal(evidenceCalls,2);
 assert.equal(summaryCalls,1,'an evidence retry must not reset the whole panel');
 assert.doesNotMatch(text(),/could not be loaded/);
});

test('evidence is keyed by the selected action: a late answer for the old action is never shown',async()=>{
 const requests=[];
 setup(key=>{
  if(key==='panel:getSummary')return Promise.resolve(actor([transition(),blocked()],{baseline:baseline()}));
  if(key==='panel:getEvidence'){const d=deferred();requests.push(d);return d.promise;}
  return Promise.resolve({restores:[]});
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 await act(()=>disclosure().click());await flush();
 assert.equal(requests.length,1);
 await act(()=>selectValue(fieldSelect('Approval transition'),'6'));await flush();
 assert.equal(requests.length,2,'the new action gets its own evidence read');
 await act(()=>requests[0].resolve(evidenceWithField('Old action field')));await flush();
 assert.doesNotMatch(text(),/Old action field/);
 assert.match(text(),/Loading tracked fields/);
 await act(()=>requests[1].resolve(evidenceWithField('New action field')));await flush();
 assert.match(text(),/New action field/);
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 assert.doesNotMatch(text(),/New action field/,'evidence for one action is never displayed under another');
});

test('evidence for a superseded baseline is discarded unseen, refreshes the summary, and reloads for the new version',async()=>{
 let summaryReads=0;const evidenceRequests=[];
 setup(async(key,payload)=>{
  if(key==='panel:getSummary'){summaryReads++;return actor([],{baseline:baseline({version:summaryReads===1?1:2}),drift:driftOn()});}
  if(key==='panel:getEvidence'){evidenceRequests.push(payload);
   return payload.expectedBaselineVersion===1
    ?evidence({baselineVersion:2,drift:{fields:[],changedFields:[1,2,3,4,5,6,7]}})
    :evidence({baselineVersion:2,drift:{fields:[],changedFields:[1,2]}});}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));
 for(let i=0;i<4;i++){await flush();assert.doesNotMatch(text(),/7 changed fields/,'evidence from another baseline version must never render');}
 assert.equal(summaryReads,2,'a newer authoritative baseline refreshes the summary');
 assert.deepEqual(evidenceRequests.map(p=>p.expectedBaselineVersion),[1,2]);
 assert.match(text(),/2 changed fields/);
});

test('a STALE_EVIDENCE refusal refreshes the summary without rendering the stale payload',async()=>{
 let summaryReads=0;
 setup(async(key,payload)=>{
  if(key==='panel:getSummary'){summaryReads++;return actor([],{baseline:baseline({version:summaryReads}),drift:driftOn()});}
  if(key==='panel:getEvidence')return payload.expectedBaselineVersion===1?{error:'The evidence is stale.',reason:'STALE_EVIDENCE'}:evidence({baselineVersion:2});
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));
 await flush();await flush();await flush();
 assert.equal(summaryReads,2);
 assert.doesNotMatch(text(),/evidence is stale/);
});

test('evidence that stays stale after a summary refresh stops with a scoped retry instead of looping',async()=>{
 let summaryReads=0,evidenceReads=0;
 setup(async key=>{
  if(key==='panel:getSummary'){summaryReads++;return actor([],{baseline:baseline(),drift:driftOn()});}
  if(key==='panel:getEvidence'){evidenceReads++;return {error:'The evidence is stale.',reason:'STALE_EVIDENCE'};}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));
 for(let i=0;i<5;i++)await flush();
 assert.equal(summaryReads,2);
 assert.equal(evidenceReads,1);
 assert.match(text(),/changed while it was loading/);
 assert.ok(clickButton('Approve changes'),'controls stay visible');
 await act(()=>clickButton('Reload evidence').click());await flush();
 assert.equal(evidenceReads,2);
});

// ── Event ownership: exactly one event per durable mutation ──────────────

test('a successful durable mutation emits VA_ISSUE_CHANGED exactly once',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:true,approvalId:'a',transitioned:true}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());await settle();
 await signWithCode();await settle();
 assert.equal(globalThis.panelTransport.emitted.length,1,'no component may emit a duplicate event alongside the centralised bridge emission');
 assert.deepEqual(globalThis.panelTransport.emitted[0],['VA_ISSUE_CHANGED',{issueKey:'T-1'}]);
});

test('a post-action refresh does not become a storm when the app event echoes back',async()=>{
 let reads=0;
 setup(async key=>{
  if(key==='panel:getSummary'){reads++;return actor([transition()]);}
  if(key==='signature:challenge')return challengeOk();
  if(key==='signature:submit')return {success:true,approvalId:'a',transitioned:true};
  return {restores:[]};
 },{loopback:true});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 const before=reads;
 await act(()=>clickButton('Approve -> Done').click());await flush();
 await signWithCode();
 for(let i=0;i<4;i++)await flush();
 assert.equal(globalThis.panelTransport.emitted.length,1);
 const after=reads-before;
 assert.ok(after>=1&&after<=2,`expected one post-action refresh plus at most one coalesced echo, saw ${after}`);
});

test('a resolver-denied submit does not emit VA_ISSUE_CHANGED',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:false,error:'CONTENT_CHANGED'}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());await settle();
 await signWithCode();await settle();
 assert.equal(globalThis.panelTransport.emitted.length,0,'a denied mutation is not durable and must not notify other surfaces');
});

test('Jira refusing the transition is reported legibly, emits nothing, and offers no reuse of the spent signature',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:true,approvalId:'a',transitioned:false,state:'CONSUMED',transitionError:'Jira refused the transition: a required field is empty.'}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve -> Done').click());await settle();
 await signWithCode();await settle();
 assert.match(text(),/Jira refused the transition: a required field is empty/);
 assert.match(text(),/A fresh signature may be required/);
 assert.equal(clickButton('Retry transition'),undefined,'a spent approval is never offered for reuse');
 assert.equal(globalThis.panelTransport.emitted.length,0);
 assert.equal(clickButton('Approve -> Done').disabled,false,'the reviewer can start again without reloading');
});

test('approval and restore resolver outcomes notify other open app views',async()=>{
 setup(async()=>({success:true}));
 for(const key of ['signature:submit','approval:submit','approval:retryTransition','restore:retry']){
  await invoke(key,{issueKey:'T-1'});
 }
 assert.equal(globalThis.panelTransport.emitted.length,4);
 assert.deepEqual(globalThis.panelTransport.emitted[0],['VA_ISSUE_CHANGED',{issueKey:'T-1'}]);
});

test('resolver, validator, persistence, and Jira failures never emit VA_ISSUE_CHANGED',async()=>{
 const outcomes=[
  {success:false,error:'DENIED'},
  {success:false,reason:'INSUFFICIENT_ASSURANCE',error:'The device check did not meet the rule.'},
  {error:'The service is unavailable.',reason:'SERVICE_UNAVAILABLE'},
  {ok:false,reason:'WEBAUTHN_CREDENTIAL_UNREACHABLE'},
  {success:true,approvalId:'a',transitioned:false,transitionError:'Jira refused the transition.'}
 ];
 for(const outcome of outcomes){
  setup(async()=>outcome);
  for(const key of ['signature:submit','approval:submit','approval:retryTransition','restore:retry'])await invoke(key,{issueKey:'T-1'});
  assert.equal(globalThis.panelTransport.emitted.length,0,JSON.stringify(outcome));
  container.remove();
 }
 setup(async()=>{throw new Error('network down');});
 for(const key of ['signature:submit','approval:submit','approval:retryTransition','restore:retry'])await assert.rejects(invoke(key,{issueKey:'T-1'}));
 assert.equal(globalThis.panelTransport.emitted.length,0);
});

test('VA_ISSUE_CHANGED is emitted only by the shared bridge layer of each runtime',()=>{
 const sourceRoot=fileURLToPath(new URL('../src',import.meta.url));
 const emitters=[];
 (function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())walk(full);
   else if(/\.(ts|tsx|js|jsx)$/.test(entry.name)&&/events\.emit\s*\(/.test(fs.readFileSync(full,'utf8')))emitters.push(path.relative(sourceRoot,full));
  }
 })(sourceRoot);
 assert.deepEqual(emitters,[path.join('lib','bridge.ts')],'components must not emit their own copy of the event');
 const bridge=fs.readFileSync(path.join(sourceRoot,'lib','bridge.ts'),'utf8');
 assert.equal(bridge.match(/events\.emit\s*\(/g).length,1);
 // The UI Kit field is a separate Forge bundle and cannot import lib/bridge.ts,
 // so it owns one equivalent mutation helper and its component never emits.
 const uiKit=fs.readFileSync(fileURLToPath(new URL('../../src/ui-kit/edit.jsx',import.meta.url)),'utf8');
 assert.equal(uiKit.match(/events\.emit\s*\(/g)?.length,1);
 const helper=uiKit.indexOf('async function invokeMutation');
 const component=uiKit.indexOf('const Edit = ');
 assert.ok(helper>=0&&helper<uiKit.indexOf('events.emit(')&&uiKit.indexOf('events.emit(')<component,'the UI Kit emission lives in its mutation helper, not in the component');
});

test('the issue status display updates to v2 after a decision event',async()=>{
 let version=1;
 const listeners=setup(async()=>({state:'BASELINED',baselineVersion:version}));
 await act(()=>root.render(h(IssueContext)));await flush();
 assert.match(text(),/Version 1/);version=2;
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();
 assert.match(text(),/Version 2/);
});

// ── The Custom UI transition-screen field: exact, read-only, fail-closed ─

const fieldContext={extension:{issue:{key:'T-1',id:'10'},issueTransition:{id:'5'}}};
const fieldAction=(over={})=>({transitionId:'5',toStatusId:'2',toStatusName:'Done',name:'Done',meaning:'Bug Resolved',requiredRole:'SDE-1',requiredAssurance:'ESIGNATURE',capturesBaseline:true,blocksOnDrift:true,anyStatus:false,label:'Sign to move to Done',...over});
const fieldState=(requiredAssurance,over={})=>({issue:{key:'T-1',summary:'Bug to close',statusName:'In Progress'},actorName:'Sai Harsha',drift:{evidenceHash:'hash'},blocker:null,
 actions:[fieldAction({requiredAssurance})],...over});

test('the transition screen shows the exact action as read-only facts, never a selector',async()=>{
 setup(async key=>key==='signing:context'?fieldState('BIOMETRIC'):key==='webauthn:status'?{ok:true,enrolled:true,usableHere:true}:{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 const t=text();
 assert.match(t,/In Progress -> Done/,'source and destination');
 assert.match(t,/SDE-1/,'role');
 assert.match(t,/Bug Resolved/,'meaning');
 assert.match(t,/Biometric approval/,'authentication method');
 assert.match(t,/Captures a new baseline/,'capture policy');
 assert.match(t,/Blocked while changes are unapproved/,'drift behaviour');
 assert.equal(container.querySelector('select'),null);
});

test('the transition screen asks for a device check on a biometric edge, not an authenticator code',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signing:context')return fieldState('BIOMETRIC');
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'BIOMETRIC'};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  if(key==='approval:submit')return {success:true,approvalId:'f'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/Bug Resolved/);
 assert.equal(codeBox(),null,'a biometric edge must not offer an authenticator code box');
 await act(()=>affirm().click());await settle();
 const confirm=clickButton(/Confirm with your device/i);
 assert.ok(confirm,'the reviewer must be offered the device check');
 await act(()=>confirm.click());await settle();
 assert.equal(ceremony.action,'confirm');
 const challenge=calls.find(([k])=>k==='approval:challenge');
 assert.equal(challenge[1].transitionId,'5','the challenge names the exact transition from the Jira context');
 const submit=calls.find(([k])=>k==='approval:submit');
 assert.ok(submit,'the approval must be recorded server-side');
 assert.equal(submit[1].preauthorize,true,'Jira performs the transition, not the app');
 assert.equal(submit[1].webauthn?.challengeId,'wa-1');
 assert.ok(!('code' in submit[1]),'a biometric approval must not carry a signature code');
 assert.equal(globalThis.panelTransport.submitted.at(-1),'f'.repeat(32));
});

test('the transition screen announces "Preparing signature" and "Checking biometric" as the device check starts',async()=>{
 silentCeremony();const challenge=deferred();
 setup(key=>{
  if(key==='signing:context')return Promise.resolve(fieldState('BIOMETRIC'));
  if(key==='webauthn:status')return Promise.resolve({ok:true,enrolled:true,usableHere:true});
  if(key==='approval:challenge')return challenge.promise;
  if(key==='webauthn:assertStart')return new Promise(()=>{});
  return Promise.resolve({});
 },{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 await act(()=>affirm().click());
 const confirm=clickButton(/Confirm with your device/i);
 await act(()=>{confirm.click();confirm.click();});
 assert.match(liveStatus().textContent,/Preparing signature/);
 assert.equal(clickButton('Preparing signature').disabled,true);
 await act(()=>challenge.resolve({success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'BIOMETRIC'}));await flush();
 assert.match(liveStatus().textContent,/Checking biometric/);
});

test('the transition screen still signs an electronic-signature edge with a code',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'ESIGNATURE'};
  if(key==='approval:submit')return {success:true,approvalId:'a'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 await act(()=>affirm().click());await settle();
 assert.ok(codeBox(),'an electronic-signature edge must offer the code box');
 await act(()=>typeInto(codeBox(),'123456'));await settle();
 const submit=calls.find(([k])=>k==='approval:submit');
 assert.ok(submit,'six digits records the approval');
 assert.equal(submit[1].code,'123456');
 assert.equal(submit[1].preauthorize,true);
 assert.ok(!calls.some(([k])=>k==='webauthn:assertStart'),'a code edge must never open a device ceremony');
 assert.equal(globalThis.panelTransport.submitted.at(-1),'a'.repeat(32));
 assert.equal(globalThis.panelTransport.emitted.length,1,'the durable receipt notifies other views exactly once');
});

test('the transition screen records nothing when the device check is refused',async()=>{
 stubCeremony({success:false,errorName:'NotAllowedError',errorMessage:'cancelled'});const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signing:context')return fieldState('BIOMETRIC');
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'BIOMETRIC'};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  return {};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 await act(()=>affirm().click());await settle();
 await act(()=>clickButton(/Confirm with your device/i).click());await settle();
 assert.ok(!calls.some(([k])=>k==='approval:submit'),'a refused device check must not record an approval');
 assert.ok(!globalThis.panelTransport.submitted.some(v=>/^[a-f0-9]{32}$/.test(v)),'and must not hand Jira a receipt');
 assert.equal(globalThis.panelTransport.emitted.length,0);
 assert.equal(clickButton(/Confirm with your device/i).disabled,false,'the signer can try again');
});

test('a reviewer without the approver role is told so instead of being offered a signature',async()=>{
 setup(async key=>key==='signing:context'
  ?{...fieldState('BIOMETRIC'),actions:undefined,transitions:[{transitionId:'5',toStatusId:'2',name:'Done',meaning:'Bug Resolved',requiredRole:'SDE-1',requiredAssurance:'BIOMETRIC',eligible:false}]}
  :{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/do not hold the approver role/i);
 assert.equal(affirm(),null,'nothing is signable without the role');
});

test('the transition screen still works when Jira gives the field no issue in context',async()=>{
 const calls=[];const context={extension:{issueTransition:{id:'5'}}};
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'ESIGNATURE'};
  if(key==='approval:submit')return {success:true,approvalId:'b'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};},{context});
 await act(()=>root.render(h(ApprovalField,{context})));await settle();
 assert.doesNotMatch(text(),/could not tell which work item/i);
 assert.match(text(),/Bug Resolved/);
 await act(()=>affirm().click());await settle();
 await act(()=>typeInto(codeBox(),'123456'));await settle();
 const submit=calls.find(([k])=>k==='approval:submit');
 assert.ok(submit,'the approval is recorded using the key the server resolved');
 assert.equal(submit[1].issueKey,'T-1');
});

test('transition field sends Jira issueTransition.id to signing context',async()=>{
 const calls=[];const context={extension:{issue:{key:'T-1',id:'10'},issueTransition:{id:'102'}}};
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?fieldState('ESIGNATURE',{actions:[fieldAction({transitionId:'102'})]}):{};},{context});
 await act(()=>root.render(h(ApprovalField,{context})));await settle();
 const call=calls.find(([key])=>key==='signing:context');
 assert.ok(call,'signing:context must be called');
 assert.equal(call[1].transitionId,'102');
 assert.ok(affirm(),'the exact matching action is signable');
});

test('a missing transition identity fails closed with a legible message and never falls back to a broader read',async()=>{
 const calls=[];const context={extension:{issue:{key:'T-1',id:'10'}}};
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?fieldState('ESIGNATURE'):{};},{context});
 await act(()=>root.render(h(ApprovalField,{context})));await settle();
 assert.match(text(),/reopen the transition dialog/i);
 assert.equal(affirm(),null,'nothing can be signed without the exact transition');
 assert.ok(!calls.some(([k])=>k==='panel:getState'||k==='panel:getSummary'||k==='approval:challenge'),'there must be no fallback to a broader read');
});

test('a missing issue on the server side fails closed with a legible message',async()=>{
 setup(async key=>key==='signing:context'?{error:'ISSUE_REQUIRED',reason:'ISSUE_REQUIRED'}:{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/could not determine which work item/i);
 assert.equal(affirm(),null);
});

test('an action for a sibling transition is refused rather than signed in place of the exact one',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?fieldState('ESIGNATURE',{actions:[fieldAction({transitionId:'7',name:'Close as fixed'})]}):{};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/does not match the transition being performed/);
 assert.equal(affirm(),null);
 assert.ok(!calls.some(([k])=>k==='approval:challenge'));
});

test('the transition screen never renders a selector, even if more than one rule were somehow matched',async()=>{
 setup(async key=>key==='signing:context'?fieldState('ESIGNATURE',{actions:[fieldAction(),fieldAction({meaning:'Another statement'})]}):{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.equal(container.querySelector('select'),null,'the transition screen must never render a selector');
 assert.match(text(),/more than one signing rule matched/i);
 assert.equal(affirm(),null);
});

// ── The UI Kit transition-screen field (src/ui-kit/edit.jsx) ──────────────

const uiKitAffirm=()=>container.querySelector('.uk-checkbox input');
const uiKitCode=()=>container.querySelector('.uk-textfield');

test('the UI Kit field shows the exact action as read-only facts, asks for it by issueTransition.id, and has no selector',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?fieldState('ESIGNATURE',{actions:[fieldAction({anyStatus:true})]}):{};},{context:fieldContext});
 await act(()=>root.render(UiKitEdit));await settle();
 assert.equal(calls.find(([k])=>k==='signing:context')[1].transitionId,'5');
 const t=text();
 assert.match(t,/Any status -> Done/);assert.match(t,/SDE-1/);assert.match(t,/Bug Resolved/);assert.match(t,/Electronic signature/);
 assert.match(t,/Captures a new baseline/);assert.match(t,/Blocked while changes are unapproved/);
 assert.equal(container.querySelector('select'),null);
 assert.ok(uiKitAffirm());
});

test('the UI Kit field fails closed for two matches, a sibling transition, or a missing transition identity',async()=>{
 const cases=[
  [fieldContext,fieldState('ESIGNATURE',{actions:[fieldAction(),fieldAction({meaning:'Another'})]}),/more than one signing rule matched/i],
  [fieldContext,fieldState('ESIGNATURE',{actions:[fieldAction({transitionId:'7'})]}),/does not match the transition being performed/],
  [{extension:{issue:{key:'T-1',id:'10'}}},fieldState('ESIGNATURE'),/reopen the transition dialog/i]
 ];
 for(const [context,response,message] of cases){
  const calls=[];
  setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?response:{};},{context});
  await act(()=>root.render(UiKitEdit));await settle();
  assert.match(text(),message);
  assert.equal(container.querySelector('select'),null);
  assert.equal(uiKitAffirm(),null,'nothing can be affirmed on a fail-closed screen');
  assert.ok(!calls.some(([k])=>k==='approval:challenge'));
  await act(()=>root.unmount());root=null;container.remove();
 }
});

test('the UI Kit field announces "Preparing signature", then emits exactly one event only after a durable receipt',async()=>{
 const challenge=deferred();
 setup(key=>{
  if(key==='signing:context')return Promise.resolve(fieldState('ESIGNATURE'));
  if(key==='approval:challenge')return challenge.promise;
  if(key==='approval:submit')return Promise.resolve({success:true,approvalId:'e'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'});
  return Promise.resolve({});
 },{context:fieldContext});
 await act(()=>root.render(UiKitEdit));await settle();
 await act(()=>uiKitAffirm().click());
 await act(()=>typeInto(uiKitCode(),'123456'));
 assert.match(text(),/Preparing signature/);
 assert.equal(globalThis.panelTransport.emitted.length,0,'nothing is emitted before the mutation is durable');
 await act(()=>challenge.resolve({success:true,challengeId:'ch-1'}));await settle();
 assert.equal(globalThis.panelTransport.submitted.at(-1),'e'.repeat(32));
 assert.deepEqual(globalThis.panelTransport.emitted,[['VA_ISSUE_CHANGED',{issueKey:'T-1'}]]);
});

test('the UI Kit field emits nothing when the signature is refused',async()=>{
 setup(async key=>{
  if(key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1'};
  if(key==='approval:submit')return {success:false,reason:'INVALID_CODE',error:'That code could not be verified.'};
  return {};
 },{context:fieldContext});
 await act(()=>root.render(UiKitEdit));await settle();
 await act(()=>uiKitAffirm().click());
 await act(()=>typeInto(uiKitCode(),'123456'));await settle();
 assert.match(text(),/That code could not be verified/);
 assert.equal(globalThis.panelTransport.emitted.length,0);
});

// ── Admin: the exact workflow-transition picker (TransitionsPage) ─────────
// admin:listWorkflowTransitions replaces the old free-text from/to status
// inputs with Jira's own live edges, read fresh every time the project or
// work item type changes. See src/usecases/adminDirectory.js and
// src/usecases/transitionsValidation.js for the server-side half.
const oneProject=[{id:'1',key:'ONE',name:'Project one'}];
function transitionsHandler({workflow=[],fail=false,issueTypes=[{id:'2',name:'Bug'}]}={}){
 return async(key)=>{
  if(key==='admin:listControlledTransitions')return {success:true,transitions:[]};
  if(key==='admin:listIssueTypesForProject')return {success:true,issueTypes};
  if(key==='admin:listStatusesForProject')return {success:true,statuses:[]};
  if(key==='admin:listAvailableRoles')return {success:true,roles:['QA']};
  if(key==='admin:listWorkflowTransitions')return fail?{success:false,error:'Could not read the live Jira workflow.'}:{success:true,transitions:workflow};
  return {success:true};
 };
}
const directedEdge=(over={})=>({transitionId:'2',name:'Done',fromStatusId:'10004',fromStatusName:'To Do',toStatusId:'10006',toStatusName:'Done',global:false,hasScreen:false,validatorAttached:true,jiraRules:{conditions:false,otherValidators:0,postFunctions:0},...over});
const globalEdge=(over={})=>({transitionId:'4',name:'Any',fromStatusId:'*',fromStatusName:'Any status',toStatusId:'10004',toStatusName:'To Do',global:true,hasScreen:false,validatorAttached:true,jiraRules:{conditions:false,otherValidators:0,postFunctions:0},...over});
async function chooseScope(){
 await act(()=>selectValue(fieldSelect('Project'),'1'));await flush();
 await act(()=>selectValue(fieldSelect('Work item type'),'2'));await flush();
}

test('an option is labelled with the exact edge, and a global transition reads "Any status"',async()=>{
 setup(transitionsHandler({workflow:[directedEdge(),globalEdge()]}));
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await chooseScope();
 const labels=[...fieldSelect('Exact transition').querySelectorAll('option')].map(o=>o.textContent);
 assert.ok(labels.includes('To Do -> Done - Done (#2)'));
 assert.ok(labels.includes('Any status -> To Do - Any (#4)'));
});

test('two transitions sharing a destination status remain two separate options',async()=>{
 setup(transitionsHandler({workflow:[directedEdge(),directedEdge({transitionId:'3',name:'Sign',fromStatusId:'3',fromStatusName:'In Progress'})]}));
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await chooseScope();
 const values=[...fieldSelect('Exact transition').querySelectorAll('option')].map(o=>o.value).filter(Boolean);
 assert.equal(values.length,2,'both edges into Done must stay selectable, not collapse into one');
});

test('selecting a transition shows its read-only facts; changing scope clears them',async()=>{
 setup(transitionsHandler({workflow:[directedEdge({hasScreen:true})]}));
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await chooseScope();
 const select=fieldSelect('Exact transition');
 await act(()=>selectValue(select,'2:10004'));await flush();
 assert.match(text(),/Has a transition screen/);
 assert.match(text(),/Attached and enabled/);
 await act(()=>selectValue(fieldSelect('Work item type'),''));await flush();
 assert.equal(fieldSelect('Exact transition').value,'');
 assert.doesNotMatch(text(),/Has a transition screen/);
});

test('the transition selector stays disabled while discovery is loading or has failed',async()=>{
 let resolveWorkflow;
 setup(async key=>{
  if(key==='admin:listWorkflowTransitions')return new Promise(r=>{resolveWorkflow=()=>r({success:true,transitions:[directedEdge()]});});
  return transitionsHandler()(key);
 });
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await act(()=>selectValue(fieldSelect('Project'),'1'));await flush();
 await act(()=>selectValue(fieldSelect('Work item type'),'2'));await flush();
 assert.equal(fieldSelect('Exact transition').disabled,true,'must stay disabled while the live read is in flight');
 await act(()=>resolveWorkflow());await flush();
 assert.equal(fieldSelect('Exact transition').disabled,false,'must enable once the live read lands');
});

test('a failed live read leaves the transition selector disabled and reports the error',async()=>{
 setup(transitionsHandler({fail:true}));
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await chooseScope();
 assert.equal(fieldSelect('Exact transition').disabled,true);
 assert.match(text(),/Could not read the live Jira workflow/);
});

test('a transition with no VAtlassian validator attached is a blocking finding, not a soft warning',async()=>{
 setup(transitionsHandler({workflow:[directedEdge({validatorAttached:false})]}));
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await chooseScope();
 await act(()=>selectValue(fieldSelect('Exact transition'),'2:10004'));await flush();
 assert.match(text(),/cannot be enforced yet/);
 assert.match(text(),/Attach the signature validator to this transition in Jira/);
 assert.equal(clickButton('Add rule').disabled,true);
});
