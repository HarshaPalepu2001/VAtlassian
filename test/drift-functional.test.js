// modified for Task 5 compliance: recall routing fail-closed behavior

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { project } from '../src/lib/content.js';
import { createGate } from '../src/gate.js';
import { totpFixture } from './helpers/approval-fixture.js';

// Run real preparation, challenge/signature verification, application, capture,
// diff, restoration and validator. Replace only Jira and persistence boundaries.
const modules = {
  'db/configStore.js': ['controlledFields','projectConfig','gateActiveOutOf','gatedTransition','listGatedTransitions','declaredFieldRows','seedControlledFields','countControlledFields'],
  'db/baselineStore.js': ['activeBaseline','readAllValues','baselineForApproval','currentVersion','writeBaseline'],
  'db/itemStateStore.js': ['getReview','acquire','release','upsertBaselined'],
  'db/driftStore.js': ['driftForIssue','markDecided'],
  'db/restoreStore.js': ['startRestore','finishRestore','declareWrite'],
  'db/restoreTreeStore.js': ['claimRestoreAction','finishRestoreAction','recordReplacement','readReplacements','readRestoreActions'],
  'db/store.js': ['tryAppend','newId','throwing','isDuplicateKey'],
  'lib/reviewer.js': ['isEligible','assignReviewer'],
  'db/baselineTreeStore.js': ['readBaselineTree','beginTreeBaseline','writeTreeCapture','verifyTreeCapture','publishTreeBaseline','activeRootsForNode'],
  'db/treeDriftStore.js': ['replaceTreeDrift']
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({requestJira: (...a) => globalThis.vaFlow.request('user',...a)}),
        asApp: () => ({requestJira: (...a) => globalThis.vaFlow.request('app',...a)}) };` };
    const names = modules[url.slice(8)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaFlow.${n}(...a);`).join('\n') };
    return next(url, context);
  }
});
const { createApprovalUsecases } = await import('../src/usecases/approval.js');
const { prepareApproval, applyApproval } = await import('../src/usecases/drift.js');
const { writeCapturedBaseline } = await import('../src/lib/capture.js');

const clone = value => structuredClone(value);
const now = () => 1700000000000;
const doc = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'strong' }] }] }] });
function fixture() {
  const defs = [
    ['summary','TEXT','string'], ['description','ADF','string'], ['labels','MULTI','array'],
    ['assignee','SCALAR','user'], ['customfield_cascade','SCALAR','option-with-child'],
    ...Array.from({length: 100}, (_,i) => [`customfield_${i}`,'SCALAR','number'])
  ];
  const fields = defs.map(([id,kind]) => ({ field_id:id, field_name:id, field_kind:kind, store_values:true, writable:id !== 'customfield_cascade' }));
  const editmeta = Object.fromEntries(defs.map(([id,,type]) => [id,{schema:{type,...(id==='labels'?{items:'string'}:{})},operations:['set']} ]));
  const values = { summary:'v1 approved', description:doc('original rich text'), labels:[], assignee:null,
    customfield_cascade:{id:'1',child:{id:'2'}},
    ...Object.fromEntries(Array.from({length:100},(_,i)=>[`customfield_${i}`,i])) };
  const issue = { id:'10',key:'T-10',fields:{...clone(values),parent:null,project:{id:'1'},issuetype:{id:'1'},status:{id:'1'}} };
  const projected = project(values, fields);
  const baseline = { baseline_id:Buffer.alloc(16,1), issue_id:10, project_id:1, issue_type_id:'1', version:1,
    state:'ACTIVE',content_hash:projected.contentHash,field_digests:JSON.stringify(projected.digests),
    transition_id:'5',from_status_id:'1',to_status_id:'2',required_role:'reviewer',
    required_assurance:'ESIGNATURE',controlled_fields_hash:'c'.repeat(64),
    transition_at:now()-1000,approval_id:Buffer.alloc(16,2) };
  const f = {
    issue, fields, values, baselines:[baseline], saved:new Map([[1,clone(values)]]), rows:[], challenges:new Map(),
    review:{state:'DRIFTED',version:1,baseline_version:1,baseline_id:baseline.baseline_id,drift_count:1},
    drift:[{baseline_version:1,field_id:'summary',approval_id:null}], writes:[], audits:[], restores:[],
    transitionRequests:[], statusTransitions:[{id:'21',name:'In-Review',toStatusId:'1',hasScreen:false,isAvailable:true}],
    restoreActions:[], replacements:[],
    policy:{transition_id:'5',from_status_id:'1',to_status_id:'2',required_assurance:'ESIGNATURE',required_role:'reviewer',meaning:'Reviewed and approved',capture_baseline:true,block_on_drift:true},
    controlledFields:async()=>fields, projectConfig:async()=>({enabled:true,restore:{queue:false}}),
    gateActiveOutOf:async()=>({gated:true,...f.policy}), gatedTransition:async()=>f.policy, listGatedTransitions:async()=>[f.policy],
    isEligible:async()=>true, assignReviewer:async()=>({accountId:'trusted',displayName:'Reviewer'}),
    activeBaseline:async()=>f.baselines.at(-1), readAllValues:async(_id,v)=>clone(f.saved.get(v)),
    baselineForApproval:async(_id,id)=>f.baselines.find(b=>b.approval_id.equals(id)),
    currentVersion:async()=>f.baselines.at(-1).version,
    writeBaseline:async({baseline,raw})=>{
      if(f.captureFails)throw new Error('storage unavailable');
      f.baselines.at(-1).state='SUPERSEDED';
      const baselineId=Buffer.alloc(16,10+baseline.version);
      f.saved.set(baseline.version,clone(raw));f.baselines.push({...baseline,state:'ACTIVE',baseline_id:baselineId});
      return {baselineId};
    },
    getReview:async()=>({...f.review}),failNextAcquire:false,
    acquire:async({expectedVersion,state})=>{
      if(f.failNextAcquire){f.failNextAcquire=false;f.review={...f.review,version:f.review.version+1};return {acquired:false};}
      if(expectedVersion!==f.review.version)return {acquired:false};
      f.review={...f.review,state,version:expectedVersion+1};
      if(f.editAfterLock)f.issue.fields.summary='concurrent edit';
      return {acquired:true};
    },
    release:async({state,counters})=>{f.review={...f.review,state,version:f.review.version+1,drift_count:counters.driftCount};},
    upsertBaselined:async(a)=>{f.review={...f.review,state:'BASELINED',version:f.review.version+1,baseline_version:a.baselineVersion,baseline_id:a.baselineId,drift_count:0};},
    driftForIssue:async(_id,v)=>f.drift.filter(d=>d.baseline_version===v&&!d.approval_id),
    markDecided:async({baselineVersion,approvalId})=>{for(const d of f.drift)if(d.baseline_version===baselineVersion&&!d.approval_id)d.approval_id=approvalId;},
    startRestore:async(a)=>{f.restores.push({...a});return Buffer.alloc(16,7);},
    finishRestore:async(a)=>Object.assign(f.restores.at(-1),a),declareWrite:async()=>{},
    readRestoreActions:async()=>clone(f.restoreActions),
    claimRestoreAction:async(_restoreId,step,issueInfo={})=>{
      const existing=f.restoreActions.find(action=>action.stepKey===step.stepKey);
      if(existing?.state==='COMPLETE'||existing?.state==='RUNNING')return false;
      if(existing){Object.assign(existing,{state:'RUNNING',attempts:existing.attempts+1,...issueInfo});return true;}
      f.restoreActions.push({stepKey:step.stepKey,logicalNodeId:step.logicalNodeId,kind:step.kind,
        state:'RUNNING',attempts:1,...issueInfo});
      return true;
    },
    finishRestoreAction:async(_restoreId,stepKey,success,detail)=>{
      const action=f.restoreActions.find(row=>row.stepKey===stepKey&&row.state==='RUNNING');
      if(!action)return false;
      Object.assign(action,{state:success?'COMPLETE':'FAILED',detail});
      return true;
    },
    recordReplacement:async(_restoreId,logicalNodeId,oldIssueId,newIssueId,newIssueKey)=>{
      f.replacements.push({logicalNodeId,oldIssueId,newIssueId,newIssueKey});
    },
    readReplacements:async()=>clone(f.replacements),
    tryAppend:async(a)=>f.audits.push(a),
    readBaselineTree:async (...args)=>{
      assert.equal(args.length,1,'production must use the tree store row-decoding contract');
      return f.baselines.find(b=>b.baseline_id.equals(args[0]))?.tree ?? null;
    },
    replaceTreeDrift:async()=>{},
    beginTreeBaseline:async({baseline,resume})=>{
      if(resume)return {baselineId:resume.baseline_id,version:resume.version};
      const baselineId=Buffer.alloc(16,10+baseline.version);
      f.baselines.push({...baseline,baseline_id:baselineId,state:'CAPTURING'});
      return {baselineId,version:baseline.version};
    },
    writeTreeCapture:async({baselineId,treeHash,nodes,values})=>{
      if(f.captureFails)throw new Error('storage unavailable');
      const row=f.baselines.find(b=>b.baseline_id.equals(baselineId));
      const flatValues = {};
      for (const nodeVals of Object.values(values)) Object.assign(flatValues, nodeVals);
      f.saved.set(row.version,clone(flatValues));
      Object.assign(row,{
        tree_hash:treeHash,
        tree:{
          nodes:nodes.map(node=>({
            ...node,
            parentLogicalId:node.parentLogicalNodeId,
            digests:JSON.parse(node.fieldDigests)
          })),
          values:clone(values)
        }
      });
      return {baselineId,valueBytes:0};
    },
    verifyTreeCapture:async()=>true,
    publishTreeBaseline:async({baselineId,version})=>{
      for(const b of f.baselines){
        if(b.baseline_id.equals(baselineId))b.state='ACTIVE';
        else if(b.version<version&&b.state==='ACTIVE')b.state='SUPERSEDED';
      }
    },
    request:async(identity,url,options={})=>{
      const response=body=>({ok:true,status:200,json:async()=>clone(body)});
      if(String(url).includes('/mypermissions'))return response({permissions:{
        CREATE_ISSUES:{havePermission:true},EDIT_ISSUES:{havePermission:true},DELETE_ISSUES:{havePermission:true}
      }});
      if(String(url).includes('/editmeta'))return response({fields:editmeta});
      if(String(url).includes('/changelog'))return response({values:[],total:0,isLast:true});
      if(String(url).includes('/search/jql'))return response({issues:[],total:0,isLast:true});
      if(String(url).includes('/transitions')){
        if(options.method==='POST'){
          const transition=JSON.parse(options.body).transition;
          const route=f.statusTransitions.find(item=>String(item.id)===String(transition.id));
          if(!route)return {ok:false,status:400,json:async()=>({})};
          f.issue.fields.status.id=route.toStatusId;
          return response({});
        }
        return response({transitions:f.statusTransitions.map(item=>({...item,to:{id:item.toStatusId,name:item.name}}))});
      }
      if(options.method==='PUT'){
        const writes=JSON.parse(options.body).fields;f.writes.push(writes);
        for(const [id,value] of Object.entries(writes))if(id!==f.dropWrite)f.issue.fields[id]=clone(value);
        return response({});
      }
      return response(f.issue);
    }
  };
  globalThis.vaFlow=f;
  const describe=()=>({...f.issue,issueId:10,issueKey:'T-10',projectId:1,issueTypeId:'1',statusId:f.issue.fields.status.id});
  const gate=createGate({now,log:()=>{},audit:async()=>{},eligible:async()=>true,
    load:async()=>{
      let ch = project(f.issue.fields,fields).contentHash;
      if (f.policy.capture_baseline) {
        const { planTreeCapture } = await import('../src/lib/tree/capturePlan.js');
        const treePlan = planTreeCapture({ rootIssueId: 10, nodes: [ { id: 10, key: 'T-10', fields: clone(f.issue.fields) } ], controlledFields: fields });
        ch = treePlan.treeHash;
      }
      return {issueId:10,projectId:1,issueTypeId:'1',ct:f.policy,item:f.review,
        contentHash: ch, driftCount:f.drift.filter(d=>!d.approval_id).length};
    },
    policyForApproval:async({approval})=>{
      const owned=f.baselines.find(b=>b.version===Number(approval.baseline_version));
      return owned?{transition_id:owned.transition_id,from_status_id:owned.from_status_id,to_status_id:owned.to_status_id,
        required_role:owned.required_role,required_assurance:owned.required_assurance,
        meaning:`Approve changes against baseline v${owned.version}`,capture_baseline:true,block_on_drift:true}:null;
    },
    pending:async()=>f.rows.find(r=>r.state==='PENDING'),
    consume:async({approvalId})=>{const r=f.rows.find(r=>r.approval_id.equals(approvalId));if(r.state!=='PENDING')return {consumed:false};r.state='CONSUMED';return {consumed:true};},voidOthers:async()=>{}});
  f.gate=()=>gate({issue:{key:'T-10'},transition:{id:'5',from:{id:'1'},to:{id:'2'}}});
  const deps={now,issue:async()=>describe(),actor:async accountId=>({accountId,displayName:'Reviewer'}),
    edge:async()=>f.policy,eligible:async()=>true,transition:async(_issue,payload)=>{
      f.transitionRequests.push({...payload});
      return String(payload.transitionId)==='5'?{id:'5',toStatusId:'2'}:null;
    },
    prepare:prepareApproval,apply:applyApproval,totpDeps:totpFixture(now),
    record:async r=>f.rows.push(r),audit:async a=>f.audits.push(a),
    activate:async({approvalId,state})=>{f.rows.find(r=>r.approval_id.equals(approvalId)).state=state;return true;},
    invalidate:async({approvalId})=>{const row=f.rows.find(r=>r.approval_id.equals(approvalId));if(row?.state==='PENDING')row.state='VOID';return row?.state==='VOID';},
    byId:async id=>f.rows.find(r=>r.approval_id.equals(id)),
    performTransition:async()=>{const result=await f.gate();if(result.result)f.issue.fields.status.id='2';return {transitioned:result.result,transitionError:result.errorMessage};},
    writeChallenge:async row=>{const id=Buffer.alloc(16,f.challenges.size+1);f.challenges.set(id.toString('hex'),{...row,challenge_id:id});return id;},
    getChallenge:async id=>f.challenges.get(id.toString('hex')),
    markChallengeConsumed:async id=>{const row=f.challenges.get(id.toString('hex'));if(row.state!=='PENDING')return false;row.state='CONSUMED';return true;}
  };
  f.api=createApprovalUsecases(deps);
  f.args={context:{accountId:'trusted'},payload:{issueKey:'T-10',transitionId:'5',intent:'DRIFT',decision:'APPROVE',confirmed:true,code:'007787'}};
  f.sign=async(extra={})=>{
    const args={...f.args,payload:{...f.args.payload,...extra}};
    const c=await f.api.challenge(args);assert.equal(c.success,true,JSON.stringify(c));
    return f.api.submit({...args,payload:{...args.payload,challengeId:c.challengeId}});
  };
  f.issue.fields.summary='reviewed drift';
  return f;
}

test('aggregate tree evidence accepts the verified hash and rejects a stale hash', async () => {
  const f = fixture();
  const issue = { ...f.issue, id: '10' };
  const actor = { accountId: 'trusted' };
  const transition = { id: '5', toStatusId: '2' };
  const prepared = await prepareApproval({ issue, actor, decision: 'APPROVE', transition });

  const verified = await prepareApproval({
    issue, actor, decision: 'APPROVE', transition,
    expectedEvidenceHash: prepared.treeHash
  });
  assert.equal(verified.treeHash, prepared.treeHash);

  f.issue.fields.summary = 'changed after aggregate review';
  await assert.rejects(() => prepareApproval({
    issue, actor, decision: 'APPROVE', transition,
    expectedEvidenceHash: prepared.treeHash
  }), error => error.reason === 'STALE_EVIDENCE');
});

for(const surface of ['panel','my approvals','Jira transition']){
  test(`${surface}: signed drift creates v2, clears review, and the real validator allows the transition`,async()=>{
    const f=fixture();const candidate=clone(f.issue.fields);
    const result=await f.sign({preauthorize:surface==='Jira transition'});
    assert.equal(result.success,true,JSON.stringify(result));
    assert.equal(f.baselines.at(-1).version,2);assert.equal(f.review.state,'BASELINED');
    assert.equal(f.saved.get(2).summary,candidate.summary);assert.deepEqual(f.saved.get(1),f.values);
    assert.equal(f.drift.filter(d=>!d.approval_id).length,0);
    if(surface==='Jira transition')assert.equal((await f.gate()).result,true);
    else assert.equal(result.transitioned,true,JSON.stringify(result));
    assert.equal(f.rows[0].state,'CONSUMED');assert.equal((await f.gate()).result,false);
  });
}
test('editing current policy cannot replace the baseline role, provider, meaning, or exact transition',async()=>{
  const f=fixture();
  const checkedRoles=[];
  f.isEligible=async({role})=>{checkedRoles.push(role);return role==='reviewer';};
  f.policy={...f.policy,transition_id:'999',to_status_id:'999',required_role:'attacker',
    required_assurance:'BIOMETRIC',meaning:'Changed after capture'};

  const result=await f.sign({transitionId:'999',requiredRole:'attacker',requiredAssurance:'BIOMETRIC'});

  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.transitioned,true,JSON.stringify(result));
  assert.deepEqual(f.transitionRequests,[{transitionId:'5'},{transitionId:'5'}]);
  assert.ok(checkedRoles.length>0);
  assert.deepEqual(new Set(checkedRoles),new Set(['reviewer']));
  assert.equal(f.rows[0].transition_id,'5');
  assert.equal(f.rows[0].signer_role,'reviewer');
  assert.equal(f.rows[0].assurance_level,'ESIGNATURE');
  assert.equal(f.rows[0].meaning,'Approve changes against baseline v1');
});
test('rejection restores all 105 changed fields including rich text, empty values and an off-screen cascade',async()=>{
  const f=fixture();f.issue.fields.description=doc('changed');f.issue.fields.labels=['new'];f.issue.fields.assignee={accountId:'other'};
  f.issue.fields.customfield_cascade={id:'1',child:{id:'3'}};
  for(let i=0;i<100;i++)f.issue.fields[`customfield_${i}`]=i+100;
  const result=await f.sign({decision:'REJECT'});
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.restore.state,'COMPLETE',JSON.stringify(result.restore.detail.filter(d=>!d.verified)));
  assert.equal(result.restore.counters.succeeded,105);assert.equal(f.baselines.length,1);
  for(const [id,value] of Object.entries(f.values))assert.deepEqual(f.issue.fields[id],value,id);
  assert.equal(f.review.state,'BASELINED');assert.equal(f.rows[0].decision,'REJECT');assert.equal(f.rows[0].state,'CONSUMED');
});
test('rejection can be challenged while drift leaves the root outside review',async()=>{
  const f=fixture();
  f.issue.fields.status.id='2';
  f.issue.fields.summary='must not be restored outside review';
  const args={...f.args,payload:{...f.args.payload,decision:'REJECT',transitionId:undefined}};
  const result=await f.api.challenge(args);
  assert.equal(result.success,true,JSON.stringify(result));
  
  assert.equal(f.writes.length,0);
  assert.equal(f.restores.length,0);
  assert.equal(f.drift[0].approval_id,null);
});
test('a field Jira silently drops leaves restoration incomplete and the validator closed',async()=>{
  const f=fixture();f.issue.fields.labels=['new'];f.dropWrite='labels';
  const result=await f.sign({decision:'REJECT'});
  assert.equal(result.restore.state,'PARTIAL');assert.equal(result.restore.success,false);
  assert.equal(f.review.state,'ERROR');assert.equal(f.drift[0].approval_id,null);assert.equal((await f.gate()).result,false);
});
test('a partial rejection can resume after a legacy DECIDING lock',async()=>{
  const f=fixture();f.issue.fields.labels=['new'];f.dropWrite='labels';
  const first=await f.sign({decision:'REJECT'});
  assert.equal(first.restore.state,'PARTIAL');
  const approval=f.rows[0];
  f.dropWrite=undefined;
  f.review={...f.review,state:'DECIDING'};
  f.failNextAcquire=true;
  const resumed=await applyApproval({issue:{...f.issue,id:'10'},actor:{accountId:'trusted'},approval,prepared:{},resuming:true});
  assert.equal(resumed.success,true,JSON.stringify(resumed));
  assert.equal(resumed.state,'COMPLETE');
  assert.equal(f.review.state,'BASELINED');
  assert.deepEqual(f.issue.fields.labels,f.values.labels);
});
test('an edit after acquiring the decision lock cannot become the new baseline',async()=>{
  const f=fixture();f.editAfterLock=true;const result=await f.sign();
  assert.equal(result.success,false);assert.equal(f.baselines.length,1);assert.equal(f.rows[0].state,'VOID');
});
test('failed baseline storage cannot activate a transition capability',async()=>{
  const f=fixture();f.captureFails=true;const result=await f.sign();
  assert.equal(result.success,false);
  assert.equal(f.baselines.filter(b=>b.state==='ACTIVE').length,1);
  assert.equal(f.baselines.at(-1).state,'CAPTURING');
  assert.equal(f.rows[0].state,'VOID');assert.equal((await f.gate()).result,false);
});
test('a delayed duplicate capture cannot erase new drift after v2',async()=>{
  const f=fixture();await f.sign();const row=f.rows[0];
  f.issue.fields.summary='new unreviewed edit';f.review.state='DRIFTED';
  const result=await writeCapturedBaseline({issueId:10,issueKey:'T-10',projectId:1,issueTypeId:'1',controlledFields:f.fields,
    issueFields:f.issue.fields,transitionAt:now(),capturedAt:now(),approver:{approvalId:row.approval_id,assuranceLevel:row.assurance_level,contentHash:row.content_hash}});
  assert.equal(result.alreadyCaptured,true);assert.equal(f.baselines.length,2);assert.equal(f.review.state,'DRIFTED');
  assert.equal(f.saved.get(2).summary,'reviewed drift');
});

test('after v2 approval, rejection restores v2 values and preserves v1 history',async()=>{
  const f=fixture();await f.sign();
  // Baseline recall owns the status change; recursive restoration must verify
  // that its caller has already returned the root to the review status.
  f.issue.fields.status.id='1';
  f.issue.fields.summary='unreviewed after v2';f.review.state='DRIFTED';
  f.drift.push({baseline_version:2,field_id:'summary',approval_id:null});
  const result=await f.sign({decision:'REJECT'});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.restore.state,'COMPLETE',JSON.stringify(result.restore));assert.equal(f.baselines.length,2);
  assert.equal(f.issue.fields.summary,'reviewed drift');assert.equal(f.saved.get(1).summary,'v1 approved');
  assert.equal(f.saved.get(2).summary,'reviewed drift');assert.equal(f.review.baseline_version,2);
});
test('baseline-owned drift approval retains its immutable policy for the next rejection',async()=>{
  const f=fixture();
  // A reviewed item may be drifted in a status with no outgoing approval edge.
  f.gatedTransition=async({fromStatusId,toStatusId})=>fromStatusId==='1'&&toStatusId==='2'?f.policy:null;
  const approved=await f.sign({transitionId:undefined});
  assert.equal(approved.success,true,JSON.stringify(approved));assert.equal(f.baselines.at(-1).version,2);
  f.issue.fields.status.id='1';
  f.issue.fields.summary='later drift';f.review.state='DRIFTED';
  const rejected=await f.sign({decision:'REJECT',transitionId:undefined});
  assert.equal(rejected.success,true,JSON.stringify(rejected));
  assert.equal(rejected.restore.state,'COMPLETE');assert.equal(f.issue.fields.summary,'reviewed drift');
});
test('approval preparation preserves a pending transition against its unchanged tree baseline',async()=>{
  const f=fixture();await f.sign({preauthorize:true});
  const active=f.baselines.at(-1);
  const prepared=await prepareApproval({
    issue:{...f.issue,id:'10'},actor:{accountId:'trusted'},decision:'APPROVE',
    transition:{id:'5',toStatusId:'2'},expectedEvidenceHash:active.tree_hash
  });
  assert.equal(prepared.treeHash,active.tree_hash);
  assert.equal(f.rows[0].state,'PENDING');
  assert.equal(f.baselines.length,2);
});
test('a pending baseline-owned transition requires a fresh signature instead of retry reuse',async()=>{
  const f=fixture();const approved=await f.sign({preauthorize:true});
  const result=await f.api.retryTransition({context:f.args.context,payload:{issueKey:'T-10',approvalId:approved.approvalId}});
  assert.equal(result.success,false,JSON.stringify(result));assert.equal(result.reason,'NO_DECISION');
  assert.equal(f.rows.length,1);assert.equal(f.baselines.length,2);
});
test('rejection from Done recalls the item to review before restoring the baseline',async()=>{
  const f=fixture();
  f.issue.fields.status.id='2';
  f.issue.fields.summary='content changed after approval';
  const result=await f.sign({decision:'REJECT',transitionId:undefined});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.issue.fields.status.id,'1');
  assert.equal(f.issue.fields.summary,'v1 approved');
  assert.equal(result.restore.state,'COMPLETE',JSON.stringify(result.restore));
});
