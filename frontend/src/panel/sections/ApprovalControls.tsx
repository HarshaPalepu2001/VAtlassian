import { view, events } from "@forge/bridge";
import { useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Affirmation, Card, CodeInput, Field, Select } from '../../ui/primitives';
import { AssuranceChip, Notice } from '../../ui/feedback';
import type { AssuranceLevel } from '../../lib/assurance';
import { approvalMode } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelState, PendingApproval, Transition } from '../types';
import { approvalPayload, approvalReady } from '../approvalModel';
import { biometricStatus, confirmBiometric, enrolBiometric } from '../deviceAuth';
export default function ApprovalControls({state,issueKey,onDone,disabled=false}:{state:PanelState;issueKey?:string;onDone:()=>Promise<void>;disabled?:boolean}) {
 const [selected,setSelected]=useState('');const [confirmed,setConfirmed]=useState(false);const [code,setCode]=useState('');const [note,setNote]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [failed,setFailed]=useState(false);const [pending,setPending]=useState<PendingApproval|null>(null);
 const [challenge,setChallenge]=useState<{id:string;nonce:string;decision:string;expiresAt:number;meaning:string;requiredAssurance?:AssuranceLevel}|null>(null);
 const [device,setDevice]=useState<{enrolled:boolean;usableHere:boolean}|null>(null);const [deviceNonce,setDeviceNonce]=useState(0);
 const reviewingDrift=state.drift.count>0;
 const transition=reviewingDrift?undefined:(state.transitions?.find(t=>t.transitionId===selected)??state.transitions?.[0]);
 const configuredLevel:AssuranceLevel=transition?.requiredAssurance??state.approval.requiredAssurance;
 const level=challenge?.requiredAssurance??configuredLevel;const mode=approvalMode(level);
 const purpose=reviewingDrift
  ? 'Review the tracked changes since baseline. Approving captures a new baseline; rejecting restores the latest baseline.'
  : transition
    ? `Sign the configured transition to ${transitionTarget(transition)}.`
    : null;
 useEffect(()=>{setCode('');setConfirmed(false);setChallenge(null);},[transition?.transitionId,state.drift.evidenceHash,configuredLevel]);
 // Biometric approval is only real if this browser can actually reach a
 // registered authenticator, so the panel asks before offering the decision.
 useEffect(()=>{if(mode!=='biometric'){setDevice(null);return;}let active=true;
  biometricStatus().then(result=>{if(active)setDevice(result?.ok?{enrolled:Boolean(result.enrolled),usableHere:result.usableHere===true}:null);}).catch(()=>{if(active)setDevice(null);});
  return()=>{active=false;};},[mode,deviceNonce]);
 const deviceReady=mode!=='biometric'||device===null||device.usableHere;
 const retry=pending??state.approval.pending;
 const canApprove=transition?.eligible??state.eligibility.eligible;
 const canReject=state.eligibility.eligible&&state.drift.count>0;
 const canSign=challenge?.decision==='REJECT'?canReject:canApprove;
 const ready=approvalReady({level,code,confirmed,busy:busy||disabled,eligible:canSign});

 async function requestChallenge(decision:'APPROVE'|'REJECT') {
  setBusy(true);setMessage('');setFailed(false);
  try{const result=assertResult(await invoke<Result&{challengeId:string;nonce:string;meaning:string;expiresAt:number;requiredAssurance:AssuranceLevel}>('signature:challenge',approvalPayload({issueKey:issueKey??state.issue?.key,transitionId:reviewingDrift?undefined:transition?.transitionId,toStatusId:reviewingDrift?undefined:transition?.toStatusId,decision,code,note,evidenceHash:state.drift.evidenceHash,confirmed:true,level})));
   setChallenge({id:result.challengeId,nonce:result.nonce,decision,expiresAt:result.expiresAt,meaning:result.meaning,requiredAssurance:result.requiredAssurance});
  }catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setBusy(false);}
 }

 async function submit(){
  if(!challenge)return;setBusy(true);setMessage('');setFailed(false);
  // The device check happens before anything is recorded: a refusal here leaves
  // the challenge open and the approval row untouched.
  let webauthn;
  if(mode==='biometric'){
   const check=await confirmBiometric({approvalChallengeId:challenge.id}).catch(e=>({ok:false as const,error:errorMessage(e)}));
   if(!check.ok){setFailed(true);setMessage(check.error??'The device check did not complete. Nothing has been recorded.');setBusy(false);return;}
   webauthn=check.assertion;
  }
  // Only an electronic signature carries a code; sending an empty one would ask
  // the server for the wrong assurance level.
  try{const result=assertResult(await invoke<Result&{approvalId:string;transitioned?:boolean;state?:string;transitionError?:string}>('signature:submit', { challengeId: challenge.id, note, confirmed, issueKey: issueKey??state.issue?.key, ...(mode==='totp'?{code}:{}), ...(webauthn?{webauthn}:{}) }));
   if(result.transitioned===false&&transition&&result.state==='PENDING'){setPending({approvalId:result.approvalId,transitionId:transition.transitionId,state:'PENDING'});setMessage(result.transitionError??result.message??'Approval recorded. The workflow transition is still pending.');}
   else if(result.transitioned===false&&result.transitionError){setPending(null);setFailed(true);setMessage(result.transitionError+' A fresh signature may be required.');}
   else{setPending(null);setMessage(challenge.decision==='APPROVE'?'Approval recorded.':'Rejection recorded. Check the restoration result below.'); view.refresh().catch(()=>{}); void events.emit('VA_ISSUE_CHANGED', { issueKey: issueKey??state.issue?.key }).catch(()=>{}); }
   setConfirmed(false);setNote('');setChallenge(null);await onDone();
  }catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setCode('');setBusy(false);}
 }
 async function setupDevice(){
  setBusy(true);setFailed(false);setMessage('');
  try{const result=await enrolBiometric();
   if(result.ok===false){setFailed(true);setMessage(result.error??'The device setup did not complete. Nothing has been recorded.');}
   else{setMessage('This device is registered. You can now approve with a biometric check.');setDeviceNonce(n=>n+1);}
  }catch(e){setFailed(true);setMessage(errorMessage(e));}finally{setBusy(false);}
 }
 async function retryTransition(){if(!retry?.transitionId)return;setBusy(true);setFailed(false);
  try{const result=assertResult(await invoke<Result&{transitioned?:boolean}>('approval:retryTransition',{issueKey:issueKey??state.issue?.key,approvalId:retry.approvalId,transitionId:retry.transitionId}));setMessage(result.transitioned?'Transition completed.':result.message??'Transition is still pending.');if(result.transitioned){setPending(null); view.refresh().catch(()=>{}); void events.emit('VA_ISSUE_CHANGED', { issueKey: issueKey??state.issue?.key }).catch(()=>{});}await onDone();}
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
     {decline ? (
      <div className="va-stack" style={{marginLeft: 12}}>
       <span>The governed issue tree will be returned to its approved content.</span>
       {!!state.rejection?.deleteIssueKeys?.length && (
        <span className="va-warning-text"><strong>Permanently delete:</strong> {state.rejection.deleteIssueKeys.join(', ')}</span>
       )}
       {!!state.rejection?.recreateCount && (
        <span className="va-warning-text"><strong>Recreate {state.rejection.recreateCount} missing nodes.</strong></span>
       )}
      </div>
     ) : (
      <div className="va-stack" style={{marginLeft: 12}}>
       <span>{transition?.capturesBaseline?'A recursive baseline will be captured from the approved issue tree.':'This transition records the approval without replacing the active baseline.'}</span>
       {transition?.blocksOnDrift && !!state.baseline && (
        <span className="va-warning-text">This transition is blocked if there are unapproved changes.</span>
       )}
      </div>
     )}
    </div>
    <Affirmation checked={confirmed} onChange={setConfirmed} disabled={busy||disabled}>I have reviewed this work item and the changes shown. My decision will be recorded against my name.</Affirmation>
    {confirmed&&mode==='totp'&&<div style={{marginBottom:16}}><Field label="Authenticator code"><CodeInput value={code} onChange={setCode} disabled={busy||disabled} onSubmit={()=>{if(ready)void submit();}}/></Field></div>}
    {confirmed&&mode==='biometric'&&<p className="va-secondary" style={{marginBottom:16}}>Signing opens a separate device window for Face ID, Touch ID, or Windows Hello. Nothing is recorded until that check passes.</p>}
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
  {!canApprove&&!canReject?<Notice>{(state.eligibility?.reason && state.eligibility.reason !== 'NOT_ELIGIBLE') ? state.eligibility.reason : 'You do not hold an eligible approval role for this work item.'}</Notice>:<>
   {purpose&&<p className="va-secondary">{purpose}</p>}
   {!reviewingDrift&&Boolean(state.transitions && state.transitions.length > 1) && <Field label="Approval transition"><Select value={transition?.transitionId??''} placeholder="Choose a transition" onChange={setSelected} options={(state.transitions || []).map(t=>({value:t.transitionId,label:t.name}))}/></Field>}
   {mode==='unavailable'?<Notice>This approval provider is not configured. Ask an administrator to configure a supported assurance level.</Notice>:<>
    {mode==='biometric'&&device&&!device.usableHere&&<Notice>
     {device.enrolled?'Your registered device cannot be used at this address. Register this browser before approving.':'This transition is signed with a biometric check. Register this device before approving.'}
     {' '}<Button isDisabled={busy||disabled} onClick={setupDevice}>{busy?'Setting up…':'Set up biometric approval'}</Button>
    </Notice>}
    <Field label="Decision note" hint="Optional. Stored with the signature.">
     <textarea className="va-input" value={note} maxLength={4000} disabled={busy||disabled} onChange={e=>setNote(e.target.value)} rows={3}/>
    </Field>
    <div className="va-row">
     <Button appearance="primary" isDisabled={busy||disabled||!canApprove||!deviceReady} onClick={()=>requestChallenge('APPROVE')}>{busy?'Starting…':reviewingDrift?'Approve changes':transitionLabel(transition)}</Button>
     <Button appearance="danger" isDisabled={busy||disabled||!canReject||!deviceReady} onClick={()=>requestChallenge('REJECT')}>Reject{state.drift.count?' and restore':''}</Button>
     <span className="va-spacer"/>
     <AssuranceChip level={level}/>
    </div>
   </>}
  </>}
 </div></Card>;
}

function transitionTarget(transition?:Transition){
 return transition?.toStatusName??transition?.name??transition?.toStatusId;
}

function transitionLabel(transition?:Transition){
 const target=transitionTarget(transition);
 return target?`Sign to move to ${target}`:'Sign transition';
}
