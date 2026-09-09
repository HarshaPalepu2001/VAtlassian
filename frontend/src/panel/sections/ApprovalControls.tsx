import { view } from "@forge/bridge";
import { useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Affirmation, Card, CodeInput, Field, Select } from '../../ui/primitives';
import { AssuranceChip, Notice } from '../../ui/feedback';
import type { AssuranceLevel } from '../../lib/assurance';
import { approvalMode } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelState, PendingApproval } from '../types';
import { approvalPayload, approvalReady } from '../approvalModel';
export default function ApprovalControls({state,issueKey,onDone,disabled=false}:{state:PanelState;issueKey?:string;onDone:()=>Promise<void>;disabled?:boolean}) {
 const [selected,setSelected]=useState('');const [confirmed,setConfirmed]=useState(false);const [code,setCode]=useState('');const [note,setNote]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [failed,setFailed]=useState(false);const [pending,setPending]=useState<PendingApproval|null>(null);
 const [challenge,setChallenge]=useState<{id:string;nonce:string;decision:string;expiresAt:number;meaning:string;requiredAssurance?:AssuranceLevel}|null>(null);
 const transition=state.transitions?.find(t=>t.transitionId===selected)??state.transitions?.[0];const configuredLevel=transition?.requiredAssurance??state.approval.requiredAssurance;const level=challenge?.requiredAssurance??configuredLevel;const mode=approvalMode(level);
 useEffect(()=>{setCode('');setConfirmed(false);setChallenge(null);},[transition?.transitionId,state.drift.evidenceHash,configuredLevel]);
 const retry=pending??state.approval.pending;
 const canApprove=transition?.eligible??state.eligibility.eligible;
 const canReject=state.eligibility.eligible&&state.drift.count>0;
 const canSign=challenge?.decision==='REJECT'?canReject:canApprove;
 const ready=approvalReady({level,code,confirmed,busy:busy||disabled,eligible:canSign});

 async function requestChallenge(decision:'APPROVE'|'REJECT') {
  setBusy(true);setMessage('');setFailed(false);
  try{const result=assertResult(await invoke<Result&{challengeId:string;nonce:string;meaning:string;expiresAt:number;requiredAssurance:AssuranceLevel}>('signature:challenge',approvalPayload({issueKey:issueKey??state.issue?.key,transitionId:transition?.transitionId,toStatusId:transition?.toStatusId,decision,code,note,evidenceHash:state.drift.evidenceHash,confirmed:true,level})));
   setChallenge({id:result.challengeId,nonce:result.nonce,decision,expiresAt:result.expiresAt,meaning:result.meaning,requiredAssurance:result.requiredAssurance});
  }catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setBusy(false);}
 }

 async function submit(){
  if(!challenge)return;setBusy(true);setMessage('');setFailed(false);
  try{const result=assertResult(await invoke<Result&{approvalId:string;transitioned?:boolean;state?:string;transitionError?:string}>('signature:submit', { challengeId: challenge.id, code, note, confirmed, issueKey: issueKey??state.issue?.key }));
   if(result.transitioned===false&&transition&&result.state==='PENDING'){setPending({approvalId:result.approvalId,transitionId:transition.transitionId,state:'PENDING'});setMessage(result.transitionError??result.message??'Approval recorded. The workflow transition is still pending.');}
   else if(result.transitioned===false&&result.transitionError){setPending(null);setFailed(true);setMessage(result.transitionError+' A fresh signature may be required.');}
   else{setPending(null);setMessage(challenge.decision==='APPROVE'?'Approval recorded.':'Rejection recorded. Check the restoration result below.'); if(result.transitioned) view.refresh().catch(()=>{}); }
   setConfirmed(false);setNote('');setChallenge(null);await onDone();
  }catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setCode('');setBusy(false);}
 }
 async function retryTransition(){if(!retry?.transitionId)return;setBusy(true);setFailed(false);
  try{const result=assertResult(await invoke<Result&{transitioned?:boolean}>('approval:retryTransition',{issueKey:issueKey??state.issue?.key,approvalId:retry.approvalId,transitionId:retry.transitionId}));setMessage(result.transitioned?'Transition completed.':result.message??'Transition is still pending.');if(result.transitioned){setPending(null); view.refresh().catch(()=>{});}await onDone();}
  catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setBusy(false);}
 }
 // THE SIGNING MOMENT GETS ITS OWN TREATMENT. Once a challenge is open the
 // reviewer is no longer browsing, they are signing — so the block leaves the
 // ordinary card, takes the meaning statement as its largest line, and is the
 // one elevated surface in the product. Everything else stays ruled and quiet.
 if(challenge&&canSign&&mode!=='unavailable'){
  const decline=challenge.decision==='REJECT';
  return <section className={decline?'va-attest va-attest--decline':'va-attest'}>
   <div className="va-attest__banner">
    <p className="va-attest__eyebrow">{decline?'Rejecting these changes':'Approving this work item'}</p>
    <p className="va-attest__meaning">{challenge.meaning}</p>
   </div>
   <div className="va-attest__body">
    {message&&<div style={{marginBottom:16}}><Notice danger={failed}>{message}</Notice></div>}
    {mode==='totp'&&state.credentialEnrolled===false&&<div style={{marginBottom:16}}><Notice>Enrol your authenticator in Jira personal settings, under VAtlassian authenticator, before signing.</Notice></div>}
    <div className="va-attest__consequence">
     <AssuranceChip level={level}/>
     <span>{decline?'Tracked fields will be returned to their approved values.':state.drift.count?'A new baseline will be captured from the current values.':'A baseline will be captured from the current values.'}</span>
    </div>
    <Affirmation checked={confirmed} onChange={setConfirmed} disabled={busy||disabled}>I have reviewed this work item and the changes shown. My decision will be recorded against my name.</Affirmation>
    {confirmed&&mode==='totp'&&<div style={{marginBottom:16}}><Field label="Authenticator code"><CodeInput value={code} onChange={setCode} disabled={busy||disabled} onSubmit={()=>{if(ready)void submit();}}/></Field></div>}
    <div className="va-row">
     <Button appearance={decline?'danger':'primary'} isDisabled={!ready} onClick={submit}>{busy?'Recording…':decline?'Sign and restore':'Sign and approve'}</Button>
     <Button appearance="subtle" isDisabled={busy||disabled} onClick={()=>setChallenge(null)}>Cancel</Button>
    </div>
   </div>
  </section>;
 }

 return <Card title="Approval" subtitle={state.eligibility.eligible?'Your decision is recorded against your name and cannot be edited afterwards.':undefined}><div className="va-stack">
  {message&&<Notice danger={failed}>{message}</Notice>}
  {retry?.state==='PENDING'&&retry.transitionId&&<Notice>Approval already recorded. <Button isDisabled={busy||disabled} onClick={retryTransition}>Retry transition</Button></Notice>}
  {!canApprove&&!canReject?<Notice>{state.eligibility.reason??'You do not hold an eligible approval role for this work item.'}</Notice>:<>
   {state.transitions?.length>1&&<Field label="Approval transition"><Select value={transition?.transitionId??''} placeholder="Choose a transition" onChange={setSelected} options={state.transitions.map(t=>({value:t.transitionId,label:t.name}))}/></Field>}
   {mode==='unavailable'?<Notice>This approval provider is not configured. Ask an administrator to configure a supported assurance level.</Notice>:<>
    <Field label="Decision note" hint="Optional. Stored with the signature.">
     <textarea className="va-input" value={note} maxLength={4000} disabled={busy||disabled} onChange={e=>setNote(e.target.value)} rows={3}/>
    </Field>
    <div className="va-row">
     <Button appearance="primary" isDisabled={busy||disabled||!canApprove} onClick={()=>requestChallenge('APPROVE')}>{busy?'Starting…':state.drift.count?'Approve changes':'Approve'}</Button>
     <Button appearance="danger" isDisabled={busy||disabled||!canReject} onClick={()=>requestChallenge('REJECT')}>Reject{state.drift.count?' and restore':''}</Button>
     <span className="va-spacer"/>
     <AssuranceChip level={level}/>
    </div>
   </>}
  </>}
 </div></Card>;
}
