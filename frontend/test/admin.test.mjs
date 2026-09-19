import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({url:'https://tenant.atlassian.net/admin'});
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const reactURL = new URL('../node_modules/react/index.js', import.meta.url).href;
const hooks=registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@forge/bridge')return {url:'admin:bridge',shortCircuit:true};
  if(specifier.startsWith('@atlaskit/'))return {url:'admin:kit/'+specifier.split('/')[1],shortCircuit:true};
  if(specifier.startsWith('.')){const url=new URL(specifier,context.parentURL);for(const ext of ['.ts','.tsx'])if(fs.existsSync(fileURLToPath(url)+ext))return {url:url.href+ext,shortCircuit:true};}
  return next(specifier,context);
 },
 load(url,context,next){
  if(url==='admin:bridge')return {format:'module',shortCircuit:true,source:`export const invoke=(...args)=>globalThis.transport(...args);export const events={emit:async()=>{}};export const router={open:async()=>{}};export const view={createHistory:async()=>({location:{pathname:'/'},listen:()=>()=>{}})};`};
  if(url.startsWith('admin:kit/'))return {format:'module',shortCircuit:true,source:`import React from '${reactURL}'; export default function Kit({children,onClick,isDisabled,disabled,appearance,...props}){const kind='${url.split('/').at(-1)}';if(kind==='textfield')return React.createElement('input',{...props,disabled:isDisabled||disabled});if(kind==='button')return React.createElement('button',{onClick,disabled:isDisabled||disabled},children);return React.createElement('div',{},children);}`};
  if(/\.tsx?$/.test(url))return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
  return next(url,context);
 }
});
const {default:React,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const pages={};
for(const name of ['Fields','Health','ContentReview','Retention','Roles','Transitions','Settings','Credentials','Admins','Ledger']) pages[name]=(await import(`../src/admin/pages/${name}Page.tsx`)).default;
pages['AdminConsole'] = (await import('../src/admin/AdminConsole.tsx')).default;
hooks.deregister();
let root,container;
const projects=[{id:'1',name:'First project',key:'ONE'},{id:'2',name:'Second project',key:'TWO'}];
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function mount(page,invoke){globalThis.transport=(key,payload)=>key==='harness:logAction'?Promise.resolve({ok:true}):invoke(key,payload);container=document.createElement('div');document.body.append(container);root=createRoot(container);await act(()=>root.render(React.createElement(pages[page],{projects})));await flush();}
afterEach(async()=>{if(root)await act(()=>root.unmount());container?.remove();root=null;});
const text=()=>container.textContent;
const button=label=>[...container.querySelectorAll('button')].find(b=>b.textContent.includes(label));
async function select(index,value){await act(()=>{const el=container.querySelectorAll('select')[index];el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));});await flush();}
const typeInto=(input,value)=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
  input.dispatchEvent(new window.Event('change',{bubbles:true}));
};
const setup=name=>({success:true,controlled:[{field_id:'summary',field_name:name,field_kind:'TEXT',store_values:true,pinned:true,declared:true}],excluded:[],available:[]});

test('fields cannot show a late response from another project',async()=>{
 const first=defer();await mount('Fields',(key,p)=>p?.projectId==='1'?first.promise:setup('Second field'));
 await select(0,'1');await select(0,'2');first.resolve(setup('First field'));await flush();
 assert.match(text(),/Second field/);assert.doesNotMatch(text(),/First field/);
});
test('always controlled fields cannot offer an impossible exclusion',async()=>{
 await mount('Fields',()=>setup('Summary'));await select(0,'1');assert.equal(button('Exclude'),undefined);assert.match(text(),/Always tracked/);
});
test('a field mutation locks project selection until refresh finishes',async()=>{
 const save=defer();await mount('Fields',key=>key==='admin:setRetention'?save.promise:setup('Summary'));await select(0,'1');
 await act(()=>container.querySelector('input[type=checkbox]').click());assert.equal(container.querySelector('select').disabled,true);
 save.resolve({success:true});await flush();assert.equal(container.querySelector('select').disabled,false);
});
test('control health never claims no findings while its read is pending or failed',async()=>{
 const pending=defer();await mount('Health',()=>pending.promise);assert.doesNotMatch(text(),/No open findings/);
 pending.resolve({success:false,error:'Health unavailable'});await flush();assert.doesNotMatch(text(),/No open findings/);assert.match(text(),/Health unavailable/);
});
test('content changes disclose truncation and do not show an empty success after failure',async()=>{
 await mount('ContentReview',()=>({success:true,changes:[],hasMore:true}));assert.match(text(),/200|More changes|limited/i);
 globalThis.transport=()=>({success:false,error:'Read unavailable'});await act(()=>button('Refresh').click());await flush();assert.doesNotMatch(text(),/No unresolved changes/);
});
test('retention can retry an initial read failure',async()=>{
 await mount('Retention',()=>({success:false,error:'Policy unavailable'}));assert.ok(button('Retry'));
});
test('roles ignore stale issue type lookups',async()=>{
 const first=defer();await mount('Roles',(key,p)=>key==='admin:listEligibility'?{success:true,grants:[]}:p.projectId==='1'?first.promise:{success:true,issueTypes:[{id:'20',name:'Second type'}]});
 await select(0,'1');await select(0,'2');first.resolve({success:true,issueTypes:[{id:'10',name:'First type'}]});await flush();
 assert.match(text(),/Second type/);assert.doesNotMatch(text(),/First type/);
});
test('transition rules offer an edit action using the update endpoint',async()=>{
 await mount('Transitions',()=>({success:true,transitions:[{ctId:'a'.repeat(32),projectId:'1',issueTypeId:'2',transitionId:'100',fromStatusId:'*',toStatusId:'3',meaning:'Approved',requiredRole:'QA',requiredAssurance:'ESIGNATURE',captureBaseline:true,blockOnDrift:true}]}));
 assert.ok(button('Edit'));
});
test('settings cannot offer unsupported strict enforcement',async()=>{
 await mount('Settings',()=>({success:true,config:{ai:{enabled:true},policy:{mode:'DETECT'}}}));await select(0,'1');
 assert.equal([...container.querySelectorAll('option')].some(o=>o.value==='STRICT'),false);
 assert.match(text(),/AI/);
});
test('credential history reports loading instead of an empty record',async()=>{
 const pending=defer();await mount('Credentials',()=>pending.promise);assert.doesNotMatch(text(),/No reset grants recorded/);pending.resolve({success:true,grants:[],credentials:[]});await flush();
});

test('ledger does not display an empty history before its first read completes',async()=>{
 const pending=defer();await mount('Ledger',()=>pending.promise);assert.doesNotMatch(text(),/Nothing recorded yet/);
 pending.resolve({success:true,entries:[],hasMore:false});await flush();
});
test('ledger clears stale pagination when a lookup fails',async()=>{
 await mount('Ledger',()=>({success:true,entries:[],hasMore:true,nextBeforeSeq:50}));
 assert.ok(button('Load more'));
 globalThis.transport=key=>key==='harness:logAction'?{ok:true}:{success:false,error:'Ledger read failed'};
 await act(()=>button('Load more').click());await flush();assert.equal(button('Load more'),undefined);
});

test('settings renders operational controls and saves modified values',async()=>{
 let savedConfig = null;
 await mount('Settings',(key,payload)=>{
  if(key==='admin:getConfig') return {success:true,revision:'rev-1',config:{enabled:true,visibility:'reviewer-only',queueThreshold:'MINOR',ai:{enabled:true,maxCompletionTokens:4096},restore:{commentOnRestore:true,notifyUsers:false},policy:{mode:'DETECT'}}};
  if(key==='admin:saveConfig') { savedConfig = payload; return {success:true}; }
  return {success:true};
 });
 assert.match(text(),/Enable VAtlassian protection/);
 assert.match(text(),/Panel visibility boundary/);
 assert.match(text(),/Review queue threshold/);
 assert.match(text(),/Post audit comment on restoration/);
 assert.match(text(),/Notify authors of unapproved modifications/);

 // Toggle comment on restore
 const checkboxes = container.querySelectorAll('input[type=checkbox]');
 await act(()=>checkboxes[2].click());
 assert.ok(button('Save settings'));

 await act(()=>button('Save settings').click());
 await flush();
 assert.ok(savedConfig);
 assert.equal(savedConfig.config.restore.commentOnRestore, false);
 assert.match(text(),/Site-wide default settings saved/);
});

test('settings handles optimistic concurrency conflicts cleanly',async()=>{
 await mount('Settings',(key)=>key==='admin:getConfig'?{success:true,revision:'rev-1',config:{enabled:true,ai:{enabled:true},policy:{mode:'DETECT'}}}:{success:false,error:'Settings changed since you loaded this page.'});
 const checkboxes = container.querySelectorAll('input[type=checkbox]');
 await act(()=>checkboxes[0].click()); // toggle enabled
 await act(()=>button('Save settings').click());
 await flush();
 assert.match(text(),/Settings changed since you loaded this page/);
 assert.ok(button('Retry'));
});

test('content review filters by project and handles refresh',async()=>{
 const projectCalls = [];
 await mount('ContentReview',(key,payload)=>{
  projectCalls.push(payload?.projectId);
  return {success:true,changes:[]};
 });
 assert.ok(container.querySelector('select'));
 await select(0,'1');
 await flush();
 assert.equal(projectCalls.at(-1), '1');
});

test('admin console configure mode defaults to settings and renders in-app tabs',async()=>{
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 globalThis.transport=(key)=>key==='admin:check'?{success:true,isAdmin:true,needsBootstrap:false}:key==='admin:listProjects'?{success:true,projects}:key==='admin:getConfig'?{success:true,revision:'1',config:{enabled:true,ai:{enabled:true},policy:{mode:'DETECT'}}}:{success:true};
 await act(()=>root.render(React.createElement(pages['AdminConsole'],{configure:true})));
 await flush();

 const tabs = container.querySelectorAll('.va-nav-tab');
 assert.ok(tabs.length >= 8);
 assert.match(tabs[0].textContent, /Settings/);
 assert.match(text(), /Operational policies/);

 // Click on Administrators tab
 const adminsTab = [...tabs].find(t=>t.textContent.includes('Administrators'));
 globalThis.transport=(key)=>key==='admin:listAdmins'?{success:true,admins:[]}:{success:true};
 await act(()=>adminsTab.click());
 await flush();
 assert.match(text(),/Add administrator/);
});

test('roles page allows site-wide role grant with all projects option',async()=>{
  let grantedPayload = null;
  await mount('Roles',(key,payload)=>{
    if(key==='admin:listEligibility') return {success:true,grants:[]};
    if(key==='admin:searchUsers') return {success:true,users:[{accountId:'u1',displayName:'Jane Doe'}]};
    if(key==='admin:grantEligibility') { grantedPayload = payload; return {success:true}; }
    return {success:true};
  });
  const userInput = container.querySelector('.va-typeahead input');
  assert.ok(userInput);
  await act(()=>typeInto(userInput,'Jane'));
  await act(()=>new Promise(r=>setTimeout(r,350)));
  await flush();
  const userOption = container.querySelector('.va-typeahead__option');
  assert.ok(userOption);
  await act(()=>userOption.click());
  await flush();

  await select(0,'*');
  await flush();

  const roleInput = container.querySelector('input[placeholder="QA Lead"]');
  assert.ok(roleInput);
  await act(()=>typeInto(roleInput,'Site QA'));
  await flush();

  const grantBtn = button('Grant role');
  assert.equal(grantBtn.disabled, false);
  await act(()=>grantBtn.click());
  await flush();

  assert.deepEqual(grantedPayload, {
    targetAccountId: 'u1',
    issueTypeId: '*',
    role: 'Site QA',
    projectId: '*'
  });
});
