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
// Files under src/ui-kit/ live outside the frontend package and would otherwise
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
   export const view={refresh:async()=>{globalThis.panelTransport.redraws=(globalThis.panelTransport.redraws??0)+1;},close:async p=>{(globalThis.panelTransport.closed??=[]).push(p);},submit:v=>{globalThis.panelTransport.submitted.push(v);},getContext:async()=>globalThis.panelTransport.contextPromise??globalThis.panelTransport.context};export const router={open:async()=>{}};
   export class Modal{constructor(o){this.options=o;}open(){(globalThis.panelTransport.modals??=[]).push(this.options);return Promise.resolve();}}`};
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
   // Mirrors node_modules/@forge/react/out/hooks/useProductContext.js: the
   // first render has no context; it arrives from view.getContext() later.
   export const useProductContext=()=>{const [c,set]=React.useState();React.useEffect(()=>{Promise.resolve(globalThis.panelTransport?.contextPromise??globalThis.panelTransport?.context).then(set,()=>{});},[]);return c;};
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
const {getHarnessEvents}=await import('../src/lib/harness.ts');
const {approvalMode}=await import('../src/lib/assurance.ts');
const {default:RestoreStatus}=await import('../src/panel/sections/RestoreStatus.tsx');
const {default:ApprovalField}=await import('../src/field/ApprovalField.tsx');
const {default:QueueList}=await import('../src/queue/QueueList.tsx');
const {default:TransitionsPage}=await import('../src/admin/pages/TransitionsPage.tsx');
const {default:DiffView}=await import('../src/review/DiffView.tsx');
const {default:BaselineSection}=await import('../src/panel/sections/BaselineSection.tsx');
const {default:ReviewWindow}=await import('../src/review/ReviewWindow.tsx');
const {default:BaselineRecord}=await import('../src/panel/sections/BaselineRecord.tsx');
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
afterEach(async()=>{if(root)await act(()=>root.unmount());container?.remove();root=null;window.sessionStorage.clear();window.open=openWindow;});
// Stands in for the top-level device window: it announces itself, accepts the
// ceremony options, and answers with whatever the authenticator would have said.
function stubCeremony(outcome={success:true,response:{id:'cred-1',rawId:'cred-1'}}){
 const seen={opened:[],action:null,optionsJSON:null};
 window.open=url=>{
  seen.opened.push(String(url));
  const popup={closed:false,close(){popup.closed=true;},postMessage(data){
   if(!data||data.type!=='webauthn-options')return;
   seen.action=data.action;seen.optionsJSON=data.optionsJSON;
   setTimeout(()=>window.dispatchEvent(new window.MessageEvent('message',{
    data:{type:'webauthn-result',...outcome},
    origin:window.location.origin,
    source:popup
   })),0);
  }};
  setTimeout(()=>window.dispatchEvent(new window.MessageEvent('message',{
   data:{type:'webauthn-ready'},
   origin:window.location.origin,
   source:popup
  })),0);
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
 const proto=input.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);
 input.dispatchEvent(new window.Event('input',{bubbles:true}));
};
const selectValue=(select,value)=>{
 Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(select,value);
 select.dispatchEvent(new window.Event('change',{bubbles:true}));
};
const h=(type,props)=>React.createElement(type,props);
const text=()=>container.textContent;
// Which summary read is on screen: the admin incident count is a visible number a read can carry.
const readCount=()=>Number(text().match(/(\d+) workflow control incident/)?.[1]);
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
 lastListeners=listeners;
 return listeners;
}
let lastListeners=null;
const listeners0=()=>lastListeners;

// ── Summary fixtures ──────────────────────────────────────────────────────
// Matches src/usecases/panelSummary.js's getSummary() payload exactly.
function summary(over={}){
 return {
  issue:{id:'1',key:'T-1',summary:'Current record',status:{id:'3',name:'In Progress',statusCategory:{key:'indeterminate'}}},
  controlled:true,tier:'observer',state:'Waiting on signature',actorName:null,
  eligibility:{eligible:false,reason:null},credentialEnrolled:undefined,
  transitions:[],baseline:null,latestApproval:null,
  drift:{count:0,materialCount:0,decidesDrift:false,policyIncomplete:false,canApprove:false,canReject:false,eligible:false},
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
// A field among the changes, so it shows wherever the panel lists them.
const evidenceWithChange=(fieldName,over={})=>evidenceWithField(fieldName,{drift:{fields:[{fieldId:fieldName,fieldName,kind:'scalar',retained:true,before:'a',after:'b',materiality:'MAJOR'}]},...over});
function baseline(over={}){
 return {baselineId:'ab'.repeat(8),version:1,approvedName:'Priya',transitionAt:1000,capturedAt:1000,assuranceLevel:'ESIGNATURE',fidelity:'EXACT',nodeCount:1,edgeCount:0,totalFieldCount:1,treeHash:null,policyIncomplete:false,...over};
}
const driftOn=(over={})=>({count:1,materialCount:1,decidesDrift:true,policyIncomplete:false,canApprove:true,canReject:true,eligible:true,...over});
const challengeOk=(over={})=>({success:true,challengeId:'c'.repeat(32),nonce:'n',meaning:'Approved',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000,...over});
// Signs the open challenge with an authenticator code.
async function signWithCode(code='123456'){
 await act(()=>typeInto(codeBox(),code));
 await act(()=>clickButton('Sign and approve').click());
}

// ── Useful shell, compact summary, refresh ────────────────────────────────

test('the panel paints issue identity from Forge context and labelled skeleton rows before any request completes',async()=>{
 const pending=deferred();
 setup(key=>key==='panel:getSummary'?pending.promise:Promise.resolve({restores:[]}),{context:{extension:{issue:{key:'T-9',id:'9'}}}});
 await act(()=>root.render(h(IssuePanel)));
 for(const label of ['Baseline'])assert.match(text(),new RegExp(label),`missing skeleton row: ${label}`);
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
 setup(async key=>{if(key==='panel:getSummary'){reads++;if(failure)throw new Error('Temporary service failure');return summary({adminIncidentCount:7});}return {restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Temporary service failure/);
 assert.match(text(),/Baseline/,'the useful shell must stay visible when the summary fails');
 failure=false;await act(()=>clickButton('Try again').click());await flush();
 assert.equal(reads,2);
 assert.doesNotMatch(text(),/Temporary service failure/);
 assert.equal(readCount(),7);
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
 const listeners=setup(async key=>key==='panel:getSummary'?summary({adminIncidentCount:++reads}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.equal(readCount(),1);
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')({issueKey:'T-1'}));await flush();
 assert.equal(readCount(),2);
 await act(()=>root.unmount());root=null;assert.equal(listeners.size,0);
});

test('a decision in another app surface refreshes this panel',async()=>{
 let reads=0;
 const listeners=setup(async key=>key==='panel:getSummary'?summary({adminIncidentCount:++reads}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(listeners.has('VA_ISSUE_CHANGED'));
 await act(()=>listeners.get('VA_ISSUE_CHANGED')({issueKey:'T-1'}));await flush();
 assert.equal(readCount(),2);
});

test('window focus reloads the panel without any polling interval',async()=>{
 let reads=0;
 setup(async key=>key==='panel:getSummary'?summary({adminIncidentCount:++reads}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.equal(readCount(),1);
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.equal(readCount(),2);
});

test('returning to a visible document refreshes, and a hidden document does not',async()=>{
 let reads=0;let visibility='visible';
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
 try{
  setup(async key=>key==='panel:getSummary'?summary({adminIncidentCount:++reads}):{restores:[]});
  await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
  visibility='hidden';await act(()=>document.dispatchEvent(new window.Event('visibilitychange')));await flush();
  assert.equal(reads,1,'a hidden document must not refresh');
  visibility='visible';await act(()=>document.dispatchEvent(new window.Event('visibilitychange')));await flush();
  assert.equal(reads,2);assert.equal(readCount(),2);
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
 await act(()=>pending[0].resolve(summary({adminIncidentCount:1})));await flush();
 assert.equal(readCount(),1);
 assert.equal(calls,2,'a trigger that arrived mid-flight must still be honoured once the current request settles');
 await act(()=>pending[1].resolve(summary({adminIncidentCount:2})));await flush();
 assert.equal(readCount(),2);
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

test('an ineligible observer sees the baseline and who can act, but no decision control',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({tier:'observer',state:'Waiting on a signature from QA',
  transitions:[transition({canApprove:false,capturesBaseline:true,blocksOnDrift:true,requiredAssurance:'BIOMETRIC'})],
  baseline:baseline({approvedName:'Priya',version:3,assuranceLevel:'ESIGNATURE',totalFieldCount:12}),
  latestApproval:{decision:'REJECT',state:'CONSUMED',actorName:'Sam',decidedAt:500,transitionId:'5'},
  restore:{restoreId:'r1',state:'COMPLETE',attempted:1,succeeded:1,failed:0,skipped:0}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 const t=text();
 assert.match(t,/Baseline version 3/);
 assert.match(t,/only QA can approve/,'a clear explanation replaces the controls');
 assert.doesNotMatch(t,/Control state|Current status|Controlled transitions/,'the facts grid is gone from the panel');
 assert.equal(clickButton(/^Approve/),undefined);assert.equal(clickButton(/Reject/),undefined);
});

test('an observer with nothing to sign sees no decision action buttons',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({tier:'observer',state:'Waiting on a signature from SDE-1'}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
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

test('exactly one applicable action is shown directly, without a selector, labelled "Approve to destination"',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([transition(),transition({transitionId:'8',canApprove:false,toStatusName:'Rejected',label:'Sign to move to Rejected'})]):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.equal(fieldSelect('Approval transition'),undefined,'a single applicable action must never show a selector');
 assert.ok(clickButton('Approve to Done'));
 assert.equal(clickButton('Approve to Rejected'),undefined,'an action the viewer cannot perform is a fact, not a control');
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
 const approve=clickButton('Approve to Blocked');
 assert.ok(approve);assert.equal(approve.closest('details'),null);
});

test('My Approvals opens the review window for a work item instead of embedding a panel in the row',async()=>{
 const reads=[];
 setup(async key=>{
  if(key==='queue:list'){reads.push(key);return {success:true,items:[
   {issueId:'1',issueKey:'T-1',summary:'Current record',status:'In Progress',state:'x',baselineVersion:3,driftCount:2,materialCount:1,lastDriftAt:Date.now()-2*86_400_000},
   {issueId:'2',issueKey:'T-2',summary:'Another',status:'Ready',state:'x',baselineVersion:0,driftCount:0,materialCount:0,transitionCount:1,transitionName:'Approve'}]};}
  return {restores:[]};
 });
 await act(()=>root.render(h(QueueList)));await flush();
 assert.match(text(),/Waiting on you\s*2/);
 assert.match(text(),/Changes to decide\s*1/);
 assert.match(text(),/Transitions to sign\s*1/);
 await act(()=>clickButton('Review').click());await flush();
 const modals=globalThis.panelTransport.modals??[];
 assert.equal(modals.length,1,'Review opens one review window');
 assert.deepEqual(modals[0].context,{view:'review',issueKey:'T-1',tab:'changes'});
 assert.equal(fieldSelect('Approval transition'),undefined,'nothing is embedded in the row any more');
 await act(()=>container.querySelector('[aria-label="AI summary for T-1"]').click());
 assert.equal(modals[1].context.tab,'summary');
 await act(async()=>{modals[0].onClose({decided:true});});await flush();
 assert.equal(reads.length,2,'closing the window re-reads the list');
});

test('My approvals groups the work into changes, restores and transitions, most urgent first, each saying what it needs',async()=>{
 const calls=[];
 setup(async(key,payload)=>{
  calls.push([key,payload]);
  if(key==='queue:list')return {success:true,nextPageToken:null,items:[
   {issueId:'5',issueKey:'T-5',summary:'Move me',status:'Ready',state:'BASELINED',baselineVersion:1,driftCount:0,materialCount:0,kind:'TRANSITION',transitionCount:1,transitionLabel:'Sign to move to Done',pendingMove:true},
   {issueId:'1',issueKey:'T-1',summary:'Edited',status:'Done',state:'DRIFTED',baselineVersion:3,driftCount:2,materialCount:1,kind:'CHANGES',note:'LINK_RECORDING',waitingSince:Date.now()-86_400_000},
   {issueId:'2',issueKey:'T-2',summary:'Half done',status:'Done',state:'DRIFTED',baselineVersion:3,driftCount:0,materialCount:0,kind:'CHANGES',note:'DECISION_INCOMPLETE',waitingSince:null},
   {issueId:'3',issueKey:'T-3',summary:'Mine to retry',status:'Done',state:'ERROR',baselineVersion:2,driftCount:1,materialCount:1,kind:'RESTORE',restoreId:'cmVzdG9yZQ==',restoreState:'PARTIAL',canRetry:true,waitingSince:Date.now()-3_600_000},
   {issueId:'4',issueKey:'T-4',summary:'Someone else rejected',status:'Done',state:'ERROR',baselineVersion:2,driftCount:1,materialCount:1,kind:'RESTORE',restoreId:'b3RoZXI=',restoreState:'FAILED',canRetry:false,waitingSince:Date.now()-7_200_000}
  ]};
  if(key==='restore:retry')return {success:true,state:'RESTORING'};
  return {};
 });
 await act(()=>root.render(h(QueueList)));await flush();
 const headings=[...container.querySelectorAll('.va-card__title, h2, h3')].map(e=>e.textContent).filter(t=>/to decide|to finish|to sign/.test(t));
 assert.deepEqual(headings,['Changes to decide','Restores to finish','Transitions to sign']);
 assert.match(text(),/Restores to finish\s*2/);
 assert.match(text(),/A linked work item's approval is being recorded here/);
 assert.match(text(),/The last decision on this work item did not finish/);
 assert.match(text(),/Approved — retry the move/);
 assert.match(text(),/Only the reviewer who rejected can retry it\. You can approve or reject the changes again\./);
 const retries=[...container.querySelectorAll('button')].filter(b=>b.textContent==='Retry restore');
 assert.equal(retries.length,1,'Retry only on the restore this reviewer rejected');
 await act(()=>retries[0].click());await flush();
 assert.deepEqual(calls.find(([key])=>key==='restore:retry')[1],{issueKey:'T-3',restoreId:'cmVzdG9yZQ=='});
 assert.equal(calls.filter(([key])=>key==='queue:list').length,2,'the list re-reads after a retry');
});

test('My approvals never says nothing waits while there is more to search',async()=>{
 setup(async key=>key==='queue:list'?{success:true,items:[],nextPageToken:'40'}:{});
 await act(()=>root.render(h(QueueList)));await flush();
 assert.doesNotMatch(text(),/Nothing waits on your signature/);
 assert.ok(clickButton('Keep looking'));
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
 assert.equal(clickButton('Approve to Done'),undefined,'with two siblings nothing is chosen on the reviewer\'s behalf');
 await act(()=>selectValue(select,'7'));
 await act(()=>clickButton('Approve to Done').click());await flush();
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
 assert.match(text(),/1 change since/);
 assert.ok(clickButton('Approve changes'),'the drift decision must be reachable');
 assert.ok(clickButton(/Reject and restore/i),'and so must its refusal');
 assert.doesNotMatch(text(),/Nothing needs a signature/);
});

test('a work item with no baseline says so in one line',async()=>{
 const calls=[];
 setup(async key=>{calls.push(key);return key==='panel:getSummary'?summary({controlled:false,state:'Nothing needs a signature at this status'}):{restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/No baseline yet/);
 assert.ok(!calls.includes('restore:getState'),'restoration detail is only read when the summary reports a restoration');
});

test('a work item a parent restore rewrote says so, naming the parent',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({restore:null,restoredVia:{restoreId:'r1',parentIssueId:2,parentIssueKey:'T-2',state:'COMPLETE',finishedAt:1700000000000,baselineVersion:4}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Restored and verified through T-2's rejection/);
});

test('a parent restore that only partly landed says so rather than claiming a clean restore',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({restore:null,restoredVia:{restoreId:'r1',parentIssueId:2,parentIssueKey:'T-2',state:'PARTIAL',finishedAt:1700000000000,baselineVersion:4}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Partly restored through T-2's rejection/);
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
 const approve=clickButton('Approve to Done');
 assert.ok(approve);assert.equal(approve.disabled,false);
 assert.equal(clickButton('Reject and restore'),undefined);
 await act(()=>approve.click());await flush();
 assert.match(text(),/Approve this edge/);
});

test('a clean controlled transition is signed for the named move, not generic approval',async()=>{
 setup(async()=>({}));
 const data=actor([transition({name:'Selected for Development',toStatusName:'Selected for Development',label:'Sign to move to Selected for Development',meaning:'Ready for development'})]);
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));await flush();
 assert.ok(clickButton('Approve to Selected for Development'));
 assert.ok(!clickButton('Approve'),'the button must say what transition is being signed');
});

test('the signing screen displays the exact meaning returned by the server challenge',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk({meaning:'I reject and restore the approved record'}):{});
 const data=actor([transition({meaning:'Different transition declaration'})],{baseline:baseline(),drift:driftOn()});
 await act(()=>root.render(h(ApprovalControls,{summary:data,evidence:evidence(),onDone:async()=>{}})));
 await act(()=>clickButton('Reject and restore').click());await flush();
 assert.match(text(),/I reject and restore the approved record/);
 assert.doesNotMatch(text(),/Different transition declaration/);
});

test('non-capturing approval never promises a baseline',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk({meaning:'Approve for release'}):{});
 const data=actor([transition({meaning:'Approve for release',capturesBaseline:false})]);
 await act(()=>root.render(h(ApprovalControls,{summary:data,onDone:async()=>{}})));
 await act(()=>clickButton('Approve to Done').click());await settle();
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
 assert.match(text(),/Recreates 5 missing work items/i);
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
 assert.ok(clickButton('Approve to Done'));
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
 await act(()=>clickButton('Approve to Done').click());await settle();
 await settle();
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
 await act(()=>clickButton('Approve to Done').click());await settle();
 await settle();
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
 const setupButton=clickButton(/Register this device/);
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
 assert.ok(clickButton('Approve to 2'),'the reviewer must be able to start the signature');
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
  await act(()=>root.render(h(ApprovalControls,{summary:data,evidence:evidence(),onDone:async()=>{}})));await settle();
  assert.doesNotMatch(text(),/Approval transition/);
  await act(()=>clickButton(button).click());await settle();
  const challenge=calls.find(([k])=>k==='signature:challenge');
  assert.equal(challenge[1].decision,decision);
  assertNoServerOwnedFacts(challenge[1],`${decision} challenge`);
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
 await act(()=>root.render(h(ApprovalControls,{summary:data,evidence:evidence(),onDone:async()=>{}})));await settle();
 assert.doesNotMatch(text(),/Approval transition/);
 await act(()=>clickButton('Approve changes').click());await settle();
 assert.match(text(),/A small window opens for Face ID, Touch ID or Windows Hello/,'the method is the last line of the same sheet');
 assertNoServerOwnedFacts(calls.find(([k])=>k==='signature:challenge')[1],'biometric drift challenge');
 await settle();
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
 await act(()=>clickButton('Approve to Done').click());await flush();
 assert.match(text(),/Statement for edge 5/);
 await signWithCode();await flush();
 assert.match(text(),/That code was not accepted/);
 await act(()=>typeInto(codeBox(),'654321'));
 // One change of selection, observed before any further async work runs.
 await act(()=>selectValue(fieldSelect('Approval transition'),optionFor('Any status -> Done')));
 assert.doesNotMatch(text(),/Statement for edge 5/,'the open challenge for the old edge is withdrawn');
 assert.doesNotMatch(text(),/That code was not accepted/,'errors from the old edge are cleared');
 assert.equal(codeBox(),null,'the code typed for the old edge is gone');
 await flush();
 assert.equal(calls.filter(([k])=>k==='panel:getEvidence').length,1,'action selection does not create a competing evidence read');
 await act(()=>clickButton('Approve to Done').click());await flush();
 assert.match(text(),/Statement for edge 6/);
 assert.equal(codeBox().value,'','the code typed for the old edge does not carry to the new one');
});

test('switching the selected action clears in-flight progress and a late challenge never opens for the new action',async()=>{
 const pending=deferred();
 setup(key=>key==='signature:challenge'?pending.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition(),blocked()]),onDone:async()=>{}})));
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 await act(()=>clickButton('Approve to Done').click());
 assert.match(liveStatus().textContent,/Preparing signature/);
 await act(()=>selectValue(fieldSelect('Approval transition'),'6'));
 assert.doesNotMatch(text(),/Preparing signature/,'progress for the old action must not survive');
 assert.equal(clickButton('Approve to Blocked').disabled,false,'the new action is immediately usable');
 await act(()=>pending.resolve(challengeOk({meaning:'Old edge statement'})));await flush();
 assert.doesNotMatch(text(),/Old edge statement/);
 assert.equal(clickButton('Sign and approve'),undefined);
});

test('a success message for one action does not survive choosing another',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:true,approvalId:'a',transitioned:true}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition(),blocked()]),onDone:async()=>{}})));
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
 await act(()=>clickButton('Approve to Done').click());await flush();
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
 await act(()=>clickButton('Approve to Blocked').click());await flush();
 assert.match(text(),/Blocked statement/);
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();
 assert.doesNotMatch(text(),/Blocked statement/,'a challenge for an action that lost eligibility is withdrawn');
 assert.equal(clickButton('Sign and approve'),undefined);
 assert.equal(clickButton('Approve to Blocked'),undefined);
 assert.match(text(),/no longer available/,'the reviewer is told why the action vanished');
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();
 assert.equal(clickButton(/^Approve/),undefined,'no action remains once none is authorized');
});

test('duplicate clicks on the primary action are disabled synchronously, before the network resolves',async()=>{
 let calls=0;const pending=deferred();
 setup(key=>{if(key!=='signature:challenge')return Promise.resolve({});calls++;return pending.promise;});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 const button=clickButton('Approve to Done');
 await act(()=>{button.click();button.click();button.click();});
 assert.equal(calls,1,'only the first click may reach the resolver');
 assert.equal(clickButton('Preparing signature').disabled,true);
 await act(()=>pending.resolve(challengeOk()));await flush();
});

test('duplicate clicks on Sign are disabled synchronously',async()=>{
 let submits=0;const pending=deferred();
 setup(key=>{if(key==='signature:challenge')return Promise.resolve(challengeOk());if(key==='signature:submit'){submits++;return pending.promise;}return Promise.resolve({});});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve to Done').click());await flush();
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
 await act(()=>clickButton('Approve to Done').click());
 assert.match(liveStatus().textContent,/Preparing signature/);
 await act(()=>challenge.resolve(challengeOk()));await flush();
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign and approve').click());
 assert.match(liveStatus().textContent,/Publishing baseline/,'capturing an edge must announce baseline publication');
 await act(()=>submit.resolve({success:true,approvalId:'a',transitioned:true}));await flush();
});

test('a non-capturing transition announces "Moving to Done", not "Publishing baseline"',async()=>{
 const submit=deferred();
 setup(key=>key==='signature:challenge'?Promise.resolve(challengeOk()):key==='signature:submit'?submit.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition({capturesBaseline:false})]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve to Done').click());await flush();
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
 await act(()=>clickButton('Approve to Done').click());await flush();
 await act(()=>clickButton('Sign and approve').click());
 assert.match(liveStatus().textContent,/Checking biometric/);
 assert.equal(clickButton('Checking biometric').disabled,true);
});

test('a drift rejection announces "Starting restoration"',async()=>{
 const submit=deferred();
 setup(key=>key==='signature:challenge'?Promise.resolve(challengeOk({meaning:'Reject'})):key==='signature:submit'?submit.promise:Promise.resolve({}));
 await act(()=>root.render(h(ApprovalControls,{summary:actor([],{baseline:baseline(),drift:driftOn()}),evidence:evidence(),onDone:async()=>{}})));
 await act(()=>clickButton('Reject and restore').click());await flush();
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
 assert.doesNotMatch(text(),/Restoration in progress/);
});

test('a finished restore leaves its card and is recorded as one line on the Baseline card',async()=>{
 let restoreState='RESTORING';
 const finishedAt=Date.UTC(2026,8,26,16,29);
 const listeners=setup(async key=>{
  if(key==='panel:getSummary')return summary({baseline:baseline({version:3}),restore:{restoreId:'r1',state:restoreState,attempted:1,succeeded:0,failed:0,skipped:0,
   finishedAt:restoreState==='COMPLETE'?finishedAt:null,baselineVersion:3}});
  if(key==='restore:getState')return {restores:[{restore_id:'r1',state:restoreState,actorName:'Priya Raman',baselineVersion:3,
   finishedAt:restoreState==='COMPLETE'?finishedAt:null}]};
  return {};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Restoration results/,'a running restore has a card of its own');
 assert.equal(container.querySelector('.va-base .va-base__restore'),null);

 restoreState='COMPLETE';
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();await flush();
 assert.doesNotMatch(text(),/Restoration results/,'the card goes once the restore has finished');
 const line=container.querySelector('.va-base .va-base__restore');
 assert.ok(line,'the outcome is part of the Baseline card');
 assert.match(line.textContent,/Restored and verified/);
 assert.match(line.textContent,/Back to version 3 · by Priya Raman/);
 assert.equal(clickButton('Retry restore'),undefined,'nothing to retry after a verified restore');
});

test('a restore to an earlier version is not shown on a newer baseline',async()=>{
 // Restored to version 2 at 15:56, then version 3 was signed at 15:57. The
 // restore is version 2's history; on version 3's card it read as if version
 // 3 had been restored to version 2. The review window's record keeps it.
 const restoredAt=Date.UTC(2026,8,28,10,26);
 const signedAt=Date.UTC(2026,8,28,10,27);
 setup(async key=>{
  if(key==='panel:getSummary')return summary({baseline:baseline({version:3,transitionAt:signedAt,capturedAt:signedAt}),
   restore:{restoreId:'r1',state:'COMPLETE',attempted:1,succeeded:1,failed:0,skipped:0,finishedAt:restoredAt,baselineVersion:2}});
  if(key==='restore:getState')return {restores:[{restore_id:'r1',state:'COMPLETE',actorName:'Priya Raman',baselineVersion:2,finishedAt:restoredAt}]};
  return {};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 assert.match(text(),/Baseline version 3/);
 assert.equal(Boolean(container.querySelector('.va-base__restore')),false,'a superseded restore is not a fact about the current baseline');
 assert.doesNotMatch(text(),/Back to version 2/);
});

test('a restore with no recorded version is shown only if it finished after the baseline was signed',async()=>{
 const signedAt=Date.UTC(2026,8,28,10,27);
 for(const [finishedAt,shown] of [[signedAt-60_000,false],[signedAt+60_000,true]]){
  setup(async key=>{
   if(key==='panel:getSummary')return summary({baseline:baseline({version:3,transitionAt:signedAt,capturedAt:signedAt}),
    restore:{restoreId:'r1',state:'COMPLETE',attempted:1,succeeded:1,failed:0,skipped:0,finishedAt,baselineVersion:null}});
   if(key==='restore:getState')return {restores:[{restore_id:'r1',state:'COMPLETE',finishedAt}]};
   return {};
  });
  await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
  assert.equal(Boolean(container.querySelector('.va-base__restore')),shown);
  await act(()=>root.unmount());root=null;
 }
});

test('a failed restore is recorded with Retry, and what did not match stays behind a closed Details',async()=>{
 setup(key=>key==='restore:getState'?Promise.resolve({restores:[{restore_id:'r1',state:'FAILED',actorName:'Sam Ortiz',baselineVersion:2,
  detail:[{unmatched:[{fieldName:'Due date',issueKey:'T-2',reason:'Jira kept 2026-10-28'}]}]}]}):Promise.resolve({}));
 await act(()=>root.render(h(RestoreStatus,{issueKey:'T-1',restore:{restoreId:'r1',state:'FAILED',attempted:1,succeeded:0,failed:1,skipped:0,baselineVersion:2}})));await flush();
 const line=container.querySelector('.va-restore-line');
 assert.match(line.textContent,/Restore failed/);
 assert.match(line.textContent,/Restoring version 2 · by Sam Ortiz/);
 assert.ok(clickButton('Retry restore'));
 const details=line.querySelector('details');
 assert.equal(details.open,false,'details are there on request, not in the way');
 assert.match(details.textContent,/Due date on T-2 — Jira kept 2026-10-28/);
 assert.doesNotMatch(text(),/Restoration results/);
});

// ── Accessibility ─────────────────────────────────────────────────────────

test('the selector is labelled, progress is a live status, and Enter in the code box signs',async()=>{
 const submit=deferred();const calls=[];
 setup((key)=>{calls.push(key);if(key==='signature:challenge')return Promise.resolve(challengeOk());if(key==='signature:submit')return submit.promise;return Promise.resolve({});});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition(),blocked()]),onDone:async()=>{}})));
 const select=fieldSelect('Approval transition');
 assert.equal(select.closest('label')?.querySelector('.va-label')?.textContent,'Approval transition','the selector must carry its label');
 await act(()=>selectValue(select,'5'));
 await act(()=>clickButton('Approve to Done').click());await flush();
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>codeBox().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 assert.ok(calls.includes('signature:submit'),'Enter in the code box must sign without a pointer');
 assert.match(liveStatus().textContent,/Moving to Done/);
 assert.equal(clickButton('Moving to Done').disabled,true);
 await act(()=>submit.resolve({success:true,approvalId:'a',transitioned:true}));await flush();
});

// ── Evidence: authoritative, shared, and never shown as clean while loading ─

test('evidence is requested for every baselined item before clean state is shown',async()=>{
 const calls=[];
 setup(async key=>{calls.push(key);return key==='panel:getSummary'?summary({baseline:baseline()}):{restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(calls.includes('panel:getEvidence'),'a baselined item must receive a current evidence read');
});

test('controls stay visible but disabled while authoritative evidence loads',async()=>{
 const evidenceRead=deferred();const calls=[];
 setup(key=>{calls.push(key);
  if(key==='panel:getSummary')return Promise.resolve(actor([transition()],{baseline:baseline()}));
  if(key==='panel:getEvidence')return evidenceRead.promise;
  return Promise.resolve({restores:[]});
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.ok(calls.includes('panel:getEvidence'));
  assert.ok(calls.includes('panel:getEvidence'));
 assert.match(text(),/Checking for changes/);
 assert.ok(clickButton('Approve to Done'),'the primary control remains visible while evidence is loading');
 assert.equal(clickButton('Approve to Done').disabled,true,'the primary control stays disabled until current evidence arrives');
 await act(()=>evidenceRead.resolve(evidence()));await flush();
 assert.match(text(),/Matches/);
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
  assert.match(text(),/could not be loaded/);
 assert.doesNotMatch(text(),/Checking the current record/,'an evidence failure must replace the loading state');
 assert.ok(clickButton('Approve to Done'),'controls remain visible after an evidence failure');
 assert.equal(clickButton('Approve to Done').disabled,true,'controls stay disabled until a current evidence retry succeeds');
 await act(()=>clickButton('Retry').click());await flush();
 assert.equal(evidenceCalls,2);
 assert.equal(summaryCalls,1,'an evidence retry must not reset the whole panel');
 assert.doesNotMatch(text(),/could not be loaded/);
});

test('one authoritative evidence read is shared when the selected workflow action changes',async()=>{
 const requests=[];
 setup(key=>{
  if(key==='panel:getSummary')return Promise.resolve(actor([transition(),blocked()],{baseline:baseline()}));
  if(key==='panel:getEvidence'){const d=deferred();requests.push(d);return d.promise;}
  return Promise.resolve({restores:[]});
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));
  assert.equal(requests.length,1);
 await act(()=>selectValue(fieldSelect('Approval transition'),'6'));await flush();
 assert.equal(requests.length,1,'action selection does not create a second competing evidence read');
 await act(()=>requests[0].resolve(evidence()));await flush();
 assert.match(text(),/Matches/,'the loaded evidence belongs to the current baseline, not to one transition option');
 await act(()=>selectValue(fieldSelect('Approval transition'),'5'));await flush();
 assert.equal(requests.length,1,'switching workflow actions must not create a contradictory evidence projection');
 assert.match(text(),/Matches/);
});

test('evidence for a superseded baseline is discarded unseen, refreshes the summary, and reloads for the new version',async()=>{
 let summaryReads=0;const evidenceRequests=[];
 setup(async(key,payload)=>{
  if(key==='panel:getSummary'){summaryReads++;return actor([],{baseline:baseline({version:summaryReads===1?1:2}),drift:driftOn()});}
  if(key==='panel:getEvidence'){evidenceRequests.push(payload);
   return payload.expectedBaselineVersion===1
    ?evidence({baselineVersion:2,drift:{fields:[],changedFields:[1,2,3,4,5,6,7]}})
    :evidence({baselineVersion:2,drift:{fields:[{fieldId:'a',fieldName:'A',kind:'scalar'},{fieldId:'b',fieldName:'B',kind:'scalar'}],changedFields:[1,2]}});}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));
 for(let i=0;i<4;i++){await flush();assert.doesNotMatch(text(),/Baseline version 1/,'evidence from another baseline version must never render');}
 assert.equal(summaryReads,2,'a newer authoritative baseline refreshes the summary');
 assert.deepEqual(evidenceRequests.map(p=>p.expectedBaselineVersion),[1,2]);
 assert.equal(container.querySelectorAll('.va-change-row').length,2,'the new version\'s changes are listed');
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

test('a same-baseline Jira refresh reloads evidence when the review version advances',async()=>{
 let summaryReads=0,evidenceReads=0;
 const listeners=setup(async key=>{
  if(key==='panel:getSummary'){summaryReads++;return actor([],{baseline:baseline(),drift:driftOn(),evidenceVersion:summaryReads});}
  if(key==='panel:getEvidence')return evidenceWithChange(++evidenceReads===1?'Before event':'After event');
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
  assert.match(text(),/Before event/);
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();await flush();
 assert.equal(summaryReads,2);
 assert.equal(evidenceReads,2,'same baseline, newer review version must invalidate current-record evidence');
 assert.match(text(),/After event/);
 assert.doesNotMatch(text(),/Before event/);
});

test('a background refresh keeps the change list on screen while evidence reloads, but no decision can use it',async()=>{
 let summaryReads=0;const evidenceReads=[];
 const listeners=setup(key=>{
  if(key==='panel:getSummary'){summaryReads++;return Promise.resolve(actor([],{baseline:baseline(),drift:driftOn(),evidenceVersion:summaryReads}));}
  if(key==='panel:getEvidence'){const d=deferred();evidenceReads.push(d);return d.promise;}
  return Promise.resolve({restores:[]});
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 await act(()=>evidenceReads[0].resolve(evidenceWithChange('Before event')));await flush();
  assert.match(text(),/Before event/);
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();await flush();
 assert.equal(evidenceReads.length,2,'the newer review version is re-read');
 assert.doesNotMatch(text(),/Checking the current record/,'a refresh must not blank the panel');
 assert.match(text(),/Before event/,'the previous read stays on screen while its replacement loads');
 assert.ok([...container.querySelectorAll('button')].filter(b=>/approve|reject|sign/i.test(b.textContent)).every(b=>b.disabled),
  'decisions wait for the authoritative read');
 await act(()=>evidenceReads[1].resolve(evidenceWithChange('After event')));await flush();
 assert.match(text(),/After event/);
 assert.doesNotMatch(text(),/Before event/);
});

test('a background refresh that fails keeps the loaded panel and shows no error',async()=>{
 let reads=0;
 const listeners=setup(async key=>{
  if(key==='panel:getSummary'){if(++reads>1)throw new Error('Tunnel could not be reached');return summary({adminIncidentCount:5});}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.ok(reads>=3);
 assert.equal(readCount(),5);
 assert.doesNotMatch(text(),/Tunnel could not be reached|Refresh before making an approval decision/);
});

test('a refresh someone asks for still reports its failure, even if it joined a background one',async()=>{
 let reads=0;const pending=[];
 setup(key=>{
  if(key==='panel:getSummary'){if(++reads===1)return Promise.resolve(summary({state:'Loaded state'}));const d=deferred();pending.push(d);return d.promise;}
  return Promise.resolve({restores:[]});
 });
 let api;
 function Probe(){api=usePanelState('T-1');return h('div',{children:api.error||api.state?.state||''});}
 await act(()=>root.render(h(Probe)));await flush();
 let joined;
 await act(()=>{void api.refresh({background:true});joined=api.refresh();});
 await act(()=>pending[0].reject(new Error('Service unavailable')));await flush();
 if(pending[1])await act(()=>pending[1].reject(new Error('Service unavailable')));
 await act(()=>joined);await flush();
 assert.match(text(),/Service unavailable/);
});

test('the context lozenge keeps its last state when a later refresh fails',async()=>{
 let reads=0;
 const listeners=setup(async key=>{if(key==='panel:getGlanceState'){if(++reads>1)throw new Error('Tunnel could not be reached');return {state:'BASELINED',baselineVersion:3};}return {};});
 await act(()=>root.render(h(IssueContext)));await flush();
 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());await flush();
 assert.equal(reads,2);
 assert.match(text(),/Signed/);
 assert.doesNotMatch(text(),/Tunnel could not be reached/);
});

test('My approvals refreshes in the background without the busy state or an error flash',async()=>{
 let reads=0;const second=deferred();
 const listeners=setup(key=>{
  if(key==='queue:list'){if(++reads===1)return Promise.resolve({success:true,items:[{issueId:'1',issueKey:'T-1',summary:'First',status:'Open',state:'DRIFTED',baselineVersion:1,driftCount:1,materialCount:1}]});return second.promise;}
  return Promise.resolve({});
 });
 await act(()=>root.render(h(QueueList)));await flush();
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();
 assert.equal(clickButton('Refresh').disabled,false,'a background reload does not lock the Refresh button');
 await act(()=>second.reject(new Error('Tunnel could not be reached')));await flush();
 assert.match(text(),/First/);
 assert.doesNotMatch(text(),/Tunnel could not be reached/);
});

// A rejection's restore runs as a queued job AFTER the submit returns, so the
// redraw ApprovalControls asks for on submit lands before any field changed.
// The panel watches a running restore itself and redraws Jira once it ends.
const restoring=(state)=>({restoreId:'r1',state,succeeded:0,failed:0,skipped:0});
test('a running restore is checked quietly until it ends, and Jira is redrawn once when it does',async()=>{
 let reads=0;
 setup(async key=>{
  if(key==='panel:getSummary'){reads++;return summary({restore:restoring(reads<3?'RESTORING':'COMPLETE')});}
  if(key==='restore:getState')return {restores:[]};
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.equal(globalThis.panelTransport.redraws??0,0);
 for(let i=0;i<3;i++){await act(async()=>{await new Promise(r=>setTimeout(r,2700));});await flush();}
 assert.ok(reads>=3,`the panel keeps checking a running restore (reads: ${reads})`);
 assert.equal(globalThis.panelTransport.redraws,1,'Jira is redrawn once the restore has written its fields');
 const settled=reads;
 await act(async()=>{await new Promise(r=>setTimeout(r,2800));});await flush();
 assert.equal(reads,settled,'no more polling once the restore has ended');
});

// A link approved on the other issue is recorded here by a queued job a few
// seconds later (jobs/linkWorker.js). Until then the panel says so, and checks
// quietly until it lands, then stops.
const pendingDrift=(pending)=>({count:1,materialCount:1,decidesDrift:true,policyIncomplete:false,canApprove:true,canReject:true,eligible:true,
 linkPending:pending?[{decidedOnKey:'VAT-30',queuedAt:1}]:[]});
test('a link approved on the other issue is checked quietly until it is recorded here, then no more',async()=>{
 let reads=0;
 setup(async key=>{
  if(key==='panel:getSummary'){reads++;return summary({drift:reads<3?pendingDrift(true):pendingDrift(false)});}
  return {restores:[]};
 });
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 for(let i=0;i<3;i++){await act(async()=>{await new Promise(r=>setTimeout(r,2700));});await flush();}
 assert.ok(reads>=3,`the panel keeps checking while the link is on its way (reads: ${reads})`);
 const settled=reads;
 await act(async()=>{await new Promise(r=>setTimeout(r,2800));});await flush();
 assert.equal(reads,settled,'no more checking once it has been recorded');
});

test('the baseline card says which issue the pending link was approved on',async()=>{
 const evidence={baselineId:'b',baselineVersion:3,record:null,rejection:{deleteIssueKeys:[],recreateCount:0},restoreHistory:[],
  drift:{count:1,materialCount:1,fields:[]}};
 const text=(await renderInto(React.createElement(BaselineSection,{summary:summary({baseline:baseline({version:3}),drift:pendingDrift(true)}),
  drift:pendingDrift(true),evidence,evidenceReady:true,onOpenReview:()=>{}}))).textContent;
 assert.match(text,/The link approved on VAT-30 is being recorded here; this updates on its own\./);
});

test('opening a panel on an old, finished restore does not redraw Jira',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({restore:restoring('COMPLETE')}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.equal(globalThis.panelTransport.redraws??0,0);
});

// ── Event ownership: exactly one event per durable mutation ──────────────

test('a successful durable mutation emits VA_ISSUE_CHANGED exactly once',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:true,approvalId:'a',transitioned:true}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve to Done').click());await settle();
 await signWithCode();await settle();
 assert.equal(globalThis.panelTransport.emitted.length,1,'no component may emit a duplicate event alongside the centralised bridge emission');
 assert.deepEqual(globalThis.panelTransport.emitted[0],['VA_ISSUE_CHANGED',{issueKey:'T-1'}]);
});

test('an unavailable admin incident read is explicit instead of looking like no incidents',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({adminIncidentUnavailable:true}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(text(),/Workflow control status is temporarily unavailable/);
 assert.doesNotMatch(text(),/workflow control incident has been recorded/i);
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
 await act(()=>clickButton('Approve to Done').click());await flush();
 await signWithCode();
 for(let i=0;i<4;i++)await flush();
 assert.equal(globalThis.panelTransport.emitted.length,1);
 const after=reads-before;
 assert.ok(after>=1&&after<=2,`expected one post-action refresh plus at most one coalesced echo, saw ${after}`);
});

test('a resolver-denied submit does not emit VA_ISSUE_CHANGED',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:false,error:'CONTENT_CHANGED'}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve to Done').click());await settle();
 await signWithCode();await settle();
 assert.equal(globalThis.panelTransport.emitted.length,0,'a denied mutation is not durable and must not notify other surfaces');
});

test('a persisted approval followed by a Jira refusal is reported, refreshes views, and cannot reuse the spent signature',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():key==='signature:submit'?{success:true,approvalId:'a',transitioned:false,state:'CONSUMED',transitionError:'Jira refused the transition: a required field is empty.'}:{});
 await act(()=>root.render(h(ApprovalControls,{summary:actor([transition()]),onDone:async()=>{}})));
 await act(()=>clickButton('Approve to Done').click());await settle();
 await signWithCode();await settle();
 assert.match(text(),/Jira refused the transition: a required field is empty/);
 assert.match(text(),/A fresh signature may be required/);
 assert.equal(clickButton('Retry transition'),undefined,'a spent approval is never offered for reuse');
 assert.deepEqual(globalThis.panelTransport.emitted,[['VA_ISSUE_CHANGED',{issueKey:'T-1'}]],'the persisted approval must be visible in every open view even though Jira refused the move');
 assert.equal(clickButton('Approve to Done').disabled,false,'the reviewer can start again without reloading');
});

test('approval and restore resolver outcomes notify other open app views',async()=>{
 setup(async()=>({success:true}));
 for(const key of ['signature:submit','approval:submit','approval:retryTransition','restore:retry']){
  await invoke(key,{issueKey:'T-1'});
 }
 assert.equal(globalThis.panelTransport.emitted.length,4);
 assert.deepEqual(globalThis.panelTransport.emitted[0],['VA_ISSUE_CHANGED',{issueKey:'T-1'}]);
});

test('resolver, validator, and persistence failures never emit VA_ISSUE_CHANGED',async()=>{
 const outcomes=[
  {success:false,error:'DENIED'},
  {success:false,reason:'INSUFFICIENT_ASSURANCE',error:'The device check did not meet the rule.'},
  {error:'The service is unavailable.',reason:'SERVICE_UNAVAILABLE'},
  {ok:false,reason:'WEBAUTHN_CREDENTIAL_UNREACHABLE'}
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
});

test('the issue status display updates to v2 after a decision event',async()=>{
 let version=1;
 const listeners=setup(async()=>({state:'BASELINED',baselineVersion:version}));
 await act(()=>root.render(h(IssueContext)));await flush();
 assert.match(text(),/version 1/);version=2;
 await act(()=>listeners.get('VA_ISSUE_CHANGED')());await flush();
 assert.match(text(),/version 2/);
});

// ── The Custom UI transition-screen field: exact, read-only, fail-closed ─

const fieldContext={extension:{issue:{key:'T-1',id:'10'},issueTransition:{id:'5'}}};
const fieldAction=(over={})=>({transitionId:'5',toStatusId:'2',toStatusName:'Done',name:'Done',meaning:'Bug Resolved',requiredRole:'SDE-1',requiredAssurance:'ESIGNATURE',capturesBaseline:true,blocksOnDrift:true,anyStatus:false,label:'Sign to move to Done',...over});
const signButton=()=>clickButton('Sign');
const fieldState=(requiredAssurance,over={})=>({issue:{key:'T-1',summary:'Bug to close',statusName:'In Progress'},actorName:'Sai Harsha',drift:{evidenceHash:'hash'},blocker:null,
 actions:[fieldAction({requiredAssurance})],...over});

test('the transition screen shows the exact action as read-only facts, never a selector',async()=>{
 setup(async key=>key==='signing:context'?fieldState('BIOMETRIC'):key==='webauthn:status'?{ok:true,enrolled:true,usableHere:true}:{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 const t=text();
 assert.match(t,/In Progress -> Done/,'source and destination');
 assert.match(t,/SDE-1/,'role');
 assert.match(t,/Bug Resolved/,'meaning');
 assert.match(t,/Sai Harsha/,'who is signing');
 assert.match(t,/A small window opens for Face ID, Touch ID or Windows Hello/,'the method is the last line, not a separate screen');
 assert.ok(container.querySelector('.va-sign'),'the same signing sheet as the issue panel');
 assert.equal(container.querySelector('input[type="checkbox"]'),null,'no separate affirmation box');
 assert.equal(container.querySelector('select'),null);
});

test('the transition screen shows unresolved drift instead of biometric or signing controls',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'
  ?fieldState('BIOMETRIC',{actions:[],blocker:'UNDECIDED_DRIFT',drift:{count:2,blocked:true,evidenceHash:'hash'}})
  :{};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/transition blocked/i);
 assert.match(text(),/issue panel or My approvals/i);
 assert.equal(signButton(),undefined);
 assert.equal(codeBox(),null);
 assert.equal(signButton(),undefined);
 assert.ok(!calls.some(([key])=>key==='webauthn:status'||key==='approval:challenge'||key==='approval:submit'));
 assert.equal(globalThis.panelTransport.submitted.at(-1),'','a stale transition receipt must be withdrawn');
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
  const confirm=signButton();
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
  const confirm=signButton();
 await act(()=>{confirm.click();confirm.click();});
 assert.match(liveStatus().textContent,/Preparing signature/);
 assert.equal(clickButton('Preparing signature').disabled,true);
 await act(()=>challenge.resolve({success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'BIOMETRIC'}));await flush();
 assert.match(liveStatus().textContent,/Checking biometric/);
});

test('a resolver call is not followed by a second invocation just to log it',async()=>{
 // The server's resolver wrapper (lib/harnessLogger.js) already logs every
 // call with its duration and outcome; beaconing the client's copy doubled
 // every Forge invocation, background polling included.
 const keys=[];
 setup(async key=>{keys.push(key);return {success:true};});
 await invoke('panel:getSummary',{issueKey:'T-1'});
 await flush();
 assert.deepEqual(keys,['panel:getSummary']);
 assert.ok(getHarnessEvents().some(e=>e.action==='invoke:panel:getSummary'),'still recorded for the diagnostics HUD');
});

test('the diagnostics harness never records an authenticator code, even nested inside a resolver request',async()=>{
 setup(async()=>({success:false,error:'That code could not be verified.'}));
 await invoke('approval:submit',{issueKey:'T-1',challengeId:'c'.repeat(32),code:'343968',confirmed:true});
 setup(async()=>{throw new Error('Tunnel could not be reached');});
 await invoke('signature:submit',{issueKey:'T-1',code:'112233'}).catch(()=>{});
 const logged=JSON.stringify(getHarnessEvents());
 assert.doesNotMatch(logged,/343968|112233/);
 assert.match(logged,/REDACTED_LEN_6/);
});

test('the transition screen withdraws a refused code\'s error as soon as the next code is typed',async()=>{
 setup(async key=>{
  if(key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'ESIGNATURE'};
  if(key==='approval:submit')return {success:false,error:'That code could not be verified.'};
  return {};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
  await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>signButton().click());await settle();
 assert.match(text(),/That code could not be verified/);
 await act(()=>typeInto(codeBox(),'6'));
 assert.doesNotMatch(text(),/That code could not be verified/);
});

test('the transition screen still signs an electronic-signature edge with a code',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'ESIGNATURE'};
  if(key==='approval:submit')return {success:true,approvalId:'a'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
  assert.ok(codeBox(),'an electronic-signature edge must offer the code box');
 assert.equal(signButton().disabled,true,'Sign waits for six digits');
 await act(()=>typeInto(codeBox(),'123456'));await settle();
 assert.ok(!calls.some(([k])=>k==='approval:submit'),'typing records nothing; signing is a deliberate act');
 await act(()=>signButton().click());await settle();
 const submit=calls.find(([k])=>k==='approval:submit');
 assert.ok(submit,'Sign records the approval');
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
  await act(()=>signButton().click());await settle();
 assert.ok(!calls.some(([k])=>k==='approval:submit'),'a refused device check must not record an approval');
 assert.ok(!globalThis.panelTransport.submitted.some(v=>/^[a-f0-9]{32}$/.test(v)),'and must not hand Jira a receipt');
 assert.equal(globalThis.panelTransport.emitted.length,0);
 assert.equal(signButton().disabled,false,'the signer can try again');
});

test('a reviewer without the approver role is told so instead of being offered a signature',async()=>{
 setup(async key=>key==='signing:context'
  ?{...fieldState('BIOMETRIC'),actions:undefined,transitions:[{transitionId:'5',toStatusId:'2',name:'Done',meaning:'Bug Resolved',requiredRole:'SDE-1',requiredAssurance:'BIOMETRIC',eligible:false}]}
  :{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/do not hold the approver role/i);
 assert.equal(signButton(),undefined,'nothing is signable without the role');
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
  await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>signButton().click());await settle();
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
 assert.ok(signButton(),'the exact matching action is signable');
});

test('a missing transition identity fails closed with a legible message and never falls back to a broader read',async()=>{
 const calls=[];const context={extension:{issue:{key:'T-1',id:'10'}}};
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?fieldState('ESIGNATURE'):{};},{context});
 await act(()=>root.render(h(ApprovalField,{context})));await settle();
 assert.match(text(),/reopen the transition dialog/i);
 assert.equal(signButton(),undefined,'nothing can be signed without the exact transition');
 assert.ok(!calls.some(([k])=>k==='panel:getState'||k==='panel:getSummary'||k==='approval:challenge'),'there must be no fallback to a broader read');
});

test('a missing issue on the server side fails closed with a legible message',async()=>{
 setup(async key=>key==='signing:context'?{error:'ISSUE_REQUIRED',reason:'ISSUE_REQUIRED'}:{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/could not determine which work item/i);
 assert.equal(signButton(),undefined);
});

test('an action for a sibling transition is refused rather than signed in place of the exact one',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);return key==='signing:context'?fieldState('ESIGNATURE',{actions:[fieldAction({transitionId:'7',name:'Close as fixed'})]}):{};},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.match(text(),/does not match the transition being performed/);
 assert.equal(signButton(),undefined);
 assert.ok(!calls.some(([k])=>k==='approval:challenge'));
});

test('the transition screen never renders a selector, even if more than one rule were somehow matched',async()=>{
 setup(async key=>key==='signing:context'?fieldState('ESIGNATURE',{actions:[fieldAction(),fieldAction({meaning:'Another statement'})]}):{},{context:fieldContext});
 await act(()=>root.render(h(ApprovalField,{context:fieldContext})));await settle();
 assert.equal(container.querySelector('select'),null,'the transition screen must never render a selector');
 assert.match(text(),/more than one signing rule matched/i);
 assert.equal(signButton(),undefined);
});

// ── Admin: the exact workflow-transition picker (TransitionsPage) ─────────
// admin:listWorkflowTransitions replaces the old free-text from/to status
// inputs with Jira's own live edges, read fresh every time the project or
// work item type changes. See src/usecases/adminDirectory.js and
// src/usecases/transitionsValidation.js for the server-side half.
const oneProject=[{id:'1',key:'ONE',name:'Project one'}];
function transitionsHandler({workflow=[],controlled=[],fail=false,issueTypes=[{id:'2',name:'Bug'}]}={}){
 return async(key)=>{
  if(key==='admin:listControlledTransitions')return {success:true,transitions:controlled};
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

test('an already controlled edge is identified before save and points to its existing rule',async()=>{
 const existing={ctId:'rule-1',revision:'r1',projectId:'1',issueTypeId:'2',transitionId:'2',
  fromStatusId:'10004',toStatusId:'10006',requiredAssurance:'ESIGNATURE',captureBaseline:false,
  requiredRole:'QA',meaning:'Reviewed',projectName:'Project one',issueTypeName:'Bug',
  fromStatusName:'To Do',toStatusName:'Done'};
 setup(transitionsHandler({workflow:[directedEdge()],controlled:[existing]}));
 await act(()=>root.render(h(TransitionsPage,{projects:oneProject})));await flush();
 await chooseScope();
 assert.match(text(),/All transitions in this workflow already have approval rules/);
 await act(()=>selectValue(fieldSelect('Exact transition'),'2:10004'));await flush();
 assert.match(text(),/already has an approval rule/);
 assert.equal(clickButton('Add rule').disabled,true);
 assert.match(text(),/Edit its existing rule below/);
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

test('a restore someone else rejected offers no Retry, and says who can and what this viewer can still do',async()=>{
 setup(key=>key==='restore:getState'?Promise.resolve({restores:[{restore_id:'r1',state:'PARTIAL',actorName:'Sam Ortiz',baselineVersion:2,canRetry:false}]}):Promise.resolve({}));
 await act(()=>root.render(h(RestoreStatus,{issueKey:'T-1',restore:{restoreId:'r1',state:'PARTIAL',attempted:2,succeeded:1,failed:1,skipped:0,baselineVersion:2}})));await flush();
 assert.equal(Boolean(clickButton('Retry restore')),false,'the server refuses anyone but the reviewer who rejected');
 assert.match(text(),/Only Sam Ortiz, who rejected these changes, can retry this restore/);
 assert.match(text(),/You can still approve or reject the changes/);
});

test('a restore ERROR state is labelled "Restore error" and enables Retry restore', async () => {
 let retries = 0;
 setup(key => {
  if (key === 'restore:getState') return Promise.resolve({ restores: [{ restore_id: 'r-err', state: 'ERROR', error: 'Terminal release failed' }] });
  if (key === 'restore:retry') { retries++; return Promise.resolve({ success: true, state: 'RESTORING' }); }
  return Promise.resolve({});
 });
 await act(() => root.render(h(RestoreStatus, {
  issueKey: 'T-1',
  restore: { restoreId: 'r-err', state: 'ERROR', attempted: 1, succeeded: 0, failed: 1, skipped: 0 },
  onDone: async () => {}
 })));
 await flush();
 assert.match(text(), /Restore error/);
 const btn = clickButton('Retry restore');
 assert.ok(btn, 'Retry restore button must be rendered for ERROR state');
 assert.equal(btn.disabled, false);
 await act(() => btn.click());
 await flush();
 assert.equal(retries, 1);
});

test('deviceAuth ignores messages from sources other than the ceremony popup', async () => {
 const originalOpen = window.open;
 try {
  let popup;
  window.open = () => (popup = { closed: false, close() {}, postMessage() {} });
  setup(key => key === 'webauthn:assertStart' ? { ok: true, challengeId: 'c'.repeat(32), options: { challenge: 'abc' } } : {});
  const outcome = deviceAuth.confirmBiometric({ approvalChallengeId: 'c'.repeat(32) });
  await flush();
  // Spoofed message posted with window or another frame as source
  window.dispatchEvent(new window.MessageEvent('message', {
   data: { type: 'webauthn-result', success: true, response: { id: 'spoofed' } },
   origin: window.location.origin,
   source: window
  }));
  await flush();
  const probe = await Promise.race([outcome, new Promise(r => setTimeout(() => r('still waiting'), 20))]);
  assert.equal(probe, 'still waiting', 'spoofed message from non-popup source must be ignored');
  popup.closed = true;
  window.dispatchEvent(new window.Event('focus'));
  const closed = await outcome;
  assert.equal(closed.ok, false);
 } finally {
  window.open = originalOpen;
 }
});

test('drift challenge buttons are disabled when evidence is loading or missing', async () => {
 setup(() => ({}));
 const driftSummary = actor([], { baseline: baseline(), drift: driftOn() });

 // 1. Evidence loading
 await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: null, evidenceLoading: true, onDone: async () => {} })));
 await flush();
 assert.equal(clickButton('Approve changes').disabled, true, 'Approve must be disabled while evidence is loading');
 assert.equal(clickButton('Reject and restore').disabled, true, 'Reject must be disabled while evidence is loading');

 // 2. Evidence missing
 await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: null, evidenceLoading: false, onDone: async () => {} })));
 await flush();
 assert.equal(clickButton('Approve changes').disabled, true, 'Approve must be disabled when evidence is missing');
 assert.equal(clickButton('Reject and restore').disabled, true, 'Reject must be disabled when evidence is missing');

 // 3. Evidence loaded
 await act(() => root.render(h(ApprovalControls, { summary: driftSummary, evidence: evidence(), evidenceLoading: false, onDone: async () => {} })));
 await flush();
 assert.equal(clickButton('Approve changes').disabled, false, 'Approve must be enabled once evidence is loaded');
 assert.equal(clickButton('Reject and restore').disabled, false, 'Reject must be enabled once evidence is loaded');
});

test('TransitionsPage drops stale project lookups when project selection changes rapidly', async () => {
 let resolveP1, resolveP2;
 setup(async (key, payload) => {
  if (key === 'admin:listControlledTransitions') return { success: true, transitions: [] };
  if (key === 'admin:listStatusesForProject') {
   if (payload.projectId === 'P1') return new Promise(r => { resolveP1 = () => r({ success: true, statuses: [{ id: 's1', name: 'Status 1' }] }); });
   if (payload.projectId === 'P2') return new Promise(r => { resolveP2 = () => r({ success: true, statuses: [{ id: 's2', name: 'Status 2' }] }); });
  }
  if (key === 'admin:listIssueTypesForProject') return { success: true, issueTypes: [{ id: 'it1', name: 'Story' }] };
  return { success: true };
 });
 await act(() => root.render(h(TransitionsPage, { projects: [{ id: 'P1', name: 'Project 1' }, { id: 'P2', name: 'Project 2' }] })));
 await flush();
 await act(() => selectValue(fieldSelect('Project'), 'P1'));
 await flush();
 await act(() => selectValue(fieldSelect('Project'), 'P2'));
 await flush();
 // Resolve P1 AFTER P2
 await act(() => resolveP2());
 await flush();
 await act(() => resolveP1());
 await flush();
 assert.doesNotMatch(text(), /Status 1/, 'Stale P1 status response must not overwrite P2 statuses');
});

// ── A table renders as a table ────────────────────────────────────────────────
//
// The backend now emits one block per table ROW carrying its cells (see
// src/lib/diff/adf.js). A table added after approval used to arrive here as one
// inserted block per CELL and rendered as a column of green lines, with nothing
// saying which value belonged to which column.

const adfField=blocks=>({fieldId:'description',fieldName:'Description',kind:'adf',
 retained:true,semanticChange:true,materiality:'MAJOR',blocks,attribution:[]});
const cells=(...texts)=>texts.map(text=>({text,header:false}));
const headerCells=(...texts)=>texts.map(text=>({text,header:true}));

async function renderDiff(field){
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 await act(()=>{root.render(React.createElement(DiffView,{fields:[field]}));});
 return container;
}

test('a table added after approval renders as a table, one row per row',async()=>{
 const rows=[
  {op:'insert',after:{type:'tableRow',tableId:'content.1',cells:headerCells('Planet','Diameter (km)','Type')}},
  {op:'insert',after:{type:'tableRow',tableId:'content.1',cells:cells('Jupiter','139,820','Gas Giant')}},
  {op:'insert',after:{type:'tableRow',tableId:'content.1',cells:cells('Earth','12,742','Terrestrial')}}
 ];
 const html=(await renderDiff(adfField([{op:'equal',before:{type:'paragraph',text:'Intro.'},after:{type:'paragraph',text:'Intro.'}},...rows]))).innerHTML;

 const table=container.querySelector('table.va-diff-table');
 assert.ok(table,'the rows must be drawn as one HTML table');
 assert.equal(table.querySelectorAll('tr').length,3);
 assert.equal(table.querySelectorAll('th').length,3,'header cells render as headers');
 const body=[...table.querySelectorAll('tr')][1];
 assert.deepEqual([...body.querySelectorAll('td')].map(c=>c.textContent),['Jupiter','139,820','Gas Giant']);
 assert.match(body.getAttribute('class')??'',/insert/);
 assert.match(html,/Table added/);
});

test('a removed table still shows the approved rows, marked as removed',async()=>{
 await renderDiff(adfField([
  {op:'delete',before:{type:'tableRow',tableId:'content.0',cells:headerCells('Planet','Type')}},
  {op:'delete',before:{type:'tableRow',tableId:'content.0',cells:cells('Jupiter','Gas Giant')}}
 ]));
 const rows=[...container.querySelectorAll('table.va-diff-table tr')];
 assert.equal(rows.length,2);
 assert.deepEqual([...rows[1].querySelectorAll('td')].map(c=>c.textContent),['Jupiter','Gas Giant']);
 assert.match(rows[1].getAttribute('class')??'',/delete/);
});

test('an edited cell shows before and after inside that cell only',async()=>{
 await renderDiff(adfField([
  {op:'equal',before:{type:'tableRow',tableId:'content.0',cells:headerCells('Planet','Diameter')},
   after:{type:'tableRow',tableId:'content.0',cells:headerCells('Planet','Diameter')}},
  {op:'modified',
   before:{type:'tableRow',tableId:'content.0',cells:cells('Jupiter','139,820')},
   after:{type:'tableRow',tableId:'content.0',cells:cells('Jupiter','142,984')},
   cells:[
    {op:'equal',before:'Jupiter',after:'Jupiter',header:false,ops:[]},
    {op:'modified',before:'139,820',after:'142,984',header:false,
     ops:[{op:'delete',text:'139,820'},{op:'insert',text:'142,984'}]}
   ]}
 ]));
 // Each side draws its own table: the signed words on the left, the current ones on the right.
 const side=which=>[...container.querySelectorAll(`.va-pair__side--${which} table.va-diff-table tr`)];
 assert.equal(side('new').length,2,'the unchanged header row is kept so the table still reads as a table');
 assert.equal(side('old').length,2);
 assert.equal(side('new')[1].querySelectorAll('td')[0].textContent,'Jupiter');
 assert.equal(side('old')[1].querySelectorAll('td')[1].querySelector('del')?.textContent,'139,820');
 assert.equal(side('new')[1].querySelectorAll('td')[1].querySelector('ins')?.textContent,'142,984');
});

test('two adjacent tables are never merged into one',async()=>{
 await renderDiff(adfField([
  {op:'insert',after:{type:'tableRow',tableId:'content.0',cells:cells('a')}},
  {op:'insert',after:{type:'tableRow',tableId:'content.1',cells:cells('b')}}
 ]));
 assert.equal(container.querySelectorAll('table.va-diff-table').length,2);
});

// ── The drift header counts one thing, not two ───────────────────────────────
//
// VJIRA-16 read "3 changes since approval · 1 changed fields": three fields
// edited on one work item. `drift.count` is field-level (treeCollect sums
// Math.max(1, fields.length) per change) while `changedFields` is node-level
// (one FIELD_CHANGED entry per node, carrying its own field list). Both numbers
// were true and they were counting different units.

test('the card counts changes in one unit, and does not pluralise one',async()=>{
 for(const [count,expected] of [[3,/3 changes since/],[1,/1 change since/]]){
  setup(async key=>{
   if(key==='panel:getSummary')return actor([],{baseline:baseline(),drift:driftOn({count,materialCount:count})});
   if(key==='panel:getEvidence')return evidence({drift:{fields:[],changedFields:[{logicalNodeId:'n1',fields:['assignee','labels','customfield_10015'].slice(0,count)}]}});
   return {restores:[]};
  });
  await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));
  await flush();await flush();
  assert.match(text(),expected);
  assert.doesNotMatch(text(),/1 changes/);
  await act(()=>root.unmount());root=null;
 }
});

// ── Permission travels with the count it belongs to ──────────────────────────
//
// VJIRA-17: the panel replaced summary.drift.count with the live re-diff's
// number for display, but left canApprove/canReject as the server computed them
// from the stored counter. With the counter at 0 and the diff at 1, the panel
// switched into drift-review mode on one number and refused on the other,
// telling a Reviewer that only Reviewer could decide.

const driftOff=(over={})=>({count:0,materialCount:0,decidesDrift:false,policyIncomplete:false,
 canApprove:false,canReject:false,eligible:false,...over});

test('an eligible reviewer can decide drift the live diff sees but the stored counter missed',async()=>{
 setup(async key=>{
  // The counter a completed restore zeroed; the viewer holds the baseline role.
  if(key==='panel:getSummary')return actor([],{baseline:baseline(),drift:driftOff({eligible:true})});
  if(key==='panel:getEvidence')return evidence({drift:{count:1,materialCount:1,
   fields:[{fieldId:'issuelinks',fieldName:'Linked work items',kind:'links',semanticChange:true,materiality:'MAJOR'}]}});
  return {restores:[]};
 });
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));
 await flush();await flush();
 const shown=text();
 assert.match(shown,/1 change since/);
 assert.doesNotMatch(shown,/only .* can decide them/,'the role was never the reason');
 assert.ok(clickButton('Approve changes'),'an eligible viewer gets the decision controls');
});

test('an ineligible viewer is still told the role, and still cannot decide',async()=>{
 setup(async key=>{
  if(key==='panel:getSummary')return actor([],{baseline:baseline(),
   drift:driftOff({eligible:false}),approval:{requiredRole:'Reviewer',requiredAssurance:'ESIGNATURE',meaning:null,pending:null}});
  if(key==='panel:getEvidence')return evidence({drift:{count:1,materialCount:1,
   fields:[{fieldId:'summary',fieldName:'Summary',kind:'scalar',semanticChange:true,materiality:'MAJOR'}]}});
  return {restores:[]};
 });
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));
 await flush();await flush();
 assert.match(text(),/only Reviewer can decide them/);
});

test('no changes at all means no drift decision offered, whatever the viewer holds',async()=>{
 setup(async key=>{
  if(key==='panel:getSummary')return actor([],{baseline:baseline(),drift:driftOff({eligible:true})});
  if(key==='panel:getEvidence')return evidence({drift:{count:0,materialCount:0,fields:[]}});
  return {restores:[]};
 });
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));
 await flush();await flush();
 assert.doesNotMatch(text(),/Approve changes/);
});

// ── Live surfaces ────────────────────────────────────────────────────────────
//
// A decision taken anywhere emits VA_ISSUE_CHANGED (lib/bridge.ts) and Jira
// emits JIRA_ISSUE_CHANGED on its own edits. The panel and the context lozenge
// have always listened; My approvals never did, so it showed work that was
// already done until somebody pressed Refresh.

test('My approvals reloads when an issue changes, without anyone pressing Refresh',async()=>{
 let loads=0;
 const listeners=setup(async key=>{
  if(key==='queue:list'){loads++;return {items:[],nextPageToken:null};}
  return {restores:[]};
 });
 const {default:QueueListLive}=await import('../src/queue/QueueList.tsx');
 await act(()=>root.render(React.createElement(QueueListLive,{})));
 await flush();
 assert.equal(loads,1,'loads once on mount');

 await act(()=>listeners.get('VA_ISSUE_CHANGED')({issueKey:'T-1'}));
 await flush();
 assert.equal(loads,2,'a decision taken elsewhere refreshes the queue');

 await act(()=>listeners.get('JIRA_ISSUE_CHANGED')());
 await flush();
 assert.equal(loads,3,'and so does an edit made in Jira itself');
});

// The evidence read used to be keyed on the review row's version, which only
// moves when the collector writes a row. An edit the collector has not recorded
// yet left the diff showing the previous content beside a summary that had
// already moved on. It is keyed on the content's own hash now.
test('the diff reloads when the content changes, not only when a row is written',async()=>{
 let summaryReads=0;const evidenceReads=[];
 setup(async(key,payload)=>{
  if(key==='panel:getSummary'){
   summaryReads++;
   // Same baseline, same review row version — only the content moved.
   return actor([],{baseline:baseline(),drift:driftOn({count:1,eligible:true}),
    evidenceVersion:7,contentHash:summaryReads===1?'hash-before':'hash-after'});
  }
  if(key==='panel:getEvidence'){evidenceReads.push(payload);return evidence({drift:{count:1,materialCount:1,fields:[]}});}
  return {restores:[]};
 });
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));
 await flush();await flush();
 assert.equal(evidenceReads.length,1);

 await act(()=>listeners0().get('JIRA_ISSUE_CHANGED')());
 await flush();await flush();
 assert.ok(evidenceReads.length>1,'new content must produce a fresh evidence read');
});

// ── A parent's review, grouped by issue (child baselines, 2026-09-24) ─────────

const scalarField=(fieldId,label,issueKey)=>({fieldId,fieldName:`${issueKey} · ${label}`,label,issueKey,kind:'scalar',
 retained:true,semanticChange:true,materiality:'MAJOR',before:'was',after:'now',attribution:[]});

async function renderInto(element){
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 await act(()=>{root.render(element);});
 return container;
}

// The merge view: work items on the left, one shown at a time on the right.
const railItems=()=>[...container.querySelectorAll('.va-merge__item')];
const railNamed=title=>railItems().find(r=>r.querySelector('.va-merge__item-title').textContent===title);
const mainTitle=()=>container.querySelector('.va-merge__title').textContent;
const fieldNames=()=>[...container.querySelectorAll('.va-mfield__name')].map(n=>n.textContent);
const sideText=(name,which)=>[...container.querySelectorAll('.va-mfield')].find(f=>f.querySelector('.va-mfield__name').textContent===name)
 .querySelector(`.va-pair__side--${which}`).textContent;

test('a parent review lists each work item on the left and shows one at a time, its fields named plainly',async()=>{
 const parentField=scalarField('root:summary','Summary','P-1');
 const childField={...scalarField('child:summary','Summary','P-2'),before:'child was',after:'child now'};
 const moved={...scalarField('tree:NODE_ADDED:x','Added node · P-4','P-4')};
 const groups=[
  {kind:'ISSUE',issueKey:'P-1',summary:'The parent',isRoot:true,baselineVersion:3,fields:[parentField]},
  {kind:'STRUCTURE',fields:[moved]},
  {kind:'ISSUE',issueKey:'P-2',summary:'A subtask',isRoot:false,baselineVersion:6,fields:[childField]}
 ];
 await renderInto(React.createElement(DiffView,{fields:[parentField,moved,childField],groups}));
 assert.deepEqual(railItems().map(r=>r.querySelector('.va-merge__item-title').textContent),['The parent','Work items added, removed or moved','A subtask']);
 assert.equal(mainTitle(),'P-1 · The parent','the first work item is open');
 assert.deepEqual(fieldNames(),['Summary'],'inside its work item a field is named plainly');
 assert.equal(sideText('Summary','old'),'was');assert.equal(sideText('Summary','new'),'now');
 assert.match(container.querySelector('.va-merge__cols').textContent,/Signed · version 3/);
 await act(()=>railNamed('A subtask').click());
 assert.equal(mainTitle(),'P-2 · A subtask');
 assert.match(container.querySelector('.va-merge__cols').textContent,/Signed · version 6/,'each child says which of its own baselines it is compared with');
 assert.equal(sideText('Summary','new'),'child now');
 assert.equal(railNamed('A subtask').getAttribute('aria-current'),'true');
 await act(()=>railNamed('Work items added, removed or moved').click());
 assert.deepEqual(fieldNames(),['Added node · P-4'],'a structural change is a change like any other');
});

test('inside a work item the most severe change comes first',async()=>{
 const minor={...scalarField('root:summary','Summary','P-1'),materiality:'MINOR'};
 const critical={...scalarField('root:duedate','Due date','P-1'),materiality:'CRITICAL',before:null,after:'2026-10-28'};
 const groups=[{kind:'ISSUE',issueKey:'P-1',summary:'The parent',isRoot:true,fields:[minor,critical]}];
 await renderInto(React.createElement(DiffView,{fields:[minor,critical],groups}));
 assert.deepEqual(fieldNames(),['Due date','Summary']);
 assert.equal(sideText('Due date','old'),'Empty','a missing value says so');
 assert.equal(railItems().length,0,'one work item needs no list beside it');
});

test('a citation opens the work item holding the change and highlights it, even the second time',async()=>{
 const a={...scalarField('a','A','T-1'),materiality:'CRITICAL'},b={...scalarField('b','B','T-2'),driftIds:['d-2']};
 const groups=[{kind:'ISSUE',issueKey:'T-1',summary:'One',isRoot:true,fields:[a]},{kind:'ISSUE',issueKey:'T-2',summary:'Two',isRoot:false,fields:[b]}];
 const render=(focusKey)=>act(()=>root.render(React.createElement(DiffView,{fields:[a,b],groups,focusDriftId:'d-2',focusKey})));
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 await render(1);
 assert.equal(mainTitle(),'T-2 · Two');
 assert.ok(container.querySelector('[data-field-id="b"]').classList.contains('va-highlight'));
 await act(()=>railNamed('One').click());
 assert.equal(mainTitle(),'T-1 · One');
 await render(2);
 assert.equal(mainTitle(),'T-2 · Two');
});

test('without groups the fields are named in full, with no list of work items',async()=>{
 const field=scalarField('summary','Summary','T-1');
 await renderInto(React.createElement(DiffView,{fields:[field]}));
 assert.equal(container.querySelector('.va-merge__rail'),null);
 assert.deepEqual(fieldNames(),['T-1 · Summary']);
});

test('a parent whose children changed says so in its one sentence',async()=>{
 const drift={count:2,materialCount:2,decidesDrift:true,policyIncomplete:false,canApprove:true,canReject:true,childrenAwaiting:2};
 const evidence={baselineId:'b',baselineVersion:3,record:null,rejection:{deleteIssueKeys:[],recreateCount:0},restoreHistory:[],
  drift:{count:2,materialCount:2,fields:[],groups:[
   {kind:'ISSUE',issueKey:'P-2',isRoot:false,fields:[]},{kind:'ISSUE',issueKey:'P-3',isRoot:false,fields:[]}]}};
 const text=(await renderInto(React.createElement(BaselineSection,{summary:summary({baseline:baseline({version:3})}),drift,evidence,evidenceReady:true,onOpenReview:()=>{}}))).textContent;
 assert.match(text,/2 changes since .*including 2 child work items/);
});

test('a child baselined by its parent names the parent capture it came with',async()=>{
 const baseline={baselineId:'c',version:6,approvedName:'Signer',nodeCount:1,edgeCount:0,totalFieldCount:2,treeHash:null,
  capturedBy:{issueKey:'P-1',version:3}};
 const text=(await renderInto(React.createElement(BaselineRecord,{baseline,latestApproval:null,record:null,
  evidenceLoading:false,evidenceError:null,onOpen:()=>{},onRetryEvidence:()=>{}}))).textContent;
 assert.match(text,/Baselined with P-1 version 3\./);
});

// ── The redesigned panel: two sections, drift flagged on the baseline ────────

const drifted=(over={})=>({fieldId:'customfield_10016',fieldName:'Story points',kind:'scalar',retained:true,semanticChange:true,materiality:'MAJOR',
 before:'5',after:'13',driftIds:['d-1'],occurrences:1,lastChangedAt:Date.now()-2*86_400_000,lastChangedBy:'Sam Ortiz',
 attribution:[{at:Date.now()-2*86_400_000,authorName:'Sam Ortiz',source:'USER',fromString:'5',toString:'13'}],...over});

test('drift is flagged on the baseline card, one row per change, with the decision on the card and the held move named',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([transition()],{baseline:baseline({version:3}),drift:driftOn({count:1})})
  :key==='panel:getEvidence'?evidence({baselineVersion:3,drift:{count:1,materialCount:1,fields:[drifted()]}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 const card=container.querySelector('.va-base--drifted');
 assert.ok(card,'the baseline card itself carries the drift');
 assert.match(card.textContent,/Baseline version 3/);
 assert.match(card.textContent,/1 change since/);
 assert.match(card.textContent,/Changed/);
 const row=card.querySelector('.va-change-row');
 assert.match(row.textContent,/Story points/);assert.match(row.textContent,/5 → 13/);assert.match(row.textContent,/Sam Ortiz · 2 days ago/);
 for(const label of ['Review changes','Reject and restore','Approve changes'])assert.ok(card.contains(clickButton(label)),`${label} sits on the baseline card`);
 assert.match(text(),/Moving to Done is held until these changes are decided/);
 assert.equal(clickButton('Approve to Done'),undefined,'a held transition is a fact, not a button');
 assert.equal(container.querySelector('details, .va-collapse'),null,'nothing in the panel expands');
 assert.doesNotMatch(text(),/Approvals|Steady|AI summary/,'no second section, no badges, no AI button');
});

test('a change only below this work item asks it for a decision but never says it is held',async()=>{
 setup(async key=>key==='panel:getSummary'?actor([transition()],{baseline:baseline({version:3}),drift:driftOn({count:0,childrenAwaiting:1})})
  :key==='panel:getEvidence'?evidence({baselineVersion:3,drift:{count:1,materialCount:1,fields:[drifted()]}}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 assert.ok(clickButton('Approve changes'),'the decision covering the change below is offered here');
 assert.doesNotMatch(text(),/is held until/);
 assert.match(text(),/Only the changes below this work item are waiting; it is not held itself/);
});

test('Review changes opens the review window on Changes, and closing it re-reads the panel',async()=>{
 let summaryReads=0;
 setup(async key=>{if(key==='panel:getSummary'){summaryReads++;return actor([],{baseline:baseline(),drift:driftOn()});}
  return key==='panel:getEvidence'?evidence({drift:{count:1,materialCount:1,fields:[drifted()]}}):{restores:[]};});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 await act(()=>clickButton('Review changes').click());
 const modals=globalThis.panelTransport.modals;
 assert.deepEqual(modals[0].context,{view:'review',issueKey:'T-1',tab:'changes'});
 assert.equal(modals[0].size,'max');
 const before=summaryReads;
 await act(async()=>{modals[0].onClose({decided:true});});await flush();
 assert.ok(summaryReads>before,'closing the window re-reads the panel');
});

test('History on a clean baseline opens the review window on its history',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({baseline:baseline()}):key==='panel:getEvidence'?evidence():{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 await act(()=>clickButton('History').click());
 assert.deepEqual(globalThis.panelTransport.modals[0].context,{view:'review',issueKey:'T-1',tab:'record'});
});

test('a clean baseline is one line: its version, that it matches, and who signed it',async()=>{
 setup(async key=>key==='panel:getSummary'?summary({baseline:baseline({version:2,transitionAt:Date.now()-8*86_400_000})})
  :key==='panel:getEvidence'?evidenceWithField('Priority',{baselineVersion:2}):{restores:[]});
 await act(()=>root.render(h(IssuePanel,{issueKey:'T-1'})));await flush();await flush();
 const card=container.querySelector('.va-base--clean');
 assert.ok(card);
 assert.match(card.textContent,/Baseline version 2/);
 assert.match(card.textContent,/Matches/);
 assert.match(card.textContent,/Signed by Priya/);
 assert.equal(card.querySelector('svg.va-seal'),null,'no seal graphic');
 assert.doesNotMatch(card.textContent,/Steady|Tracks/,'no rewards, no field inventory');
});

test('the reason is given while signing, and travels with the signature',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signature:challenge')return challengeOk({meaning:'I approve these changes'});
  if(key==='signature:submit')return {success:true,approvalId:'a1',transitioned:false};
  return {};});
 const data=actor([],{actorName:'Priya Raman',baseline:baseline(),approval:{requiredRole:'QA Lead',requiredAssurance:'ESIGNATURE',meaning:'x',pending:null},drift:driftOn()});
 await act(()=>root.render(h(ApprovalControls,{summary:data,evidence:evidence({drift:{fields:[drifted()]}}),onDone:async()=>{}})));await settle();
 assert.equal(container.querySelector('textarea'),null,'no note box on the browsing screen');
 await act(()=>clickButton('Approve changes').click());await settle();
 const sheet=container.querySelector('.va-sign');
 assert.match(sheet.textContent,/Sign approval/);
 assert.match(sheet.textContent,/I approve these changes/,'the meaning comes first');
 assert.match(sheet.textContent,/Priya Raman/);assert.match(sheet.textContent,/QA Lead/);
 assert.equal(sheet.querySelector('input[type="checkbox"]'),null,'signing with the meaning on screen is the affirmation');
 assert.doesNotMatch(sheet.textContent,/evidence|Electronic signature|Re-planned/,'hash, method chip and canned reasons go');
 await act(()=>typeInto(container.querySelector('textarea'),'Re-planned with the team.'));
 await signWithCode();await settle();
 const submit=calls.find(([k])=>k==='signature:submit');
 assert.equal(submit[1].note,'Re-planned with the team.');
 assert.equal(submit[1].confirmed,true);
});

test('a signer who made some of the edits is told so before signing',async()=>{
 setup(async key=>key==='signature:challenge'?challengeOk():{});
 const data=actor([],{actorName:'Sam Ortiz',baseline:baseline(),drift:driftOn()});
 await act(()=>root.render(h(ApprovalControls,{summary:data,evidence:evidence({drift:{fields:[drifted()]}}),onDone:async()=>{}})));await settle();
 await act(()=>clickButton('Approve changes').click());await settle();
 assert.match(text(),/Some of these changes are yours/);
});

// ── The diff answers what, who, when ─────────────────────────────────────────

test('a field names the last editor, how long ago, and how many edits it took, with every edit in its history',async()=>{
 const now=Date.UTC(2026,8,26,12);
 const field=drifted({materiality:'COSMETIC',semanticChange:false,occurrences:2,lastChangedAt:now-2*86_400_000,
  attribution:[{at:now-5*86_400_000,authorName:'Automation for Jira',source:'AUTOMATION',fromString:'30 Sep',toString:'7 Oct'},
   {at:now-2*86_400_000,authorName:'Sam Ortiz',source:'USER',fromString:'7 Oct',toString:'14 Oct'}]});
 await renderInto(React.createElement(DiffView,{fields:[field],now,baselineAt:now-8*86_400_000}));
 assert.equal(sideText('Story points','old'),'5');assert.equal(sideText('Story points','new'),'13');
 assert.match(container.querySelector('.va-mfield__who').textContent,/Sam Ortiz · 2 days ago · 2 edits/);
 assert.match(container.querySelector('.va-mfield__history summary').textContent,/Edit history · 2/);
 const steps=[...container.querySelectorAll('.va-step')];
 assert.equal(steps.length,2,'every edit is its own step');
 assert.match(steps[0].textContent,/\+3 days/);assert.match(steps[0].textContent,/automation/);assert.match(steps[0].textContent,/30 Sep→7 Oct/);
 assert.match(steps[1].textContent,/\+6 days/);assert.match(steps[1].textContent,/7 Oct→14 Oct/);
});

test('rich-text steps say edited, and a change seen without Jira history says so',async()=>{
 const field={...adfField([{op:'modified',ops:[{op:'equal',text:'Limit '},{op:'delete',text:'5'},{op:'insert',text:'3'}]},{op:'insert',after:{type:'paragraph',text:'New rule.'}}]),
  attribution:[{at:2000,authorName:'Jordan Lee',fromString:'a flattened copy of the whole document',toString:'another flattened copy'},
   {at:3000,authorName:null,detected:true}]};
 await renderInto(React.createElement(DiffView,{fields:[field],baselineAt:1000}));
 assert.equal(sideText('Description','old'),'Limit 5');
 assert.equal(sideText('Description','new'),'Limit 3New rule.');
 const steps=[...container.querySelectorAll('.va-step')];
 assert.match(steps[0].textContent,/Edited/);
 assert.doesNotMatch(steps[0].textContent,/flattened copy/,'Jira\'s flattened document is noise, not a diff');
 assert.match(steps[1].textContent,/Seen changed by VAtlassian/);
});

test('attachment drift names the file and its audit details, including same-name replacement',async()=>{
 const field={fieldId:'attachment',fieldName:'Attachments',kind:'attachments',retained:true,materiality:'MAJOR',
  added:[{id:'501',filename:'proof.pdf',size:8192,mimeType:'application/pdf',authorName:'Sam',created:'2026-09-21T11:00:00.000Z'}],
  removed:[{id:'500',filename:'proof.pdf',size:4096,mimeType:'application/pdf',authorName:'Priya',created:'2026-09-20T10:00:00.000Z'}],
  attribution:[]};
 await renderInto(React.createElement(DiffView,{fields:[field]}));
 assert.match(sideText('Attachments','old'),/proof\.pdf.*4 KB.*Priya.*Audit ID 500/);
 assert.match(sideText('Attachments','new'),/proof\.pdf.*8 KB.*Sam.*Audit ID 501/);
 assert.match(text(),/application\/pdf/);
});

test('a sweep detection is labelled as detection, not an attributed edit',async()=>{
 const field={...drifted(),lastChangedAt:null,lastChangedBy:null,attribution:[{at:2000,detected:true,authorName:null,source:'UNKNOWN'}]};
 await renderInto(React.createElement(DiffView,{fields:[field],baselineAt:1000}));
 assert.equal(container.querySelector('.va-mfield__who'),null,'no editor is invented');
 assert.match(container.querySelector('.va-step').textContent,/Detected/);
});

// ── The review window ────────────────────────────────────────────────────────

function windowSetup(over={},handler){
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  const custom=handler?.(key,payload);if(custom!==undefined)return custom;
  if(key==='panel:getSummary')return actor([],{actorName:'Priya Raman',baseline:baseline({version:3,approvedName:'Priya Raman'}),
   approval:{requiredRole:'QA Lead',requiredAssurance:'ESIGNATURE',meaning:'x',pending:null},drift:driftOn(),...over});
  if(key==='panel:getEvidence')return evidence({baselineVersion:3,drift:{count:1,materialCount:1,fields:[drifted()]}});
  if(key==='report:get')return {success:true,report:{model:'m',body:{verdictHint:'scope_change',headline:'The scope you signed has grown.',narrative:'Story points more than doubled.',
   changeGroups:[{title:'The estimate went from 5 to 13',risk:'high',whoAndWhen:'Sam Ortiz',whatChanged:'One edit.',whyItMatters:'You approved 5.',driftIds:['d-1']}],questionsForReviewer:['Was 13 agreed?'],groundingIssues:0}}};
  return {restores:[]};});
 return calls;
}

test('the review window says what it compares against, with two tabs, a written summary on top and the decision in its footer',async()=>{
 windowSetup();
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 assert.match(text(),/Review changes to baseline version 3/);
 assert.match(container.querySelector('.va-window__meta').textContent,/Signed by Priya Raman on .* · 1 change/);
 assert.deepEqual([...container.querySelectorAll('[role="tab"]')].map(t=>t.textContent.replace(/\d+$/,'')),['Changes','History']);
 assert.match(container.querySelector('.va-brief').textContent,/The scope you signed has grown\./);
 assert.match(container.querySelector('.va-brief').textContent,/Written from the changes below/);
 assert.equal(container.querySelector('.va-timeline, .va-window__compare, svg.va-seal'),null,'no timeline, no seal strip');
 assert.ok(container.querySelector('.va-mfield'),'the changes follow the summary');
 const foot=container.querySelector('.va-window__foot');
 assert.ok(foot.contains(clickButton('Approve changes')));assert.ok(foot.contains(clickButton('Reject and restore')));
});

test('an older request for the summary tab opens Changes, with the summary on top',async()=>{
 windowSetup();
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'summary'})));await flush();await flush();
 assert.equal(container.querySelector('[role="tab"][aria-selected="true"]').textContent.replace(/\d+$/,''),'Changes');
 assert.match(text(),/The scope you signed has grown\./);
});

test('with no summary yet the reviewer can ask for one, and nothing is generated unasked',async()=>{
 const calls=windowSetup({},key=>key==='report:get'?{success:true,report:null}:key==='report:generate'?{success:true,report:{body:{headline:'Story points went from 5 to 13.'}}}:undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1'})));await flush();await flush();
 assert.ok(!calls.some(([key])=>key==='report:generate'),'generating costs the customer, so it waits to be asked');
 await act(()=>clickButton('Summarise these changes').click());await flush();
 assert.match(container.querySelector('.va-brief').textContent,/Story points went from 5 to 13\./);
});

test('the Baseline record lists every restore, newest first, with no retry of its own',async()=>{
 windowSetup({restore:{restoreId:'r2',state:'COMPLETE',attempted:1,succeeded:1,failed:0,skipped:0}},key=>key==='restore:getState'?{restores:[
  {restore_id:'r2',state:'COMPLETE',actorName:'Priya Raman',baselineVersion:3,finishedAt:Date.UTC(2026,8,26,16,29)},
  {restore_id:'r1',state:'FAILED',actorName:'Sam Ortiz',baselineVersion:3,finishedAt:Date.UTC(2026,8,26,16,11),error:'Jira refused the due date'}]}:undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'record'})));await flush();await flush();
 const lines=[...container.querySelectorAll('[aria-label="Restores"] .va-restore-line')];
 assert.equal(lines.length,2);
 assert.match(lines[0].textContent,/Restored and verified.*Back to version 3 · by Priya Raman/);
 assert.match(lines[1].textContent,/Restore failed.*Restoring version 3 · by Sam Ortiz/);
 assert.match(lines[1].querySelector('details').textContent,/Jira refused the due date/);
 assert.equal(clickButton('Retry restore'),undefined,'the log is a record; retrying happens on the panel');
});

test('History lists the signed versions, and compares one with the one before it, or any two ticked',async()=>{
 const calls=windowSetup({},(key,payload)=>key==='panel:compareVersions'?{
  fromVersion:payload.fromVersion,toVersion:payload.toVersion,
  from:{approvedName:'Priya',approvedAt:1000},to:{approvedName:'Sam',approvedAt:2000},
  changedFieldCount:1,fields:[{fieldId:'root:summary',fieldName:'T-1 · Summary',label:'Summary',issueKey:'T-1',
   kind:'text',retained:true,materiality:'MAJOR',before:'old',after:'new',ops:[{op:'delete',text:'old'},{op:'insert',text:'new'}],
   attribution:[],attributionStatus:'NOT_COLLECTED'}]}
  :key==='panel:getEvidence'?evidence({baselineVersion:3,record:{...evidence().record,version:3,
   history:[{version:2,approvedName:'Priya',approvedAt:1000,assuranceLevel:'ESIGNATURE'},{version:1,approvedName:'Arjun',approvedAt:500,assuranceLevel:'BIOMETRIC'}]},
   drift:{count:1,materialCount:1,fields:[drifted()]}}):undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'record'})));await flush();await flush();
 const rows=[...container.querySelectorAll('.va-history__table tbody tr')];
 assert.deepEqual(rows.map(r=>r.querySelector('td:nth-child(2) strong').textContent),['3','2','1'],'newest first');
 assert.match(rows[0].textContent,/Current/);
 assert.match(rows[2].textContent,/Arjun.*Biometric/);
 assert.ok(!calls.some(([key])=>key==='panel:compareVersions'),'nothing is compared until asked');
 await act(()=>clickButton('Compare with 2').click());await flush();
 assert.ok(calls.some(([key,payload])=>key==='panel:compareVersions'&&payload.fromVersion===2&&payload.toVersion===3));
 const compare=container.querySelector('.va-version-compare');
 assert.match(compare.textContent,/Version 2 → 3/);
 assert.match(compare.textContent,/Priya.*Sam/);
 assert.match(compare.textContent,/old/);assert.match(compare.textContent,/new/);
 assert.doesNotMatch(compare.textContent,/Jira did not record who made this change/);
 assert.equal(container.querySelector('.va-history input[type="number"]'),null,'no version numbers to type');
 await act(()=>rows[0].querySelector('input[type="checkbox"]').click());
 await act(()=>[...container.querySelectorAll('.va-history__table tbody tr')][2].querySelector('input[type="checkbox"]').click());
 await act(()=>clickButton('Compare 1 → 3').click());await flush();
 assert.ok(calls.some(([key,payload])=>key==='panel:compareVersions'&&payload.fromVersion===1&&payload.toVersion===3),
  'the ticked pair must reach the saved-version endpoint');
});

test('historical comparison explains incomplete access and does not offer link rejection',async()=>{
 const links={fieldId:'root:issuelinks',fieldName:'T-1 · Links',kind:'links',retained:true,
  materiality:'MAJOR',added:[{id:'link-1',type:'blocks',outward:'T-2'}],removed:[],
  attribution:[],attributionStatus:'NOT_COLLECTED'};
 await renderInto(h(DiffView,{fields:[],mode:'versions',fromVersion:1,toVersion:3,incomplete:true}));
 assert.match(text(),/No visible differences.*incomplete/);
 await act(()=>root.render(h(DiffView,{fields:[links],mode:'versions',fromVersion:1,toVersion:3})));await flush();
 assert.doesNotMatch(text(),/Rejecting these changes restores/);
});

test('signing in the window ends on a receipt, and Done closes the window as decided',async()=>{
 windowSetup({},key=>key==='signature:challenge'?challengeOk({meaning:'I approve these changes'}):key==='signature:submit'?{success:true,approvalId:'ap-9',transitioned:false}:undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1'})));await flush();await flush();
 await act(()=>clickButton('Approve changes').click());await settle();
 assert.ok(container.querySelector('.va-sheet .va-sign'),'signing happens in a sheet over the window');
 await signWithCode();await settle();
 const receipt=container.querySelector('.va-receipt');
 assert.ok(receipt,'the window ends on the signed record');
 assert.match(receipt.textContent,/Signed by\s*Priya Raman · QA Lead/);
 assert.match(receipt.textContent,/UTC/);
 assert.match(receipt.textContent,/I approve these changes/);
 assert.match(receipt.textContent,/ap-9/);
 await act(()=>clickButton('Done').click());
 assert.deepEqual(globalThis.panelTransport.closed,[{decided:true}]);
});

test('frontend harness supports rich categories, active trace propagation, filtering, and stats', async () => {
 const {
  recordHarnessEvent,
  getHarnessEvents,
  getHarnessStats,
  createTraceId,
  withTrace
 } = await import('../src/lib/harness.ts');

 const traceId = createTraceId();
 assert.match(traceId, /^tr-/);

 withTrace(traceId, () => {
  recordHarnessEvent('GATE', 'gate:deny', { issueKey: 'ENG-5', reason: 'UNDECIDED_DRIFT' }, new Error('Transition blocked'));
  recordHarnessEvent('VAULT', 'vault:copied', { issueKey: 'ENG-5', filename: 'arch.pdf', durationMs: 15 });
  recordHarnessEvent('RESTORE', 'restore:step', { issueKey: 'ENG-5', durationMs: 25 });
 });

 const filteredByCat = getHarnessEvents({ category: 'VAULT' });
 assert.ok(filteredByCat.length >= 1);
 assert.equal(filteredByCat[0].category, 'VAULT');
 assert.equal(filteredByCat[0].traceId, traceId);
 assert.equal(filteredByCat[0].durationMs, 15);

 const filteredByError = getHarnessEvents({ errorOnly: true });
 assert.ok(filteredByError.some(e => e.action === 'gate:deny'));

 const filteredBySearch = getHarnessEvents({ search: 'arch.pdf' });
 assert.equal(filteredBySearch.length, 1);
 assert.equal(filteredBySearch[0].action, 'vault:copied');

 const stats = getHarnessStats();
 assert.ok(stats.total >= 3);
 assert.ok(stats.byCategory.GATE >= 1);
 assert.ok(stats.byCategory.VAULT >= 1);
 assert.ok(stats.errorCount >= 1);

 assert.ok(typeof window.__VA_HARNESS__.getStats === 'function');
 assert.ok(typeof window.__VA_HARNESS__.createTrace === 'function');
 assert.ok(typeof window.__VA_HARNESS__.export === 'function');
});

// ── Deciding each change on its own (docs/specs/2026-10-07-drift-field-decision-design.md) ──

const decidable=(rawFieldId,extra={})=>({...scalarField(`n1:${rawFieldId}`,rawFieldId,'T-1'),rawFieldId,restorable:'YES',...extra});
// Holds the choices the way the review window does, so a click's effect is visible in the next render.
function DecideHarness({fields,mixed={eligible:true,reason:null},gate={},onSave=()=>{},probe}){
 const [state,setState]=React.useState({});
 probe.state=state;
 return React.createElement(DiffView,{fields,decisions:{state,onChange:setState,mixed,loading:false,error:'',held:false,eligible:true,onSave,...gate}});
}
const byText=(selector,text)=>[...container.querySelectorAll(selector)].find(n=>n.textContent.trim()===text);
const fieldCard=name=>[...container.querySelectorAll('.va-mfield')].find(f=>f.querySelector('.va-mfield__name').textContent===name);
const keepButton=name=>fieldCard(name).querySelector('.va-switch__keep');
const takeButton=name=>fieldCard(name).querySelector('.va-switch__take');

test('a change being decided shows the signed value and the value now side by side, the arrows between them, and no whole-set actions inside',async()=>{
 const probe={};
 await renderInto(React.createElement(DecideHarness,{fields:[decidable('summary'),decidable('priority')],probe}));
 assert.match(container.querySelector('.va-merge__cols').textContent,/Signed.*Now/);
 assert.equal(sideText('T-1 · summary','old'),'was');
 assert.equal(sideText('T-1 · summary','new'),'now');
 assert.equal(keepButton('T-1 · summary').getAttribute('aria-label'),'Keep the signed value of T-1 · summary');
 assert.equal(takeButton('T-1 · summary').getAttribute('aria-label'),'Take the new value of T-1 · summary');
 assert.doesNotMatch(container.textContent,/Approve changes|Reject and restore|Save changes/,'the whole-set actions and Sign stay outside the comparison');
});

test('→ keeps the signed value and ← takes the new one; the pair folds into its final value, and Undo brings it back',async()=>{
 const probe={};
 await renderInto(React.createElement(DecideHarness,{fields:[decidable('summary')],probe}));
 await act(()=>keepButton('T-1 · summary').click());
 assert.deepEqual(probe.state,{'n1:summary':'REJECT'});
 const kept=fieldCard('T-1 · summary').querySelector('.va-final--kept');
 assert.ok(kept,'one box now holds the final value');
 assert.match(kept.textContent,/was.*Kept signed/);
 assert.equal(fieldCard('T-1 · summary').querySelector('.va-pair'),null,'the two sides are gone');
 await act(()=>byText('.va-final button','Undo').click());
 assert.deepEqual(probe.state,{});
 assert.ok(fieldCard('T-1 · summary').querySelector('.va-pair'),'Undo brings the pair back');
 await act(()=>takeButton('T-1 · summary').click());
 assert.deepEqual(probe.state,{'n1:summary':'APPROVE'});
 assert.match(fieldCard('T-1 · summary').querySelector('.va-final--took').textContent,/now.*Took new/);
});

test('pointing at an arrow previews which value would win',async()=>{
 const probe={};
 await renderInto(React.createElement(DecideHarness,{fields:[decidable('summary')],probe}));
 await act(()=>{keepButton('T-1 · summary').dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true}));});
 assert.ok(fieldCard('T-1 · summary').querySelector('.va-pair').classList.contains('is-keep'));
 await act(()=>{keepButton('T-1 · summary').dispatchEvent(new window.MouseEvent('mouseout',{bubbles:true}));});
 await act(()=>{takeButton('T-1 · summary').dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true}));});
 assert.ok(fieldCard('T-1 · summary').querySelector('.va-pair').classList.contains('is-take'));
 assert.deepEqual(probe.state,{},'pointing decides nothing');
});

test('a field that cannot be restored cannot keep its signed value, and says why',async()=>{
 const probe={};
 const kept=decidable('summary',{retained:false,restorable:'NOT_RETAINED'});
 await renderInto(React.createElement(DecideHarness,{fields:[kept],probe}));
 assert.equal(keepButton('T-1 · summary').disabled,true);
 assert.match(fieldCard('T-1 · summary').querySelector('.va-mfield__why').textContent,/not kept/i);
 await act(()=>takeButton('T-1 · summary').click());
 assert.deepEqual(probe.state,{'n1:summary':'APPROVE'},'taking the new value is allowed');
});

test('Keep all signed and Take all new decide every field of the open work item, never rejecting one that cannot be restored',async()=>{
 const probe={};
 const locked=decidable('status',{restorable:'NO'});
 await renderInto(React.createElement(DecideHarness,{fields:[decidable('summary'),locked],probe}));
 await act(()=>clickButton('Keep all signed').click());
 assert.deepEqual(probe.state,{'n1:summary':'REJECT'},'a field that cannot be put back stays undecided');
 await act(()=>clickButton('Take all new').click());
 assert.deepEqual(probe.state,{'n1:summary':'APPROVE','n1:status':'APPROVE'});
});

test('the work item list counts what is decided in each',async()=>{
 const probe={};
 const a=decidable('a'),b=decidable('b'),c={...decidable('c'),issueKey:'T-2',fieldName:'T-2 · c'};
 const groups=[{kind:'ISSUE',issueKey:'T-1',summary:'One',isRoot:true,fields:[a,b]},{kind:'ISSUE',issueKey:'T-2',summary:'Two',isRoot:false,fields:[c]}];
 function Grouped(){const [state,setState]=React.useState({});probe.state=state;
  return React.createElement(DiffView,{fields:[a,b,c],groups,decisions:{state,onChange:setState,mixed:{eligible:true,reason:null},loading:false,error:'',held:false,eligible:true}});}
 await renderInto(React.createElement(Grouped));
 assert.match(railNamed('One').textContent,/0 of 2 decided/);
 await act(()=>takeButton('a').click());
 assert.match(railNamed('One').textContent,/1 of 2 decided/);
 await act(()=>takeButton('b').click());
 assert.match(railNamed('One').textContent,/Decided/);
 assert.ok(railNamed('One').classList.contains('is-done'));
});

test('when a review cannot be decided field by field the reviewer is told why and no arrows appear',async()=>{
 const probe={};
 await renderInto(React.createElement(DecideHarness,{fields:[decidable('summary')],probe,mixed:{eligible:false,reason:'STRUCTURE_CHANGED'}}));
 assert.match(container.querySelector('[role="note"]').textContent,/added, removed or moved.*together/);
 assert.equal(container.querySelector('.va-switch'),null);
 assert.equal(sideText('T-1 · summary','old'),'was','the two values are still shown');
});

test('without decision mode there are no arrows and nothing folds',async()=>{
 await renderInto(React.createElement(DiffView,{fields:[decidable('summary')]}));
 assert.equal(container.querySelector('.va-switch'),null);
 assert.equal(container.querySelector('.va-final'),null);
 assert.equal(sideText('T-1 · summary','new'),'now');
});

// ── Signing a field-by-field decision from the review window ─────────────────

const mixedFields=()=>[decidable('summary',{materiality:'CRITICAL'}),decidable('priority',{materiality:'MAJOR'})];
function mixedEvidence(over={}){
 return evidence({baselineVersion:3,evidenceHash:'hash-9',drift:{count:2,materialCount:2,fields:mixedFields(),
  mixed:{eligible:true,reason:null,fields:mixedFields().map(f=>({fieldId:f.fieldId,restorable:'YES',retained:true}))}},...over});
}
// A review window with two changes, answering the signature calls as the server would.
function mixedWindow(handler){
 return windowSetup({drift:driftOn({count:2,materialCount:2})},(key,payload)=>{
  const custom=handler?.(key,payload);if(custom!==undefined)return custom;
  if(key==='panel:getEvidence')return mixedEvidence();
 });
}
async function decideBoth(){
 await act(()=>takeButton('T-1 · summary').click());
 await act(()=>keepButton('T-1 · priority').click());
}
// What each field reads once decided, in the order shown.
const decisionsShown=()=>[...container.querySelectorAll('.va-mfield')].map(f=>f.querySelector('.va-final--took')?'Approve':f.querySelector('.va-final--kept')?'Reject':'Undecided');
const saveButton=()=>[...container.querySelectorAll('.va-window__foot button')].find(b=>b.textContent==='Sign decisions');
const footText=()=>container.querySelector('.va-window__foot').textContent;
const submitCall=calls=>calls.find(([k])=>k==='signature:submit');

test('Save asks the server to check the whole map, opens the signing sheet, and records nothing',async()=>{
 const calls=mixedWindow(key=>key==='signature:challenge'?challengeOk({meaning:'Save selected drift decisions'}):undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 assert.ok(!calls.some(([k])=>k==='signature:challenge'),'choosing is not asking');
 await act(()=>saveButton().click());await flush();
 const challenge=calls.find(([k])=>k==='signature:challenge');
 assert.deepEqual(challenge[1].decisions,[{fieldId:'n1:priority',decision:'REJECT'},{fieldId:'n1:summary',decision:'APPROVE'}],'sorted exactly as the server sorts');
 assert.equal(challenge[1].intent,'DRIFT_MIXED');
 assert.equal(challenge[1].expectedEvidenceHash,'hash-9');
 assert.equal(challenge[1].decision,undefined,'a per-field decision names no whole-set decision');
 const sheet=container.querySelector('.va-sheet [aria-label="Sign decisions"]');
 assert.ok(sheet,'the same signing sheet every decision uses');
 assert.match(sheet.textContent,/1 change approved:.*T-1 · summary/);
 assert.match(sheet.textContent,/1 change rejected:.*T-1 · priority, put back to their signed values/);
 assert.match(sheet.textContent,/A new baseline is captured from the result once every rejected field is verified/);
 assert.ok(!submitCall(calls),'nothing is signed by opening the sheet');
});

test('cancelling the sheet leaves every choice in place and signs nothing',async()=>{
 const calls=mixedWindow(key=>key==='signature:challenge'?challengeOk():undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 await act(()=>saveButton().click());await flush();
 await act(()=>clickButton('Cancel').click());
 assert.equal(container.querySelector('.va-sheet'),null);
 assert.deepEqual(decisionsShown(),['Approve','Reject']);
 assert.equal(saveButton().disabled,false);
 assert.ok(!submitCall(calls));
});

test('signing sends the same map the server checked, then the receipt names each side and does not claim a baseline yet',async()=>{
 const calls=mixedWindow((key)=>{
  if(key==='signature:challenge')return challengeOk({meaning:'Save selected drift decisions'});
  if(key==='signature:submit')return {success:true,approvalId:'a'.repeat(32),mixed:{approved:1,rejected:1},restore:{state:'RESTORING'}};
 });
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 await act(()=>saveButton().click());await flush();
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign decisions').click());await flush();await flush();
 const submit=submitCall(calls)[1];
 assert.deepEqual(submit.decisions,[{fieldId:'n1:priority',decision:'REJECT'},{fieldId:'n1:summary',decision:'APPROVE'}]);
 assert.equal(submit.challengeId,'c'.repeat(32));
 assert.equal(submit.code,'123456');
 assert.equal(calls.filter(([k])=>k==='signature:challenge').length,1,'authenticated once, after all decisions');
 const receipt=container.querySelector('.va-receipt');
 assert.match(receipt.textContent,/Decisions saved\. The rejected fields are being restored; the new baseline is published once they are verified\./);
 assert.match(receipt.textContent,/Saved field decisions/);
 assert.match(receipt.textContent,/Approved1 · T-1 · summary/);
 assert.match(receipt.textContent,/Rejected1 · T-1 · priority/);
 assert.doesNotMatch(receipt.textContent,/Changes approved|is now the approved record/);
});

test('approving every field is signed the same way and the receipt says the new baseline is the record',async()=>{
 const calls=mixedWindow((key)=>{
  if(key==='signature:challenge')return challengeOk();
  if(key==='signature:submit')return {success:true,approvalId:'a'.repeat(32),mixed:{approved:2,rejected:0},restore:null};
 });
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await act(()=>clickButton('Take all new').click());
 await act(()=>saveButton().click());await flush();
 assert.match(container.querySelector('.va-sheet').textContent,/A new baseline is captured from the current content\./);
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign decisions').click());await flush();await flush();
 assert.match(container.querySelector('.va-receipt').textContent,/Decisions saved\. A new baseline is now the approved record\./);
 assert.ok(submitCall(calls));
});

test('rejecting every field says no new baseline version results',async()=>{
 mixedWindow(key=>key==='signature:challenge'?challengeOk():undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await act(()=>clickButton('Keep all signed').click());
 await act(()=>saveButton().click());await flush();
 assert.match(container.querySelector('.va-sheet').textContent,/No new baseline version is created: the work item returns to the baseline it was approved on\./);
});

test('a map the server refuses opens no sheet, shows why, and keeps the choices',async()=>{
 const calls=mixedWindow(key=>key==='signature:challenge'?{success:false,reason:'FIELD_NOT_RESTORABLE',error:'A field you chose to reject cannot be put back.'}:undefined);
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 await act(()=>saveButton().click());await flush();
 assert.equal(container.querySelector('.va-sheet'),null);
 assert.match(text(),/cannot be put back/);
 assert.deepEqual(decisionsShown(),['Approve','Reject']);
 assert.ok(!submitCall(calls));
});

test('a restoration that could not be started is never reported as a clean save',async()=>{
 mixedWindow((key)=>{
  if(key==='signature:challenge')return challengeOk();
  if(key==='signature:submit')return {success:true,approvalId:'a'.repeat(32),mixed:{approved:1,rejected:1},restore:{state:'QUEUING_FAILED'}};
 });
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 await act(()=>saveButton().click());await flush();
 await act(()=>typeInto(codeBox(),'123456'));
 await act(()=>clickButton('Sign decisions').click());await flush();await flush();
 assert.match(container.querySelector('.va-receipt').textContent,/could not be started, so the rejected fields are not yet put back and the new baseline is not published/);
});

test('choices are cleared when the record changes under them, and the reviewer is told',async()=>{
 let hash='hash-9';
 mixedWindow(key=>{
  if(key==='panel:getEvidence')return mixedEvidence({evidenceHash:hash});
  // The summary's content hash is what tells the window to read the evidence again.
  if(key==='panel:getSummary')return actor([],{actorName:'Priya Raman',baseline:baseline({version:3,approvedName:'Priya Raman'}),
   approval:{requiredRole:'QA Lead',requiredAssurance:'ESIGNATURE',meaning:'x',pending:null},drift:driftOn({count:2,materialCount:2}),evidenceVersion:7,contentHash:hash});
 });
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 assert.deepEqual(decisionsShown(),['Approve','Reject']);
 hash='hash-10';
 await act(()=>listeners0().get('JIRA_ISSUE_CHANGED')());await flush();await flush();
 assert.deepEqual(decisionsShown(),['Undecided','Undecided']);
 assert.match(text(),/The record changed while you were deciding, so your choices were cleared/);
 assert.equal(saveButton().disabled,true);
});

test('field decisions survive closing and reopening the same evidence review',async()=>{
 window.sessionStorage.clear();
 mixedWindow();
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 await decideBoth();
 assert.deepEqual(decisionsShown(),['Approve','Reject']);

 await act(()=>root.unmount());
 root=null;container?.remove();container=null;
 mixedWindow();
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();

 assert.deepEqual(decisionsShown(),['Approve','Reject']);
 assert.match(footText(),/1 approved · 1 rejected · all decided/);
});

test('deciding field by field, the footer counts the choices and has one Sign, which waits for every field',async()=>{
 mixedWindow();
 await act(()=>root.render(h(ReviewWindow,{issueKey:'T-1',tab:'changes'})));await flush();await flush();
 assert.match(footText(),/0 approved · 0 rejected · 2 still to decide/);
 assert.equal(saveButton().disabled,true);
 assert.equal(clickButton('Approve changes'),undefined,'the whole-set decision lives on the issue panel');
 assert.equal(clickButton('Reject and restore'),undefined);
 await act(()=>takeButton('T-1 · summary').click());
 assert.match(footText(),/1 approved · 0 rejected · 1 still to decide/);
 assert.equal(saveButton().disabled,true);
 await act(()=>keepButton('T-1 · priority').click());
 assert.equal(saveButton().disabled,false);
});

test('the baseline record names a per-field decision for what it is, not as a plain approval',async()=>{
 const baseline={baselineId:'c',version:4,approvedName:'Priya',nodeCount:1,edgeCount:0,totalFieldCount:2,treeHash:null};
 const text=(await renderInto(React.createElement(BaselineRecord,{baseline,
  latestApproval:{decision:'MIXED',state:'CONSUMED',actorName:'Priya',decidedAt:1000},record:null,
  evidenceLoading:false,evidenceError:null,onOpen:()=>{},onRetryEvidence:()=>{}}))).textContent;
 assert.match(text,/Decided field by field/);
 assert.match(text,/Field decisions/);
 assert.doesNotMatch(text,/MIXED/,'the raw decision code is never shown');
});
