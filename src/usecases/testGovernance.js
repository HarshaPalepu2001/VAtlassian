import crypto from 'node:crypto';
import { executionCandidateProof } from '../testmgmt/executionCandidate.js';
import { validateIntakeReceipt, preparedIntakeDigest } from '../testmgmt/intake.js';
import { contentDigest, runSteps } from '../testmgmt/content.js';
import { runResult } from '../testmgmt/results.js';
import { chainDigest, chainPosition, chainPreflight, separationProblem, validateChain } from '../testmgmt/chain.js';
import { inspectRunProof, proofOkay } from '../testmgmt/coverage.js';
import { sourceBaseline } from '../testmgmt/sources.js';
import { actorFrom } from './access.js';
import { tmRespond } from '../testmgmt/messages.js';
import { HISTORICAL_METADATA, governanceFail as fail, governanceChainDominates, governanceRecordProof,
  mandatoryRunScope, missingHistoricalMetadata, sameGovernanceValue as same, validAuditProof } from '../testmgmt/governance.js';

const newId = () => crypto.randomBytes(16).toString('hex');
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const buildValid = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 &&
  Object.keys(value).length <= 20 && Object.entries(value).every(([key,val])=>text(key,80) && ['string','number','boolean'].includes(typeof val) && String(val).length <= 2048) && JSON.stringify(value).length <= 8000;
const find = (findings, code, scope = {}) => findings.push({code,...scope});
const actualOutcome = (run,version) => runResult([{steps:runSteps(run.resolvedSteps??version?.content?.steps,run.steps).map(step=>step.status)}]);

/** Governing records are separate immutable subjects; no source or run content is rewritten. */
export function createTestGovernance(deps) {
  async function sourceContext(issueKey, actor, { requireReady = false, edit = false } = {}) {
    if (!actor?.accountId || !text(String(issueKey ?? ''),255)) fail('INVALID_INPUT');
    const issue = await (deps.getFullIssueAsUser??deps.readIssueAsUser)(String(issueKey), actor);
    const projectId = String(issue?.fields?.project?.id ?? ''), issueTypeId = String(issue?.fields?.issuetype?.id ?? '');
    const project = await deps.readProject(projectId);
    if (!issue?.id || !project?.enabled || !issueTypeId || [project.testTypeId,project.executionTypeId,project.planTypeId,project.setTypeId,project.preconditionTypeId].filter(Boolean).map(String).includes(issueTypeId)) fail('NOT_A_SOURCE');
    if (edit && !await deps.hasIssuePermission(issue.id,'EDIT_ISSUES')) fail('NO_EDIT_PERMISSION');
    const source = await deps.getSourceState(issue,{viewer:actor});
    if (source?.complete !== true || !/^[a-f0-9]{64}$/.test(source.sourceDigest??'')) fail('SOURCE_UNAVAILABLE');
    const frozen = { issueId:String(issue.id),issueKey:issue.key,projectId,issueTypeId,baseline:sourceBaseline(source.baseline),sourceDigest:source.sourceDigest };
    if (requireReady && (!frozen.baseline || source.governedReady !== true || source.drifted !== false)) fail('SOURCE_DRIFT');
    return {issue,project,projectId,issueTypeId,source:{...source,...frozen}};
  }
  async function head(c, kind) { return deps.readGovernanceHead({sourceIssueId:String(c.issue.id),kind}); }
  async function signaturesOf(record) { return deps.listSignatures(record.kind, record.recordId); }
  async function proof(record) { return !!record && governanceRecordProof(record,await signaturesOf(record)); }
  function current(record,c) { return record.content.source.issueId===String(c.issue.id) && record.projectId===c.projectId && record.content.source.issueTypeId===c.issueTypeId &&
    c.source.governedReady===true && c.source.drifted===false && same(record.content.source.baseline,c.source.baseline) && record.content.source.sourceDigest===c.source.sourceDigest; }
  async function approved(c, kind, recordId = null) {
    const active=await head(c,kind);
    if (!active || recordId && active.recordId!==recordId || !await proof(active)) fail(`${kind}_REQUIRED`);
    if (!current(active,c)) fail('ASSIGNMENT_STALE');
    return active;
  }
  function projectChain(c,kind) { const chain=validateChain(c.project[{ASSIGNMENT:'assignmentChain',TARGET:'targetChain',EXCEPTION:'exceptionChain'}[kind]]).chain;if(!chain)fail('INVALID_CHAIN');return chain; }
  async function chainFor(c,kind) {
    const chain=projectChain(c,kind);
    const holders=await deps.roleHolders({projectId:c.projectId,issueTypeId:c.issueTypeId,roles:chain.steps.map(s=>s.role)});
    const preflight=chainPreflight(chain,holders);if(!preflight.ok)fail(preflight.reason);
    return chain;
  }
  async function describe(record,c,actor) {
    const signatures=await signaturesOf(record),position=chainPosition(record.chain,signatures);
    const pending=deps.hasPendingSignatures?await deps.hasPendingSignatures(record.kind,record.recordId):false;
    const confirmed=signatures.every(s=>s.state==='ACTIVE'&&s.contentHash===record.digest&&validAuditProof({seq:s.auditSeq,entryHash:s.auditHash}));
    // Include SIGNED records whose head publication is still outstanding so the
    // UI can offer a recovery action instead of a dead end.
    const publicationOutstanding=record.state==='SIGNED'&&record.kind!=='EXCEPTION'&&(await head(c,record.kind))?.recordId!==record.recordId;
    const signable=record.state==='SIGNING'||(publicationOutstanding&&governanceRecordProof(record,signatures,{requireActivation:false}));
    let canSign=false;
    if (signable && current(record,c) && !pending && confirmed && position.next!=null && !position.corrupt &&
      !(record.content.authorSeparation&&record.createdBy===actor.accountId) && !separationProblem(record.chain,signatures,actor.accountId) && await deps.hasIssuePermission(c.issue.id,'EDIT_ISSUES')) {
      canSign=await deps.isEligibleFor({accountId:actor.accountId,projectId:c.projectId,issueTypeId:c.issueTypeId,role:position.step.role});
    }
    return {...record,signatures,nextStep:position.next!=null?{index:position.next,...position.step}:null,canSign,
      canFinish:(record.state==='SIGNING'||publicationOutstanding)&&governanceRecordProof(record,signatures,{requireActivation:false}),proofConfirmed:governanceRecordProof(record,signatures),stale:!current(record,c)};
  }
  async function prepare(c,kind,fields,rationale,actor) {
    if(!text(rationale))fail('REASON_REQUIRED');
    const chain=await chainFor(c,kind),previous=kind==='EXCEPTION'?null:await head(c,kind);
    const content={schema:1,kind,source:c.source,chainDigest:chainDigest(chain),authorSeparation:c.project.governanceAuthorSeparation!==false,previousId:previous?.recordId??null,
      rationale:rationale.trim(),...fields};
    const record={recordId:newId(),sourceIssueId:String(c.issue.id),projectId:c.projectId,kind,content,digest:contentDigest(content),chain,chainDigest:content.chainDigest,state:'SIGNING',createdBy:actor.accountId,createdAt:deps.now(),signedAt:null,activationProof:null};
    if(!await deps.insertGovernanceRecord(record))fail('STALE');
    return describe(record,c,actor);
  }
  async function prepareAssignment(payload,actor) {
    const c=await sourceContext(payload.issueKey,actor,{requireReady:true,edit:true});
    if(payload.buildPolicy?.mode!=='EXACT'||!Array.isArray(payload.obligations)||!payload.obligations.length||payload.obligations.length>100)fail('INVALID_INPUT');
    const obligations=[],ids=new Set();let combinations=0;
    for(const input of payload.obligations){
      if(!text(input.id,100)||ids.has(input.id)||!text(input.level,64)||!text(input.method,64)||!Array.isArray(input.tests)||!input.tests.length||input.tests.length>100)fail('INVALID_INPUT');ids.add(input.id);
      const tests=[],seen=new Set();
      for(const pin of input.tests){
        const version=await deps.readVersion(pin.testVersionId);if(!version||seen.has(version.versionId)||version.state!=='SIGNED'||String(version.projectId)!==c.projectId||contentDigest(version.content)!==version.digest||!proofOkay(await deps.verifyVersionProof(version)))fail('TEST_VERSION_UNVERIFIABLE');
        seen.add(version.versionId);const testIssue=await deps.readIssueAsUser(version.testIssueId,actor);
        if(String(testIssue?.id)!==String(version.testIssueId)||String(testIssue.fields?.project?.id)!==c.projectId||String(testIssue.fields?.issuetype?.id)!==String(c.project.testTypeId))fail('NOT_A_TEST');
        const ref=(version.content.verifies??[]).find(s=>String(s.issueId)===String(c.issue.id));
        if(!ref||ref.sourceDigest!==c.source.sourceDigest||!same(sourceBaseline(ref.baseline),c.source.baseline)||String(ref.projectId)!==c.projectId)fail('TEST_SOURCE_STALE');
        if(!Array.isArray(pin.contexts)||!pin.contexts.length||pin.contexts.length>100)fail('INVALID_INPUT');
        const contexts=[],keys=new Set();
        for(const context of pin.contexts){
          if(typeof(context.configuration??'')!=='string'||typeof(context.environment??'')!=='string'||String(context.configuration??'').length>255||String(context.environment??'').length>255||context.release!=null&&(!text(String(context.release.id),64)||!/^\d+$/.test(String(context.release.id))))fail('INVALID_INPUT');
          const normalized={configuration:context.configuration??'',environment:context.environment??'',release:context.release==null?null:{id:String(context.release.id),name:String(context.release.name??'').slice(0,255)}};
          const key=contentDigest(normalized);if(keys.has(key))fail('INVALID_INPUT');keys.add(key);contexts.push(normalized);if(++combinations>1000)fail('TOO_MANY_COMBINATIONS');
        }
        tests.push({testVersionId:version.versionId,testIssueId:String(version.testIssueId),testDigest:version.digest,contexts});
      }
      obligations.push({id:input.id,level:input.level,method:input.method,tests});
    }
    return prepare(c,'ASSIGNMENT',{obligations,buildPolicy:{mode:'EXACT'}},payload.rationale,actor);
  }
  async function execution(c,key,actor){
    const issue=await deps.readIssueAsUser(String(key),actor);
    if(!issue?.id||String(issue.fields?.project?.id)!==c.projectId||String(issue.fields?.issuetype?.id)!==String(c.project.executionTypeId))fail('INVALID_EXECUTION');
    return issue;
  }
  async function prepareTarget(payload,actor){
    const c=await sourceContext(payload.issueKey,actor,{requireReady:true,edit:true}),assignment=await approved(c,'ASSIGNMENT',payload.assignmentId);
    const candidate=await execution(c,payload.executionIssueId??payload.executionIssueKey,actor);if(!buildValid(payload.reportedBuild))fail('BUILD_IDENTITY_REQUIRED');
    if (!deps.claimExecutionCandidate) fail('CANDIDATE_PENDING');
    await deps.claimExecutionCandidate({executionIssueId:String(candidate.id),projectId:c.projectId,reportedBuild:payload.reportedBuild,actorAccountId:actor.accountId});
    return prepare(c,'TARGET',{assignmentId:assignment.recordId,assignmentDigest:assignment.digest,executionIssueId:String(candidate.id),executionIssueKey:candidate.key,reportedBuild:payload.reportedBuild},payload.rationale,actor);
  }
  function exceptionFloor(c,chain,assignment,target){
    return [assignment.chain,target.chain,projectChain(c,'ASSIGNMENT'),projectChain(c,'TARGET')].every(required=>governanceChainDominates(chain,required)) &&
      (!(assignment.content.authorSeparation||target.content.authorSeparation||c.project.governanceAuthorSeparation!==false)||c.project.governanceAuthorSeparation!==false);
  }
  async function exceptionInputs(c,payload,actor){
    const assignment=await approved(c,'ASSIGNMENT',payload.assignmentId),target=await approved(c,'TARGET',payload.targetId);
    if(target.content.assignmentId!==assignment.recordId||target.content.assignmentDigest!==assignment.digest)fail('TARGET_STALE');
    const run=await deps.readRun(payload.runId);if(!run||String(run.projectId)!==c.projectId||run.executionIssueId!==target.content.executionIssueId||run.frozenDigest!==payload.evidenceDigest||run.state!=='SIGNED'||run.result!=='PASSED')fail('EXCEPTION_NOT_PERMITTED');
    await execution(c,run.executionIssueId,actor);await deps.readIssueAsUser(run.testIssueId,actor);
    const fields=payload.missingMetadata;
    if(!Array.isArray(fields)||!fields.length||new Set(fields).size!==fields.length||fields.some(name=>!HISTORICAL_METADATA.includes(name)||!missingHistoricalMetadata(run,name)))fail('EXCEPTION_NOT_PERMITTED');
    const version=await deps.readVersion(run.testVersionId);
    if(actualOutcome(run,version)!=='PASSED')fail('EXCEPTION_NOT_PERMITTED');
    if((await inspectRunProof(run,version,deps,actor)).length)fail('EXCEPTION_NOT_PERMITTED');
    if(run.reportedBuild!=null&&!same(run.reportedBuild,target.content.reportedBuild))fail('BUILD_MISMATCH');
    return {assignment,target,run};
  }
  async function prepareException(payload,actor){
    const c=await sourceContext(payload.issueKey,actor,{requireReady:true,edit:true}),inputs=await exceptionInputs(c,payload,actor);
    const chain=await chainFor(c,'EXCEPTION');if(!exceptionFloor(c,chain,inputs.assignment,inputs.target))fail('EXCEPTION_CHAIN_TOO_WEAK');
    return prepare(c,'EXCEPTION',{assignmentId:inputs.assignment.recordId,assignmentDigest:inputs.assignment.digest,targetId:inputs.target.recordId,targetDigest:inputs.target.digest,runId:inputs.run.runId,evidenceDigest:inputs.run.frozenDigest,missingMetadata:[...payload.missingMetadata].sort()},payload.rationale,actor);
  }
  async function activeInputs(record,c,actor){
    if(!current(record,c))fail('ASSIGNMENT_STALE');
    if(record.kind==='ASSIGNMENT')for(const obligation of record.content.obligations)for(const test of obligation.tests){
      const version=await deps.readVersion(test.testVersionId);
      if(!version||version.state!=='SIGNED'||version.digest!==test.testDigest||contentDigest(version.content)!==test.testDigest||!proofOkay(await deps.verifyVersionProof(version)))fail('TEST_VERSION_UNVERIFIABLE');
      await deps.readIssueAsUser(test.testIssueId,actor);
      const ref=(version.content.verifies??[]).find(ref=>String(ref.issueId)===String(c.issue.id));
      if(!ref||ref.sourceDigest!==c.source.sourceDigest||!same(sourceBaseline(ref.baseline),c.source.baseline))fail('TEST_SOURCE_STALE');
    }
    if(record.kind==='TARGET'){
      const assignment=await approved(c,'ASSIGNMENT',record.content.assignmentId);if(assignment.digest!==record.content.assignmentDigest)fail('TARGET_STALE');await execution(c,record.content.executionIssueId,actor);
      if(!deps.readExecutionCandidate||!executionCandidateProof(await deps.readExecutionCandidate(record.content.executionIssueId),{executionIssueId:record.content.executionIssueId,projectId:c.projectId,reportedBuild:record.content.reportedBuild}))fail('CANDIDATE_PENDING');
    }
    if(record.kind==='EXCEPTION'){
      const inputs=await exceptionInputs(c,record.content,actor);if(inputs.assignment.digest!==record.content.assignmentDigest||inputs.target.digest!==record.content.targetDigest)fail('TARGET_STALE');
      if(!exceptionFloor(c,record.chain,inputs.assignment,inputs.target))fail('EXCEPTION_CHAIN_TOO_WEAK');
    }
  }
  async function signRecord({recordId,contentHash,code},actor){
    let record=await deps.readGovernanceRecord(recordId);if(!record||contentDigest(record.content)!==record.digest||record.digest!==contentHash||chainDigest(record.chain)!==record.chainDigest)fail('CONTENT_CHANGED');
    const c=await sourceContext(record.sourceIssueId,actor,{requireReady:true,edit:true});await activeInputs(record,c,actor);
    if(record.state==='SIGNED'&&(record.kind==='EXCEPTION'||(await head(c,record.kind))?.recordId===recordId))return describe(record,c,actor);
    if(!['SIGNING','SIGNED'].includes(record.state))fail('STALE');
    if(record.content.authorSeparation&&record.createdBy===actor.accountId)fail('AUTHOR_CANNOT_SIGN');
    if(deps.recoverSignatures)await deps.recoverSignatures(record.kind,recordId,deps.now());
    if(deps.hasPendingSignatures&&await deps.hasPendingSignatures(record.kind,recordId))fail('SIGNATURE_PENDING');
    let signatures=await signaturesOf(record);if(signatures.some(s=>s.state!=='ACTIVE'||s.contentHash!==record.digest||!validAuditProof({seq:s.auditSeq,entryHash:s.auditHash})))fail('SIGNATURE_PENDING');
    const position=chainPosition(record.chain,signatures);if(position.corrupt||position.rejected)fail('CONTENT_CHANGED');
    if(!position.complete){
      if(separationProblem(record.chain,signatures,actor.accountId))fail('SAME_SIGNER');
      if(!await deps.isEligibleFor({accountId:actor.accountId,projectId:c.projectId,issueTypeId:c.issueTypeId,role:position.step.role}))fail('NOT_ELIGIBLE');
      const me=await deps.myself();const recorded=await deps.recordSignature({kind:record.kind,subjectId:recordId,stepIndex:position.next,step:position.step,
        signer:{accountId:actor.accountId,displayName:me?.displayName??actor.accountId},decision:'SIGN',reason:record.content.rationale,contentHash:record.digest,code,issueId:c.issue.id,
        payload:{recordId,kind:record.kind,source:record.content.source,assignmentId:record.content.assignmentId??null}},deps);
      if(!recorded.ok)return {error:recorded.message??recorded.reason,reason:recorded.reason};signatures=await signaturesOf(record);
    }
    if(governanceRecordProof(record,signatures,{requireActivation:false})){
      // Retries use the same ledger event identity, including after audit/SQL partial failure.
      const activationProof=await deps.audit({eventId:Buffer.from(contentDigest({recordId,event:'ACTIVATE'}).slice(0,32),'hex'),eventType:'TM_GOVERNANCE_ACTIVATED',actorAccountId:actor.accountId,issueId:Number(c.issue.id),payload:{recordId,kind:record.kind,digest:record.digest,previousId:record.content.previousId}});
      if(!validAuditProof(activationProof))fail('LEDGER_UNAVAILABLE');
      const fresh=await sourceContext(record.sourceIssueId,actor,{requireReady:true,edit:true});await activeInputs(record,fresh,actor);
      if(!await deps.activateGovernanceRecord({recordId,expectedPreviousId:record.content.previousId,proof:activationProof,now:deps.now()}))fail('STALE');
      record=await deps.readGovernanceRecord(recordId);if(!await proof(record))fail('ACTIVATION_NOT_CONFIRMED');
    }
    return describe(record,c,actor);
  }
  async function view({issueKey},actor){
    const c=await sourceContext(issueKey,actor),history=await deps.readGovernanceRecordsComplete(c.issue.id),evaluations=await deps.readClosureEvaluationsComplete(c.issue.id);
    let complete=history.complete===true&&evaluations.complete===true;
    const visible=async record=>{
      if(record.kind==='ASSIGNMENT')for(const id of new Set(record.content.obligations.flatMap(o=>o.tests.map(t=>t.testIssueId))))await deps.readIssueAsUser(id,actor);
      if(record.kind==='TARGET')await execution(c,record.content.executionIssueId,actor);
      if(record.kind==='EXCEPTION'){const run=await deps.readRun(record.content.runId);if(!run)fail('NOT_FOUND');await deps.readIssueAsUser(run.testIssueId,actor);await execution(c,run.executionIssueId,actor);}
    };
    const records=[];for(const record of history.records??[]){
      if(record.sourceIssueId!==String(c.issue.id)||record.projectId!==c.projectId)fail('CONTENT_CHANGED');
      try{await visible(record);records.push(await describe(record,c,actor));}catch{complete=false;}
    }
    const a=await head(c,'ASSIGNMENT'),t=await head(c,'TARGET');
    const describeVisible=async record=>{if(!record)return null;try{await visible(record);return await describe(record,c,actor);}catch{complete=false;return null;}};
    const activeAssignment=await describeVisible(a),activeTarget=await describeVisible(t),frozen=[];
    for(const evaluation of evaluations.records??[])if(validAuditProof(evaluation.auditProof)&&contentDigest(evaluation.snapshot)===evaluation.digest){
      try{await dossierVisibility(evaluation,actor);frozen.push(evaluation);}catch{complete=false;}
    }
    const observed=deps.readObservedTransitionsComplete?await deps.readObservedTransitionsComplete(c.issue.id):{records:[],complete:true};
    if(observed.complete!==true)complete=false;
    return {issueId:String(c.issue.id),issueKey:c.issue.key,source:c.source,complete,records,activeAssignment,activeTarget,evaluations:frozen,observedTransitions:observed.records};
  }
  async function evaluate({issueKey,targetId=null},actor){
    const c=await sourceContext(issueKey,actor),findings=[],selectedAttempts=[];
    // Deduplicate frozen receipts: many machine attempts share the same receipt,
    // so store each receipt once in receiptIndex and reference it by ID.
    const receiptIndex={};
    let assignment=null,target=null,runsEnvelope=null,recordsEnvelope=null,executionCandidate=null;
    try{
      assignment=await head(c,'ASSIGNMENT');if(!await proof(assignment))find(findings,'ASSIGNMENT_REQUIRED');else if(!current(assignment,c))find(findings,'ASSIGNMENT_STALE');
      target=await head(c,'TARGET');if(!await proof(target))find(findings,'TARGET_REQUIRED');else if(targetId&&target.recordId!==targetId||!current(target,c)||target.content.assignmentId!==assignment?.recordId||target.content.assignmentDigest!==assignment?.digest)find(findings,'TARGET_STALE');
      if(assignment&&target){
        await execution(c,target.content.executionIssueId,actor);
        executionCandidate=deps.readExecutionCandidate?await deps.readExecutionCandidate(target.content.executionIssueId):null;
        if(!executionCandidateProof(executionCandidate,{executionIssueId:target.content.executionIssueId,projectId:c.projectId,reportedBuild:target.content.reportedBuild}))find(findings,'CANDIDATE_PENDING');
        runsEnvelope=await deps.readRunsForExecutionComplete(target.content.executionIssueId);if(runsEnvelope.complete!==true)find(findings,'RUN_HISTORY_INCOMPLETE');
        recordsEnvelope=await deps.readGovernanceRecordsComplete(c.issue.id);if(recordsEnvelope.complete!==true)find(findings,'GOVERNANCE_HISTORY_INCOMPLETE');
        const validExceptions=[];
        for(const record of recordsEnvelope.records??[]){
          if(record.kind!=='EXCEPTION'||record.content.assignmentId!==assignment.recordId||record.content.targetId!==target.recordId)continue;
          if(await proof(record)&&current(record,c)&&exceptionFloor(c,record.chain,assignment,target)&&record.content.assignmentDigest===assignment.digest&&record.content.targetDigest===target.digest)validExceptions.push({...record,signatures:await signaturesOf(record)});
        }
        const runs=runsEnvelope.records??[];
        if(runs.some(run=>String(run.executionIssueId)!==target.content.executionIssueId||String(run.projectId)!==c.projectId))find(findings,'RUN_HISTORY_INCONSISTENT');
        for(const obligation of assignment.content.obligations??[])for(const test of obligation.tests)for(const context of test.contexts){
          const scope={obligationId:obligation.id,testVersionId:test.testVersionId,context};
          const matching=runs.filter(run=>mandatoryRunScope(run,test,context));
          if(matching.some(run=>!Number.isSafeInteger(run.attemptSequence)||run.attemptSequence<1)||new Set(matching.map(run=>run.attemptSequence)).size!==matching.length){find(findings,'ATTEMPT_ORDER_UNAVAILABLE',scope);continue;}
          const run=matching.sort((a,b)=>b.attemptSequence-a.attemptSequence)[0];if(!run){find(findings,'MANDATORY_ATTEMPT_MISSING',scope);continue;}
          const before=findings.length,exceptions=validExceptions.filter(ex=>ex.content.runId===run.runId&&ex.content.evidenceDigest===run.frozenDigest);
          const acceptedMetadata=new Set();for(const ex of exceptions)for(const name of ex.content.missingMetadata)if(missingHistoricalMetadata(run,name))acceptedMetadata.add(name);
          const selected={...scope,run:structuredClone(run),exceptions,qualification:'VERIFIED',proofs:{}};selectedAttempts.push(selected);
          if(run.state!=='SIGNED'||run.result!=='PASSED')find(findings,'RUN_NOT_SIGNED_PASSED',{...scope,runId:run.runId});
          if(run.testDigest!==test.testDigest)find(findings,'TEST_VERSION_MISMATCH',scope);
          const version=await deps.readVersion(test.testVersionId);await deps.readIssueAsUser(test.testIssueId,actor);
          if(actualOutcome(run,version)!=='PASSED')find(findings,'SIGNED_OUTCOME_MISMATCH',scope);
          const versionProof=version?await deps.verifyVersionProof(version):false;
          selected.proofs.version=structuredClone(versionProof);
          if(!version||version.digest!==test.testDigest||!proofOkay(versionProof))find(findings,'TEST_VERSION_UNVERIFIABLE',scope);
          const ref=(version?.content?.verifies??[]).find(ref=>String(ref.issueId)===String(c.issue.id));
          if(!ref||ref.sourceDigest!==c.source.sourceDigest||!same(sourceBaseline(ref.baseline),c.source.baseline))find(findings,'TEST_SOURCE_STALE',scope);
          const capture=(name,fn)=>async(...args)=>{const result=await fn(...args);selected.proofs[name]=structuredClone(result);return result;};
          const proofDeps={...deps,verifyRunProof:capture('run',deps.verifyRunProof),verifyEvidence:capture('evidence',deps.verifyEvidence),
            ...(deps.readBlockingDefects?{readBlockingDefects:capture('defects',deps.readBlockingDefects)}:{}),
            ...(deps.validateRunPlanningSnapshot?{validateRunPlanningSnapshot:capture('planning',deps.validateRunPlanningSnapshot)}:{})};
          for(const problem of await inspectRunProof(run,version,proofDeps,actor))find(findings,problem,scope);
          if(run.provenance?.kind==='MACHINE') {
            try {
              const receipt=await deps.readIntakeReceipt(run.intakeReceiptId);
              validateIntakeReceipt(receipt);
              const receiptProof=await deps.confirmIntakeAudit(receipt);
              const mapping=receipt.mappings.find(m=>m.runId===run.runId);
              if(receipt.status!=='APPLIED'||!validAuditProof(receiptProof)||!same(receipt.auditProof,receiptProof)||
                !same(receipt.provenance,run.provenance)||!same(receipt.reportedBuild,run.reportedBuild)||!mapping||
                mapping.preparedDigest!==preparedIntakeDigest(run)||!receipt.mappings.every(m=>receipt.progress.includes(m.runId)))fail('INTAKE_NOT_READY');
              // Store receipt once in receiptIndex, reference by ID from attempt.
              if(!receiptIndex[receipt.receiptId]){
                const mappedTests=[];
                for(const member of receipt.mappings){
                  const mappedRun=await deps.readRun(member.runId);
                  if(!mappedRun||mappedRun.projectId!==c.projectId||mappedRun.executionIssueId!==target.content.executionIssueId)fail('INTAKE_NOT_READY');
                  await deps.readIssueAsUser(mappedRun.testIssueId,actor);
                  mappedTests.push({runId:member.runId,testIssueId:mappedRun.testIssueId});
                }
                receiptIndex[receipt.receiptId]=structuredClone({...receipt,auditProof:receiptProof,mappedTests});
              }
              selected.proofs.intakeReceiptId=receipt.receiptId;
            } catch {find(findings,'INTAKE_EVIDENCE_UNAVAILABLE',scope);}
          }
          selected.proofs.runSignatures=await deps.listSignatures('RUN',run.runId);
          selected.proofs.versionSignatures=await deps.listSignatures('TEST_VERSION',test.testVersionId);
          for(const name of HISTORICAL_METADATA){
            if(run[name]==null||name==='reportedBuild'&&Object.keys(run[name]).length===0){if(!acceptedMetadata.has(name))find(findings,`MISSING_${name.toUpperCase()}`,scope);}
          }
          if(run.reportedBuild!=null&&!same(run.reportedBuild,target.content.reportedBuild))find(findings,'BUILD_MISMATCH',scope);
          if(run.classification!=null&&(run.classification.level!==obligation.level||run.classification.method!==obligation.method))find(findings,'CLASSIFICATION_MISMATCH',scope);
          if(run.provenance!=null&&!['HUMAN','MACHINE'].includes(run.provenance.kind))find(findings,'PROVENANCE_INVALID',scope);
          if(run.intakeReceiptId||run.provenance?.kind==='MACHINE'){
            try{if(!deps.assertIntakeReady||!proofOkay(await deps.assertIntakeReady(run,deps)))find(findings,'INTAKE_NOT_READY',scope);}catch{find(findings,'INTAKE_NOT_READY',scope);}
          }else if(deps.assertIntakeReady){try{if(!proofOkay(await deps.assertIntakeReady(run,deps)))find(findings,'INTAKE_NOT_READY',scope);}catch{find(findings,'INTAKE_NOT_READY',scope);}}
          if(findings.length>before)selected.qualification='UNVERIFIED';else if(acceptedMetadata.size){selected.qualification='VERIFIED_WITH_EXCEPTION';selected.unresolvedMetadata=[...acceptedMetadata];}
        }
        const final=await sourceContext(c.issue.id,actor),finalAssignment=await head(final,'ASSIGNMENT'),finalTarget=await head(final,'TARGET');
        if(!same(c.source,final.source)||assignment.recordId!==finalAssignment?.recordId||assignment.digest!==finalAssignment?.digest||target.recordId!==finalTarget?.recordId||target.digest!==finalTarget?.digest)find(findings,'CONCURRENT_GOVERNANCE_CHANGE');
        const finalRuns=await deps.readRunsForExecutionComplete(target.content.executionIssueId);
        if(finalRuns.complete!==true||!same(runsEnvelope,finalRuns))find(findings,'CONCURRENT_ATTEMPT_CHANGE');
      }
    }catch(error){find(findings,error?.reason??'VERIFICATION_UNAVAILABLE');}
    // A denial must not disclose snapshots of a related Jira item the caller cannot open.
    await dossierVisibility({projectId:c.projectId,snapshot:{assignment,target,selectedAttempts}},actor);
    const withProof=async record=>record?{...record,signatures:await signaturesOf(record)}:null;
    let assignmentSnapshot=null,targetSnapshot=null;try{assignmentSnapshot=await withProof(assignment);targetSnapshot=await withProof(target);}catch{find(findings,'SIGNATURE_PROOF_INCOMPLETE');}
    const snapshot={schema:2,source:c.source,assignment:assignmentSnapshot,target:targetSnapshot,executionCandidate,selectedAttempts,receiptIndex,findings,verdict:findings.length?'DENIED':'ALLOWED',evaluatedAt:deps.now(),evaluatedBy:actor.accountId,
      reportedBuildAssurance:'SENDER_ATTESTED',transition:{observed:false,linked:false,note:'Evaluation is an as-of permission decision. A later Jira transition is a separate event and requires verified correlation.'}};
    const row={evaluationId:newId(),sourceIssueId:String(c.issue.id),projectId:c.projectId,snapshot,digest:contentDigest(snapshot),createdAt:snapshot.evaluatedAt,createdBy:actor.accountId,auditProof:null};
    try{
      if(!await deps.insertClosureEvaluation(row))fail('EVALUATION_NOT_CONFIRMED');
      const auditProof=await deps.audit({eventId:Buffer.from(row.evaluationId,'hex'),eventType:'TM_CLOSURE_EVALUATED',actorAccountId:actor.accountId,issueId:Number(c.issue.id),payload:{evaluationId:row.evaluationId,digest:row.digest,verdict:snapshot.verdict}});
      if(!validAuditProof(auditProof)||!await deps.confirmClosureEvaluation({evaluationId:row.evaluationId,digest:row.digest,proof:auditProof}))fail('EVALUATION_NOT_CONFIRMED');
      const stored=await deps.readClosureEvaluation(row.evaluationId);if(!stored||stored.digest!==row.digest||contentDigest(stored.snapshot)!==row.digest||!validAuditProof(stored.auditProof))fail('EVALUATION_NOT_CONFIRMED');
      return {...stored,verdict:stored.snapshot.verdict,findings:stored.snapshot.findings};
    }catch{return {evaluationId:row.evaluationId,verdict:'DENIED',findings:[...findings,{code:'EVALUATION_NOT_CONFIRMED'}],recorded:false};}
  }
  async function dossierVisibility(record,actor){
    if(record.snapshot.target){const candidate=await deps.readIssueAsUser(record.snapshot.target.content.executionIssueId,actor);if(String(candidate?.fields?.project?.id)!==record.projectId)fail('INVALID_EXECUTION');}
    for(const selected of record.snapshot.selectedAttempts??[]){
      await deps.readIssueAsUser(selected.run.testIssueId,actor);
      // Support both legacy inline intakeReceipt and deduplicated receiptIndex.
      for(const member of selected.proofs?.intakeReceipt?.mappedTests??[])await deps.readIssueAsUser(member.testIssueId,actor);
      if(selected.proofs?.intakeReceiptId){const indexed=record.snapshot.receiptIndex?.[selected.proofs.intakeReceiptId];for(const member of indexed?.mappedTests??[])await deps.readIssueAsUser(member.testIssueId,actor);}
    }
    for(const id of new Set((record.snapshot.assignment?.content.obligations??[]).flatMap(o=>o.tests.map(t=>t.testIssueId))))await deps.readIssueAsUser(id,actor);
  }
  async function exportDossier({evaluationId},actor){
    if(!actor?.accountId)fail('INVALID_INPUT');
    const record=await deps.readClosureEvaluation(evaluationId);if(!record)fail('NOT_FOUND');
    const source=await deps.readIssueAsUser(record.sourceIssueId,actor);
    if(String(source?.id)!==record.sourceIssueId||String(source.fields?.project?.id)!==record.projectId||!validAuditProof(record.auditProof)||contentDigest(record.snapshot)!==record.digest)fail('EVALUATION_NOT_CONFIRMED');
    // Read authorization for frozen related records without reinterpreting their historical outcomes.
    await dossierVisibility(record,actor);
    return {...record,verdict:record.snapshot.verdict,findings:record.snapshot.findings};
  }
  return {view,prepareAssignment,prepareTarget,prepareException,signRecord,evaluate,exportDossier};
}

const call = method => async ({payload = {}, context}, suppliedDeps = null) => tmRespond(async () => {
  const deps = suppliedDeps ?? await (await import('../testmgmt/runtime.js')).testManagementRuntime();
  return createTestGovernance(deps)[method](payload,actorFrom(context));
});
export const tmGovernanceView = call('view');
export const tmPrepareVerificationAssignment = call('prepareAssignment');
export const tmPrepareClosureTarget = call('prepareTarget');
export const tmPrepareEvidenceException = call('prepareException');
export const tmSignGovernanceRecord = call('signRecord');
export const tmEvaluateClosure = call('evaluate');
export const tmExportClosureDossier = call('exportDossier');
