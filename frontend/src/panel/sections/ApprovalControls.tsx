import { view } from "@forge/bridge";
import { useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Affirmation, Card, CodeInput, Field, Select } from '../../ui/primitives';
import { AssuranceChip, Notice } from '../../ui/feedback';
import { approvalMode } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelState, PendingApproval } from '../types';
import { approvalPayload, approvalReady } from '../approvalModel';
export default function ApprovalControls({state,issueKey,onDone,disabled=false}:{state:PanelState;issueKey?:string;onDone:()=>Promise<void>;disabled?:boolean}) {
 const [selected,setSelected]=useState('');const [confirmed,setConfirmed]=useState(false);const [code,setCode]=useState('');const [note,setNote]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [failed,setFailed]=useState(false);const [pending,setPending]=useState<PendingApproval|null>(null);
 const transition=state.transitions?.find(t=>t.transitionId===selected)??state.transitions?.[0];const level=transition?.requiredAssurance??state.approval.requiredAssurance;const mode=approvalMode(level);
 useEffect(()=>{setCode('');setConfirmed(false);},[transition?.transitionId,state.drift.evidenceHash,level]);
 const retry=pending??state.approval.pending;
 const ready=approvalReady({level,code,confirmed,busy:busy||disabled,eligible:state.eligibility.eligible&&(transition?.eligible??true)});
 async function submit(decision:'APPROVE'|'REJECT'){
  if(!ready)return;setBusy(true);setMessage('');setFailed(false);
  try{const result=assertResult(await invoke<Result&{approvalId:string;transitioned?:boolean}>('approval:submit',approvalPayload({issueKey:issueKey??state.issue?.key,transitionId:transition?.transitionId,toStatusId:transition?.toStatusId,decision,code,note,evidenceHash:state.drift.evidenceHash,confirmed,level})));
   if(result.transitioned===false&&transition){setPending({approvalId:result.approvalId,transitionId:transition.transitionId,state:'PENDING'});setMessage(result.message??'Approval recorded. The workflow transition is still pending.');}
   else{setPending(null);setMessage(decision==='APPROVE'?'Approval recorded.':'Rejection recorded. Check the restoration result below.'); if(result.transitioned) view.refresh().catch(()=>{}); }
   setConfirmed(false);setNote('');await onDone();
  }catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setCode('');setBusy(false);}
 }
 async function retryTransition(){if(!retry?.transitionId)return;setBusy(true);setFailed(false);
  try{const result=assertResult(await invoke<Result&{transitioned?:boolean}>('approval:retryTransition',{issueKey:issueKey??state.issue?.key,approvalId:retry.approvalId,transitionId:retry.transitionId}));setMessage(result.transitioned?'Transition completed.':result.message??'Transition is still pending.');if(result.transitioned){setPending(null); view.refresh().catch(()=>{});}await onDone();}
  catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setBusy(false);}
 }
 return <Card title="Approval"><div className="va-stack">
  {message&&<Notice danger={failed}>{message}</Notice>}
  {retry?.state==='PENDING'&&retry.transitionId&&<Notice>Approval already recorded. <Button isDisabled={busy||disabled} onClick={retryTransition}>Retry transition</Button></Notice>}
  {!state.eligibility.eligible?<Notice>{state.eligibility.reason??'You do not hold an eligible approval role for this work item.'}</Notice>:<>
   {state.transitions?.length>1&&<Field label="Approval transition"><Select value={transition?.transitionId??''} placeholder="Choose a transition" onChange={setSelected} options={state.transitions.map(t=>({value:t.transitionId,label:t.name}))}/></Field>}
   <AssuranceChip level={level}/>
   {mode==='unavailable'?<Notice>This approval provider is not configured. Ask an administrator to configure a supported assurance level.</Notice>:<>
    {mode==='totp'&&state.credentialEnrolled===false&&<Notice>Enroll your authenticator in Jira personal settings → VAtlassian authenticator before approving.</Notice>}
    <Affirmation checked={confirmed} onChange={setConfirmed} disabled={busy||disabled}>I have reviewed this work item and the changes shown. My decision will be recorded against my name. {transition?.meaning??state.approval.meaning}</Affirmation>
    <Field label="Decision note"><textarea className="va-input" value={note} maxLength={4000} disabled={busy||disabled} onChange={e=>setNote(e.target.value)} rows={3}/></Field>
    {confirmed&&mode==='totp'&&<Field label="Authenticator code"><CodeInput value={code} onChange={setCode} disabled={busy||disabled} onSubmit={()=>{if(ready)void submit('APPROVE');}}/></Field>}
    <div className="va-row"><Button appearance="primary" isDisabled={!ready} onClick={()=>submit('APPROVE')}>{busy?'Recording…':state.drift.count?'Approve changes':'Approve'}</Button><Button appearance="danger" isDisabled={!ready} onClick={()=>submit('REJECT')}>Reject{state.drift.count?' and restore':''}</Button></div>
   </>}
  </>}
 </div></Card>;
}
