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
async function mount(page,invoke,props={}){globalThis.transport=(key,payload)=>key==='harness:logAction'?Promise.resolve({ok:true}):invoke(key,payload);container=document.createElement('div');document.body.append(container);root=createRoot(container);await act(()=>root.render(React.createElement(pages[page],{projects,...props})));await flush();}
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

test('settings saves only changed live preferences without materializing inherited values',async()=>{
 let savedConfig;
 await mount('Settings',(key,payload)=>{
  if(key==='admin:getConfig') return {success:true,revision:'site-rev',config:{enabled:true,visibility:'reviewer-only',ai:{enabled:true,maxCompletionTokens:4096},restore:{commentOnRestore:true,notifyUsers:false}}};
  if(key==='admin:saveConfig'){savedConfig=payload;return {success:true};}
  return {success:true};
 });
 assert.doesNotMatch(text(),/transitions proceed without VAtlassian validator blocks/);
 assert.equal([...container.querySelectorAll('label')].some(l=>l.textContent.includes('Post audit comment')&&l.querySelector('input:not(:disabled)')),false);
 const label=[...container.querySelectorAll('label')].find(l=>l.textContent.includes('Summaries and field suggestions'));
 await act(()=>label.querySelector('input').click());await act(()=>button('Save').click());await flush();
 assert.deepEqual(savedConfig.config,{ai:{enabled:false}});
 assert.match(text(),/Site-wide default settings saved/);
});

test('settings handles optimistic concurrency conflicts cleanly',async()=>{
 await mount('Settings',(key)=>key==='admin:getConfig'?{success:true,revision:'rev-1',config:{enabled:true,ai:{enabled:true},policy:{mode:'DETECT'}}}:{success:false,error:'Settings changed since you loaded this page.'});
 const checkboxes = container.querySelectorAll('input[type=checkbox]');
 await act(()=>checkboxes[0].click()); // toggle enabled
 await act(()=>button('Save').click());
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
 assert.match(text(), /Settings/);

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

test('all projects does not force all work types when granting a role',async()=>{
 await mount('Roles',key=>key==='admin:listEligibility'?{success:true,grants:[]}:{success:true,issueTypes:[{id:'2',name:'Requirement'}]});
 await select(0,'*');
 assert.equal(container.querySelectorAll('select')[1].disabled,false);
 assert.ok([...container.querySelectorAll('select')[1].options].some(o=>o.value==='2'));
 await select(1,'2');
 assert.equal(container.querySelectorAll('select')[1].value,'2');
});

test('role membership can refresh after another administrator changes it',async()=>{
 let grants=[];
 await mount('Roles',()=>({success:true,grants}));
 grants=[{elId:'a'.repeat(32),signerName:'New reviewer',role:'QA',issueTypeName:'All work item types',scope:'All projects',signerActive:true}];
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.match(text(),/New reviewer/);
 assert.ok(button('Refresh roles'));
});

test('administrator membership refreshes when returning from another tab',async()=>{
 let admins=[];
 await mount('Admins',()=>({success:true,admins}));
 admins=[{accountId:'new-admin',displayName:'New administrator',state:'ACTIVE',canRevoke:false}];
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.match(text(),/New administrator/);
});

test('administrator access can be checked again after another admin grants it',async()=>{
 let granted=false;
 await mount('AdminConsole',key=>key==='admin:check'?{success:true,isAdmin:granted,isJiraAdmin:false,needsBootstrap:false}:key==='admin:listProjects'?{success:true,projects}:{success:true,admins:[]});
 granted=true;
 assert.equal(Boolean(button('Check access again')),true);
 await act(()=>button('Check access again').click());await flush();
 assert.match(text(),/Add administrator/);
});

test('an older access refusal cannot replace a newly verified administrator grant',async()=>{
 const pending=defer();let checks=0;
 await mount('AdminConsole',key=>key==='admin:check'?(++checks===1?pending.promise:{success:true,isAdmin:true,needsBootstrap:false}):key==='admin:listProjects'?{success:true,projects}:{success:true,admins:[]});
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 pending.resolve({success:true,isAdmin:false,isJiraAdmin:false,needsBootstrap:false});await flush();
 assert.match(text(),/Add administrator/);
});

test('a late rule listing cannot replace the refreshed rule list',async()=>{
 const pending=defer();let reads=0;
 await mount('Transitions',()=>++reads===1?pending.promise:{success:true,transitions:[]});
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 pending.resolve({success:true,transitions:[{ctId:'a'.repeat(32),meaning:'Outdated rule',requiredRole:'QA'}]});await flush();
 assert.doesNotMatch(text(),/Outdated rule/);
});

test('disabled project settings describe the actual controlled-transition refusal',async()=>{
 await mount('Settings',()=>({success:true,revision:null,config:{enabled:false,ai:{enabled:true}}}));
 assert.doesNotMatch(text(),/validators are unaffected/);
 assert.match(text(),/controlled transitions are blocked/);
});

test('a failed project directory read leaves administrator recovery accessible',async()=>{
 await mount('AdminConsole',key=>key==='admin:check'?{success:true,isAdmin:true,needsBootstrap:false}:key==='admin:listProjects'?{success:false,error:'Jira projects unavailable'}:{success:true,admins:[]});
 assert.match(text(),/Add administrator/);
});
test('tracking an unreviewed field explicitly retains contents for baseline restoration',async()=>{
 let payload;
 await mount('Fields',(key,p)=>{if(key==='admin:trackField'){payload=p;return {success:true};}return {...setup('Summary'),available:[{fieldId:'customfield_1',fieldName:'Requirement'}]};});
 await select(0,'1');const track=button('Track and retain');assert.ok(track);await act(()=>track.click());await flush();assert.equal(payload.storeValues,true);
});

const searchable=()=>({...setup('Summary'),
 excluded:[{fieldId:'environment_custom',fieldName:'Deployment environment'}],
 available:[{fieldId:'attachment',fieldName:'Attachment'},{fieldId:'customfield_10015',fieldName:'Start date'},{fieldId:'priority',fieldName:'Priority'}]});
const search=async value=>{await act(()=>typeInto(container.querySelector('input[type=search]'),value));await flush();};
test('the field search finds any trackable field by name and tracks it with its contents retained',async()=>{
 let payload;
 await mount('Fields',(key,p)=>{if(key==='admin:trackField'){payload=p;return {success:true};}return searchable();});
 await select(0,'1');await search('attach');
 assert.match(text(),/Attachment/);assert.doesNotMatch(text(),/Start date|Priority|Deployment environment/);
 await act(()=>button('Track and retain').click());await flush();
 assert.deepEqual({fieldId:payload.fieldId,storeValues:payload.storeValues,issueTypeId:payload.issueTypeId},{fieldId:'attachment',storeValues:true,issueTypeId:'*'});
});
test('the field search matches field ids, and reaches deliberately excluded fields too',async()=>{
 await mount('Fields',()=>searchable());await select(0,'1');
 await search('customfield_10015');assert.match(text(),/Start date/);assert.doesNotMatch(text(),/Attachment/);
 await search('deployment');assert.match(text(),/Deployment environment/);assert.match(text(),/Excluded/);assert.ok(button('Track and retain'));
});
test('a tracked field found by search says so instead of offering to track it again',async()=>{
 await mount('Fields',()=>searchable());await select(0,'1');await search('summ');
 assert.match(text(),/Summary/);assert.match(text(),/Tracked/);assert.equal(button('Track and retain'),undefined);
});
test('a search with no match says the field is not trackable here, and why that can be',async()=>{
 await mount('Fields',()=>searchable());await select(0,'1');await search('comment');
 assert.match(text(),/No trackable field matches/);
});
test('editing a transition saves its exact edge, revision and authentication settings',async()=>{
 const rule={ctId:'a'.repeat(32),revision:'rule-version',projectId:'1',issueTypeId:'2',transitionId:'100',fromStatusId:'*',toStatusId:'3',meaning:'Approved',requiredRole:'QA',requiredAssurance:'BIOMETRIC',captureBaseline:true,blockOnDrift:true,requireDecision:true};
 let update;
 await mount('Transitions',(key,payload)=>{
  if(key==='admin:listControlledTransitions')return {success:true,transitions:[rule]};
  if(key==='admin:listIssueTypesForProject')return {success:true,issueTypes:[{id:'2',name:'Change'}]};
  if(key==='admin:listStatusesForProject')return {success:true,statuses:[{id:'3',name:'Done'}]};
  if(key==='admin:listAvailableRoles')return {success:true,roles:['QA']};
  if(key==='admin:listWorkflowTransitions')return {success:true,transitions:[{transitionId:'100',name:'Approve',fromStatusId:'*',fromStatusName:'Any status',toStatusId:'3',toStatusName:'Done',global:true,validatorAttached:true,hasScreen:true,jiraRules:{conditions:false,otherValidators:0,postFunctions:0}}]};
  if(key==='admin:updateControlledTransition'){update=payload;return {success:true};}
  throw Error('unexpected '+key);
 });
 await act(()=>button('Edit').click());await flush();
 const meaning=container.querySelector('input[placeholder="Approved for release"]');await act(()=>typeInto(meaning,'Approved for use'));await flush();
 assert.equal(button('Save rule').disabled,false);await act(()=>button('Save rule').click());await flush();
 assert.equal(update.expectedRevision,'rule-version');assert.equal(update.requiredAssurance,'BIOMETRIC');assert.equal(update.transitionId,'100');assert.equal(update.fromStatusId,'*');assert.equal(update.requireDecision,true);assert.equal(update.meaning,'Approved for use');
});

test('failed rule and role reads never claim empty authoritative rosters',async()=>{
 await mount('Transitions',()=>({success:false,error:'Rules unavailable'}));assert.doesNotMatch(text(),/No transitions are controlled yet/);assert.match(text(),/Rules are unavailable/);
 await act(()=>root.unmount());container.remove();root=null;
 await mount('Roles',()=>({success:false,error:'Roles unavailable'}));assert.doesNotMatch(text(),/Nobody is eligible to sign yet/);assert.match(text(),/Eligibility is unavailable/);
});

// ── Settings controls must reach their runtime consumer ──────────────────────
const liveConfig=()=>({success:true,revision:'rev-1',config:{
 enabled:true,
 ai:{enabled:true,maxCompletionTokens:4096},
 restore:{actAs:'app',notifyUsers:false,perFieldRetries:2}}});
const labelled=t=>[...container.querySelectorAll('label')].find(l=>l.textContent.includes(t));

test('settings offers every preference that has a runtime consumer',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():{success:true,statuses:[]});
 for(const control of ['Change detection','Write restored values as','Notify watchers','Retries per field']){
  assert.ok(text().includes(control),`${control} is missing from the settings page`);
 }
});

test('settings offers no control for a retired preference',async()=>{
 // reviewStatusIds had no reader; queueThreshold only relabelled queue rows.
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():{success:true,statuses:[]});
 await select(0,'1');
 assert.doesNotMatch(text(),/Review statuses|Queue threshold/);
 assert.equal([...container.querySelectorAll('option')].some(o=>o.value==='CRITICAL'),false);
});

test('turning capture off says what stops, including the drift hold',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():{success:true,statuses:[]});
 await act(()=>labelled('Capture baselines').querySelector('input').click());await flush();
 assert.match(text(),/controlled transitions are blocked and no changes are detected/);
 assert.match(text(),/Approval rules are not bypassed/);
});

test('restoration discloses that tree baselines ignore its settings',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():{success:true,statuses:[]});
 assert.match(text(),/A baseline with child work items is always restored by the app/);
});

test('settings sends each changed preference to the resolver unchanged',async()=>{
 let saved;
 await mount('Settings',(key,payload)=>{
  if(key==='admin:getConfig')return liveConfig();
  if(key==='admin:saveConfig'){saved=payload;return {success:true};}
  return {success:true,statuses:[]};
 });
 const actAs=[...container.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='user'));
 await act(()=>{actAs.value='user';actAs.dispatchEvent(new window.Event('change',{bubbles:true}));});
 await act(()=>labelled('Notify watchers').querySelector('input').click());
 await flush();
 await act(()=>button('Save').click());await flush();
 assert.deepEqual(saved.config.restore,{actAs:'user',notifyUsers:true});
 // Untouched preferences stay absent so the project keeps inheriting them.
 assert.equal(saved.config.ai,undefined);
 assert.equal(saved.config.enabled,undefined);
});

test('settings refuses to save a retries value the resolver would reject',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():{success:true,statuses:[]});
 const retries=container.querySelector('input[type=number][max="10"]');
 assert.ok(retries,'retries input is missing');
 await act(()=>typeInto(retries,'50'));await flush();
 assert.equal(button('Save').disabled,true);
});

test('the ledger reports new activity without redrawing the record being read',async()=>{
 let head=7;
 const entries=[{seq:7,occurredAt:Date.now(),actorName:'Harsha',eventType:'SIGNATURE_CONSUMED',title:'Signed',entryHash:'h'}];
 await mount('Ledger',key=>{
  if(key==='admin:ledgerHead')return {success:true,maxSeq:head};
  return {success:true,entries,counts:{SIGNATURE_CONSUMED:2},hasMore:false};
 });
 assert.doesNotMatch(text(),/new (event|activity)/i);
 head=9;
 await act(()=>document.dispatchEvent(new window.Event('visibilitychange')));await flush();
 assert.match(text(),/new (event|activity)/i,'new activity was never disclosed');
 // The displayed record must not have been replaced behind the reader's back.
 assert.match(text(),/Harsha/);
 assert.ok(button('Refresh'),'no way to pull the new activity in');
});

test('a failing freshness check never implies the ledger is up to date',async()=>{
 await mount('Ledger',key=>key==='admin:ledgerHead'
  ?{success:false,error:'head unavailable'}
  :{success:true,entries:[],counts:null,hasMore:false});
 await act(()=>document.dispatchEvent(new window.Event('visibilitychange')));await flush();
 assert.doesNotMatch(text(),/up to date/i);
});

// ── Two authorities in the console ──────────────────────────────────────────
const asJiraAdminOnly=key=>key==='admin:check'
 ?{success:true,isAdmin:false,isJiraAdmin:true,needsBootstrap:false}
 :{success:true,admins:[{accountId:'a',displayName:'Existing admin',state:'ACTIVE'}]};

test('a Jira administrator who is not a VAtlassian administrator lands on the roster',async()=>{
 await mount('AdminConsole',asJiraAdminOnly);
 assert.doesNotMatch(text(),/An existing VAtlassian administrator must grant access/);
 assert.match(text(),/administrator/i);
 // They must be able to appoint somebody, which is the whole point.
 assert.ok(container.querySelector('input,button'),'roster controls are missing');
});

test('a Jira administrator is told the controls are not theirs',async()=>{
 await mount('AdminConsole',asJiraAdminOnly);
 assert.match(text(),/cannot|not able|only.*VAtlassian|appoint/i);
});

test('a Jira administrator alone is not offered the control pages',async()=>{
 await act(()=>{container=document.createElement('div');document.body.append(container);root=createRoot(container);});
 globalThis.transport=(key,payload)=>key==='harness:logAction'?Promise.resolve({ok:true}):Promise.resolve(asJiraAdminOnly(key,payload));
 await act(()=>root.render(React.createElement(pages['AdminConsole'],{configure:true})));await flush();
 // Naming the control pages in prose is fine; offering them as navigation is
 // not, so this looks at the tabs rather than the page text.
 const tabs=[...container.querySelectorAll('.va-nav-tab')].map(t=>t.textContent);
 assert.deepEqual(tabs,[],`control pages were offered to a non-VAtlassian administrator: ${tabs.join(', ')}`);
});

test('somebody with neither authority is still refused',async()=>{
 await mount('AdminConsole',key=>key==='admin:check'
  ?{success:true,isAdmin:false,isJiraAdmin:false,needsBootstrap:false}
  :{success:true,admins:[]});
 assert.match(text(),/access required|must grant access/i);
});

const ledgerWith=counts=>key=>key==='admin:ledgerHead'
 ?{success:true,maxSeq:0}
 :{success:true,issue:{issueId:'10006',issueKey:'VJIRA-6',summary:'child tickets'},counts,entries:[],hasMore:false,signaturesSummary:[]};

test('the ledger counts reconcile with the total they report',async()=>{
 // VJIRA-6 as observed: 2 signatures against 7 recorded events. The five that
 // belong to no named category must be accounted for, not left as a silent
 // gap between the badges and the total.
 await mount('Ledger',ledgerWith({SIGNATURE_CONSUMED:2,BASELINE_CAPTURED:3,ITEM_FIRST_OBSERVED:1,SIGNATURE_CREATED:1}));
 assert.match(text(),/2 signatures/);
 assert.match(text(),/7 events recorded in total/);
 assert.match(text(),/5 other/,'the events outside the named categories are unaccounted for');
});

test('an approved change is shown, not only a rejected one',async()=>{
 await mount('Ledger',ledgerWith({CHANGE_APPROVED:2,CHANGE_REJECTED:1}));
 assert.match(text(),/2 approv/i,'approved changes are invisible while rejections are not');
 assert.match(text(),/1 reject/);
 assert.doesNotMatch(text(),/other/,'nothing should be left over when every event is named');
});

const vaultStatus=(over={})=>({success:true,projectId:1,
 vault:{storage:'OBJECT_STORE'},
 lockdown:{enabled:false,lockedAt:null,lockedSchemeId:null},
 appDelete:{grantedAt:1,refusedAt:null},
 scheme:{id:10000,name:'Default Permission Scheme'},schemeError:null,sharedWith:null,...over});

test('attachment protection is chosen per project, never for the site',async()=>{
 const asked=[];
 await mount('Settings',key=>{asked.push(key);return key==='admin:getConfig'?liveConfig():{success:true,statuses:[]};});
 assert.match(text(),/Attachment protection/);
 assert.match(text(),/set per project/);
 assert.equal(labelled('Only VAtlassian may delete attachments'),undefined,'no lockdown control at site scope');
 assert.equal(asked.includes('admin:getVaultStatus'),false);
});

test('turning the lockdown on warns about a shared scheme and sends only that change',async()=>{
 let saved;const sharing=[];
 await mount('Settings',(key,payload)=>{
  if(key==='admin:getConfig')return liveConfig();
  if(key==='admin:getVaultStatus'){sharing.push(payload.checkSharing);return vaultStatus(payload.checkSharing?{sharedWith:['SEC']}:{});}
  if(key==='admin:saveConfig'){saved=payload;return {success:true,note:'Attachment deletion is locked: 2 grants removed from the permission scheme.'};}
  return {success:true,statuses:[]};
 });
 await select(0,'1');
 assert.match(text(),/Approved files are copied to the Forge Object Store/);
 assert.match(text(),/Default Permission Scheme/);
 assert.doesNotMatch(text(),/loses the delete permissions/,'no warning before the switch is turned on');
 await act(()=>labelled('Only VAtlassian may delete attachments').querySelector('input').click());await flush();
 assert.match(text(),/loses the delete permissions/);
 await act(()=>button('Which projects share it?').click());await flush();
 assert.match(text(),/Shared with SEC/);
 await act(()=>button('Save').click());await flush();
 assert.deepEqual(saved.config,{vault:{lockAttachmentDeletion:true}});
 assert.match(text(),/2 grants removed/);
 assert.deepEqual(sharing.slice(0,2),[false,true]);
});

test('a lockdown applied earlier is disclosed even with the setting off',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():key==='admin:getVaultStatus'
  ?vaultStatus({lockdown:{enabled:false,lockedAt:1727000000000,lockedSchemeId:'10000'}}):{success:true,statuses:[]});
 await select(0,'1');
 assert.match(text(),/Delete permissions were removed on/);
 assert.match(text(),/stay removed until someone re-adds them/);
});

test('turning the lockdown off says removed grants are not put back',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?{...liveConfig(),config:{...liveConfig().config,vault:{lockAttachmentDeletion:true}}}
  :key==='admin:getVaultStatus'?vaultStatus({lockdown:{enabled:true,lockedAt:1727000000000,lockedSchemeId:'10000'}}):{success:true,statuses:[]});
 await select(0,'1');
 assert.match(text(),/Locked since/);
 await act(()=>labelled('Only VAtlassian may delete attachments').querySelector('input').click());await flush();
 assert.match(text(),/does not give the delete permissions back/);
});

test('an unreadable vault status is reported, not shown as unprotected',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig():key==='admin:getVaultStatus'?{success:false,error:'Vault storage down'}:{success:true,statuses:[]});
 await select(0,'1');
 assert.match(text(),/vault status could not be read: Vault storage down/);
});

test('attachment protection explains that files are copied to the Forge Object Store',async()=>{
 await mount('Settings',key=>key==='admin:getConfig'?liveConfig()
  :key==='admin:getVaultStatus'?vaultStatus()
  :{success:true,statuses:[]});
 await select(0,'1');
 assert.match(text(),/Approved files are copied to the Forge Object Store/);
});

test('a workflow finding names the transition it is about, and cleared findings can be shown',async()=>{
 const asked=[];
 await mount('Health',(key,payload)=>{
  if(key==='admin:listGateFindings'){asked.push(payload?.includeCleared);return {success:true,findings:[{findingKey:'k',type:'GATE_ABSENT',severity:'CRITICAL',
   projectName:'First project',issueTypeName:'Story',fromStatusName:'In Review',toStatusName:'Done',transitionId:'31',
   detail:'No validator.',firstSeenAt:1727000000000,lastSeenAt:1727000000000,clearedAt:null}]};}
  if(key==='admin:getAlertDestination')return {success:true,configured:true,undelivered:0,projectId:'1',issueTypeId:'10'};
  return {success:true,issueTypes:[]};
 });
 assert.match(text(),/Controlled transition has no signature validator/);
 assert.match(text(),/Story · In Review → Done · transition 31/);
 await act(()=>labelled('Include cleared findings').querySelector('input').click());await flush();
 assert.deepEqual(asked,[false,true]);
});

test('credentials say they cover authenticator apps and not biometric devices',async()=>{
 await mount('Credentials',()=>({success:true,grants:[],credentials:[{accountId:'a',displayName:'Pat',state:'LOCKED'}]}));
 assert.match(text(),/authenticator app codes only/);
 assert.match(text(),/Biometric device registrations are not listed here/);
 assert.match(text(),/Locked/);
 assert.doesNotMatch(text(),/PENDING_CONFIRM|LOCKED/);
});

test('a background refresh keeps the roles list and the Grant form usable, and only replaces the list on success',async()=>{
 let grants=[{elId:'a'.repeat(32),signerName:'First reviewer',role:'QA',issueTypeName:'All work item types',scope:'All projects',signerActive:true}];
 const later=defer();let reads=0;
 await mount('Roles',key=>key==='admin:listEligibility'?(++reads===1?{success:true,grants}:later.promise):{success:true,issueTypes:[]});
 await act(()=>window.dispatchEvent(new window.Event('focus')));await flush();
 assert.match(text(),/First reviewer/,'the list stays on screen while it refreshes');
 assert.doesNotMatch(text(),/Eligibility is unavailable/);
 assert.equal(button('Refresh roles').disabled,false,'nothing is locked by a background refresh');
 later.resolve({success:false,error:'Temporary failure'});await flush();
 assert.match(text(),/First reviewer/,'a failed background read keeps what was shown');
});
