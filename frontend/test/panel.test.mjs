import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({url:'https://tenant.atlassian.net/panel/index.html'});
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
   export const view={refresh:async()=>{},submit:v=>{globalThis.panelTransport.submitted.push(v);}};export const router={open:async()=>{}};`};
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
const {approvalMode}=await import('../src/lib/assurance.ts');
const {default:RestoreStatus}=await import('../src/panel/sections/RestoreStatus.tsx');
const {default:ApprovalField}=await import('../src/field/ApprovalField.tsx');
hooks.deregister();
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
const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
// React tracks a controlled input's value, so assigning `.value` directly is
// swallowed. Go through the native setter the way a real keystroke does.
const typeInto=(input,value)=>{
 Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);
 input.dispatchEvent(new window.Event('input',{bubbles:true}));
};
const clickButton=label=>[...container.querySelectorAll('button')].find(b=>label instanceof RegExp?label.test(b.textContent):b.textContent===label);
function setup(handler){
 const listeners=new Map();const subscribers=new Map();
 globalThis.panelTransport={emitted:[],submitted:[],invoke:handler,on:(name,cb)=>{if(!subscribers.has(name))subscribers.set(name,new Set());const callbacks=subscribers.get(name);callbacks.add(cb);listeners.set(name,payload=>{for(const fn of callbacks)fn(payload);});return {unsubscribe:()=>{callbacks.delete(cb);if(!callbacks.size)listeners.delete(name);}};}};
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
 const data={...state(),eligibility:{eligible:false},drift:{count:0,evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',name:'Done',toStatusName:'Done',eligible:true,requiredAssurance:'ESIGNATURE',meaning:'Approve this edge'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));
 const approve=[...container.querySelectorAll('button')].find(b=>b.textContent==='Sign to move to Done');
 assert.ok(approve);assert.equal(approve.disabled,false);
 const reject=[...container.querySelectorAll('button')].find(b=>b.textContent==='Reject and restore');
 assert.equal(reject,undefined);
 await act(()=>approve.click());assert.match(container.textContent,/Approve this edge/);
});

test('biometric assurance is an available signing mode, not an unavailable provider',async()=>{
 assert.equal(approvalMode('BIOMETRIC'),'biometric');
 setup(async key=>{
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return {success:true,challengeId:'id',nonce:'nonce',meaning:'Confirm on this device',requiredAssurance:'BIOMETRIC',expiresAt:Date.now()+60000};
  return {};
 });
 const data={...state(),eligibility:{eligible:true},approval:{requiredAssurance:'BIOMETRIC'},drift:{count:0,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',name:'Done',toStatusName:'Done',eligible:true,requiredAssurance:'BIOMETRIC',meaning:'Confirm on this device'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));await flush();
 assert.doesNotMatch(container.textContent,/provider is not configured/i);
 assert.ok([...container.querySelectorAll('button')].find(b=>b.textContent==='Sign to move to Done'));
});
const biometricState=()=>({...state(),eligibility:{eligible:true},approval:{requiredAssurance:'BIOMETRIC'},drift:{count:0,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',name:'Done',toStatusName:'Done',eligible:true,requiredAssurance:'BIOMETRIC'}]});
test('biometric signing runs the device ceremony and submits that assertion, never a signature code',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return {success:true,challengeId:'ch-1',nonce:'n',meaning:'I approve this record',requiredAssurance:'BIOMETRIC',expiresAt:Date.now()+60000};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  if(key==='signature:submit')return {success:true,approvalId:'a-1',transitioned:true};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalControls,{state:biometricState(),onDone:async()=>{}})));await settle();
 await act(()=>clickButton('Sign to move to Done').click());await settle();
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 assert.equal(ceremony.action,'confirm','the reviewer must be asked to confirm on their device');
 assert.ok(calls.some(([k])=>k==='webauthn:assertStart'),'the assertion must be started against the open approval challenge');
 const submit=calls.find(([k])=>k==='signature:submit');
 assert.ok(submit,'the approval must still be recorded through the same signature:submit row');
 assert.equal(submit[1].webauthn?.challengeId,'wa-1');
 assert.deepEqual(submit[1].webauthn?.response,{id:'cred-1',rawId:'cred-1'});
 assert.ok(!('code' in submit[1]),'a biometric approval must not carry a signature code, which the server reads as an electronic signature');
});
test('a cancelled device check reports the refusal and records nothing',async()=>{
 stubCeremony({success:false,errorName:'NotAllowedError',errorMessage:'cancelled'});const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return {success:true,challengeId:'ch-1',nonce:'n',meaning:'I approve this record',requiredAssurance:'BIOMETRIC',expiresAt:Date.now()+60000};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalControls,{state:biometricState(),onDone:async()=>{}})));await settle();
 await act(()=>clickButton('Sign to move to Done').click());await settle();
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 assert.ok(!calls.some(([k])=>k==='signature:submit'),'a failed device check must not record an approval');
 assert.match(container.textContent,/device check/i);
});
test('a reviewer with no registered device is offered setup on this screen, not a dead end',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:false,usableHere:false};
  if(key==='webauthn:enrolStart')return {ok:true,challengeId:'e-1',options:{challenge:'abc'}};
  if(key==='webauthn:enrolFinish')return {ok:true,enrolled:true};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalControls,{state:biometricState(),onDone:async()=>{}})));await settle();
 const setupButton=clickButton(/set up/i);
 assert.ok(setupButton,'the panel must offer biometric setup when the reviewer has no registered device');
 await act(()=>setupButton.click());await settle();
 assert.equal(ceremony.action,'enrol');
 assert.ok(calls.some(([k])=>k==='webauthn:enrolFinish'),'the registration must be completed on the server');
});
// The server raises any policy below an electronic signature to that floor
// (MINIMUM_ASSURANCE in src/lib/approval/levels.js). A screen that does not
// mirror that shows "not configured" for an edge the server would happily sign.
test('every configured assurance level offers a signing method, matching the server floor',async()=>{
 assert.equal(approvalMode('BIOMETRIC'),'biometric');
 assert.equal(approvalMode('ESIGNATURE'),'totp');
 assert.equal(approvalMode('NATIVE_TRANSITION'),'totp','workflow approval is raised to the signature floor');
 assert.equal(approvalMode('JSM_APPROVAL'),'totp','a JSM edge is served by the signature floor, not refused');
 assert.equal(approvalMode('NONSENSE'),'totp','an unreadable policy falls back to the floor, never below it');
});
test('a JSM-configured transition is signable rather than a dead end',async()=>{
 setup(async key=>key==='signature:challenge'?{success:true,challengeId:'ch',nonce:'n',meaning:'I approve',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000}:{});
 const data={...state(),eligibility:{eligible:true},approval:{requiredAssurance:'JSM_APPROVAL'},drift:{count:0,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',eligible:true,requiredAssurance:'JSM_APPROVAL'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));await settle();
 assert.doesNotMatch(container.textContent,/provider is not configured/i);
 assert.ok(clickButton('Sign to move to 2'),'the reviewer must be able to start the signature');
});
test('a clean controlled transition is signed for the named move, not generic approval',async()=>{
 setup(async()=>({}));
 const data={...state(),eligibility:{eligible:true},drift:{count:0,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',name:'Selected for Development',toStatusName:'Selected for Development',eligible:true,requiredAssurance:'ESIGNATURE',meaning:'Ready for development'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));await settle();
 assert.ok(clickButton('Sign to move to Selected for Development'));
 assert.match(container.textContent,/Sign the configured transition to Selected for Development/);
 assert.ok(!clickButton('Approve'),'the button must say what transition is being signed');
});
test('electronic-signature drift decisions do not sign a workflow transition',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signature:challenge')return {success:true,challengeId:'ch',nonce:'n',meaning:'I approve these changes',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000};
  if(key==='signature:submit')return {success:true,approvalId:'a',transitioned:false};
  return {};});
 const data={...state(),eligibility:{eligible:true},approval:{requiredAssurance:'ESIGNATURE'},drift:{count:1,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',name:'Done',toStatusName:'Done',eligible:true,requiredAssurance:'BIOMETRIC',meaning:'Bug done'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));await settle();
 assert.match(container.textContent,/Review the tracked changes since baseline/);
 assert.match(container.textContent,/Electronic signature/);
 assert.doesNotMatch(container.textContent,/Approval transition/);
 await act(()=>clickButton('Approve changes').click());await settle();
 const challenge=calls.find(([k])=>k==='signature:challenge');
 assert.ok(challenge);
 assert.equal(challenge[1].transitionId, undefined);
 assert.equal(challenge[1].toStatusId, undefined);
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 await act(()=>typeInto(container.querySelector('.va-code'),'123456'));await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 const submit=calls.find(([k])=>k==='signature:submit');
 assert.equal(submit[1].code,'123456');
 assert.equal(submit[1].webauthn, undefined);
});

test('biometric drift decisions follow the configured controlled-transition assurance without signing the transition',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='signature:challenge')return {success:true,challengeId:'ch',nonce:'n',meaning:'I approve these changes',requiredAssurance:'BIOMETRIC',expiresAt:Date.now()+60000};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  if(key==='signature:submit')return {success:true,approvalId:'a',transitioned:false};
  return {};});
 const data={...state(),eligibility:{eligible:true},approval:{requiredAssurance:'BIOMETRIC'},drift:{count:1,fields:[],evidenceHash:'hash'},transitions:[{transitionId:'5',toStatusId:'2',name:'Done',toStatusName:'Done',eligible:true,requiredAssurance:'BIOMETRIC',meaning:'Bug done'}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));await settle();
 assert.match(container.textContent,/Review the tracked changes since baseline/);
 assert.match(container.textContent,/Biometric approval/);
 assert.doesNotMatch(container.textContent,/Approval transition/);
 await act(()=>clickButton('Approve changes').click());await settle();
 const challenge=calls.find(([k])=>k==='signature:challenge');
 assert.ok(challenge);
 assert.equal(challenge[1].transitionId, undefined);
 assert.equal(challenge[1].toStatusId, undefined);
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 await act(()=>clickButton('Sign and approve').click());await settle();
 assert.equal(ceremony.action,'confirm');
 const submit=calls.find(([k])=>k==='signature:submit');
 assert.equal(submit[1].webauthn?.challengeId,'wa-1');
 assert.ok(!('code' in submit[1]));
});

// ── The transition-screen field ───────────────────────────────────────────
// The surface that was showing a code box for a biometric edge.
const fieldContext={extension:{issue:{key:'T-1',id:'10'}}};
const fieldState=(requiredAssurance)=>({issue:{key:'T-1',summary:'Bug to close',statusName:'In Progress'},actorName:'Sai Harsha',drift:{evidenceHash:'hash'},
 transitions:[{transitionId:'5',toStatusId:'2',name:'Done',meaning:'Bug Resolved',requiredRole:'SDE-1',requiredAssurance,eligible:true}]});
test('the transition screen asks for a device check on a biometric edge, not an authenticator code',async()=>{
 const ceremony=stubCeremony();const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='panel:getState'||key==='signing:context')return fieldState('BIOMETRIC');
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'BIOMETRIC'};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  if(key==='approval:submit')return {success:true,approvalId:'f'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalField,{context:fieldContext})));await settle();
 assert.match(container.textContent,/Bug Resolved/);
 assert.equal(container.querySelector('.va-code'),null,'a biometric edge must not offer an authenticator code box');
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 const confirm=clickButton(/Confirm with your device/i);
 assert.ok(confirm,'the reviewer must be offered the device check');
 await act(()=>confirm.click());await settle();
 assert.equal(ceremony.action,'confirm');
 const submit=calls.find(([k])=>k==='approval:submit');
 assert.ok(submit,'the approval must be recorded server-side');
 assert.equal(submit[1].preauthorize,true,'Jira performs the transition, not the app');
 assert.equal(submit[1].webauthn?.challengeId,'wa-1');
 assert.ok(!('code' in submit[1]),'a biometric approval must not carry a signature code');
 // The field value is the receipt the validator looks for.
 assert.equal(globalThis.panelTransport.submitted.at(-1),'f'.repeat(32));
});
test('the transition screen still signs an electronic-signature edge with a code',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='panel:getState'||key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'ESIGNATURE'};
  if(key==='approval:submit')return {success:true,approvalId:'a'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalField,{context:fieldContext})));await settle();
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 const box=container.querySelector('.va-code');
 assert.ok(box,'an electronic-signature edge must offer the code box');
 await act(()=>typeInto(box,'123456'));await settle();
 const submit=calls.find(([k])=>k==='approval:submit');
 assert.ok(submit,'six digits records the approval');
 assert.equal(submit[1].code,'123456');
 assert.equal(submit[1].preauthorize,true);
 assert.ok(!calls.some(([k])=>k==='webauthn:assertStart'),'a code edge must never open a device ceremony');
 assert.equal(globalThis.panelTransport.submitted.at(-1),'a'.repeat(32));
});
test('the transition screen records nothing when the device check is refused',async()=>{
 stubCeremony({success:false,errorName:'NotAllowedError',errorMessage:'cancelled'});const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='panel:getState'||key==='signing:context')return fieldState('BIOMETRIC');
  if(key==='webauthn:status')return {ok:true,enrolled:true,usableHere:true};
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'BIOMETRIC'};
  if(key==='webauthn:assertStart')return {ok:true,challengeId:'wa-1',options:{challenge:'abc'}};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalField,{context:fieldContext})));await settle();
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 await act(()=>clickButton(/Confirm with your device/i).click());await settle();
 assert.ok(!calls.some(([k])=>k==='approval:submit'),'a refused device check must not record an approval');
 assert.ok(!globalThis.panelTransport.submitted.some(v=>/^[a-f0-9]{32}$/.test(v)),'and must not hand Jira a receipt');
});
test('a reviewer without the approver role is told so instead of being offered a signature',async()=>{
 setup(async key=>(key==='panel:getState'||key==='signing:context')
  ?{...fieldState('BIOMETRIC'),transitions:[{transitionId:'5',toStatusId:'2',name:'Done',meaning:'Bug Resolved',requiredRole:'SDE-1',requiredAssurance:'BIOMETRIC',eligible:false}]}
  :{});
 await act(()=>root.render(React.createElement(ApprovalField,{context:fieldContext})));await settle();
 assert.match(container.textContent,/do not hold the approver role/i);
 assert.equal(container.querySelector('.va-affirm input'),null,'nothing is signable without the role');
});
// A custom field in the issue-transition experience does not reliably carry
// extension.issue. The resolver can still resolve it from the Forge context,
// so the field must ask rather than refuse.
test('the transition screen still works when Jira gives the field no issue in context',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='panel:getState'||key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='approval:challenge')return {success:true,challengeId:'ch-1',meaning:'Bug Resolved',requiredAssurance:'ESIGNATURE'};
  if(key==='approval:submit')return {success:true,approvalId:'b'.repeat(32),printedName:'Sai Harsha',meaning:'Bug Resolved'};
  return {};});
 await act(()=>root.render(React.createElement(ApprovalField,{context:{extension:{}}})));await settle();
 assert.doesNotMatch(container.textContent,/could not tell which work item/i);
 assert.match(container.textContent,/Bug Resolved/);
 await act(()=>container.querySelector('.va-affirm input').click());await settle();
 await act(()=>typeInto(container.querySelector('.va-code'),'123456'));await settle();
  const submit=calls.find(([k])=>k==='approval:submit');
  assert.ok(submit,'the approval is recorded using the key the server resolved');
  assert.equal(submit[1].issueKey,'T-1');
});

test('an observer sees the living state sentence instead of decision action buttons',async()=>{
 setup(async key=>key==='panel:getState'?{...state(),tier:'observer',state:'Waiting on a signature from SDE-1'}:{restores:[]});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(container.textContent,/Waiting on a signature from SDE-1/);
 assert.equal(clickButton('Approve'),undefined,'no approve button for observer');
 assert.equal(clickButton(/Reject/i),undefined,'no reject button for observer');
});

// The panel used to count the change, say it needed a decision, and then render
// the observer card — because the tier was derived from gated transitions alone
// and this item sits in a status no rule fires out of. Approving drift captures
// a new baseline and rejecting restores the old one; neither is a workflow move,
// so an empty `transitions` must still leave both decisions reachable.
test('a change since approval is decidable even when no transition is offered',async()=>{
 setup(async key=>key==='panel:getState'?{...state(),tier:'actor',state:'Changes since approval need a decision',
  eligibility:{eligible:true},transitions:[],record:{version:2,fields:[]},
  drift:{count:1,materialCount:1,fields:[{fieldId:'duedate',fieldName:'Due date'}],evidenceHash:'e1'}}:{restores:[]});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.match(container.textContent,/1 change since approval/);
 assert.ok(clickButton('Approve changes'),'the drift decision must be reachable');
 assert.ok(clickButton(/Reject and restore/i),'and so must its refusal');
 assert.doesNotMatch(container.textContent,/Nothing needs a signature/);
});

test('controls alerts are not rendered when controls is omitted from payload',async()=>{
 const stateWithoutControls={...state()};delete stateWithoutControls.controls;
 setup(async key=>key==='panel:getState'?stateWithoutControls:{restores:[]});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 assert.doesNotMatch(container.textContent,/Workflow protection needs attention/);
 assert.doesNotMatch(container.textContent,/A control incident was recorded/);
});

const treeDriftState=()=>({...state(),tier:'actor',state:'Changes since approval need a decision',
 eligibility:{eligible:true},transitions:[{transitionId:'5',toStatusId:'2',eligible:true,requiredAssurance:'ESIGNATURE',meaning:'Approve'}],
 record:{version:2,fields:[]},
 drift:{count:1,materialCount:1,fields:[],evidenceHash:'e1'},
 rejection:{deleteIssueKeys:['NEW-1','NEW-2'],recreateCount:5}});

test('reject confirmation names every added descendant to be deleted',async()=>{
 setup(async key=>key==='panel:getState'?treeDriftState():{restores:[]});
 await act(()=>root.render(React.createElement(IssuePanel,{issueKey:'T-1'})));await flush();
 await act(()=>clickButton(/Reject and restore/i).click());await flush();
 assert.match(container.textContent,/NEW-1, NEW-2/);
 assert.match(container.textContent,/Recreate 5 missing nodes/i);
});

test('transition field sends Jira issueTransition.id to signing context',async()=>{
 const calls=[];
 setup(async(key,payload)=>{calls.push([key,payload]);
  if(key==='signing:context')return fieldState('ESIGNATURE');
  if(key==='panel:getState')return fieldState('ESIGNATURE');
  return {};});
 await act(()=>root.render(React.createElement(ApprovalField,{context:{extension:{issue:{key:'T-1',id:'10'},issueTransition:{id:'102'}}}})));await settle();
 const call=calls.find(([key])=>key==='signing:context');
 assert.ok(call,'signing:context must be called');
 assert.equal(call[1].transitionId,'102');
});

test('non-capturing approval never promises a baseline',async()=>{
 setup(async key=>key==='signature:challenge'?{success:true,challengeId:'id',nonce:'nonce',meaning:'Approve for release',requiredAssurance:'ESIGNATURE',expiresAt:Date.now()+60000}:{});
 const data={...state(),eligibility:{eligible:true},drift:{count:0,fields:[],evidenceHash:'hash'},
  transitions:[{transitionId:'5',toStatusId:'2',name:'Done',toStatusName:'Done',eligible:true,requiredAssurance:'ESIGNATURE',meaning:'Approve for release',capturesBaseline:false}]};
 await act(()=>root.render(React.createElement(ApprovalControls,{state:data,onDone:async()=>{}})));
 await act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Sign to move to Done').click());await settle();
 assert.doesNotMatch(container.textContent,/baseline will be captured/i);
});
