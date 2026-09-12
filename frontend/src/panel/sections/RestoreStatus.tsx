import { useEffect, useState } from 'react';
import { subscribeIssueUpdates } from '../../lib/issueUpdates';
import { invoke } from '../../lib/bridge';
import { view, events } from '@forge/bridge';
import Button from '@atlaskit/button';
import { Badge, Card } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
type Restore={restore_id:string;state:string;field_name?:string;error?:string;report?:unknown;detail?:any};
export default function RestoreStatus({issueKey,revision}:{issueKey?:string;revision?:string}){
 const [rows,setRows]=useState<Restore[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState('');
 useEffect(()=>{
  let active=true;let sequence=0;
  const refresh=async()=>{const ticket=++sequence;
   try{const result=assertResult(await invoke<Result&{restores:Restore[]}>('restore:getState',{issueKey}));if(active&&ticket===sequence){setRows(result.restores??[]);setError('');}}
   catch(e){if(active&&ticket===sequence)setError(errorMessage(e));}
  };
  void refresh();const unsubscribe=subscribeIssueUpdates(refresh);
  return()=>{active=false;++sequence;unsubscribe();};
 },[issueKey,revision]);
 async function retry(restoreId:string){setBusy(restoreId);setError('');try{assertResult(await invoke<Result>('restore:retry',{issueKey,restoreId}));const r=assertResult(await invoke<Result&{restores:Restore[]}>('restore:getState',{issueKey}));setRows(r.restores??[]);view.refresh().catch(()=>{});void events.emit('VA_ISSUE_CHANGED', { issueKey }).catch(()=>{});}catch(e){setError(errorMessage(e));}finally{setBusy('');}}
 if(!rows.length&&!error)return null;
 // A restore is only "complete" once every tracked field has been read back and
 // matched, so the state is the headline rather than an afterthought appended
 // to the field name with a middle dot.
 const tone=(s:string)=>s.startsWith('COMPLETE')?'success':s==='PARTIAL'?'warning':s==='FAILED'?'danger':'neutral';
 const says=(s:string)=>s==='COMPLETE_WITH_REPLACEMENTS'?'Complete with replacement identities':s==='COMPLETE'?'Restored and verified':s==='PARTIAL'?'Partly restored':s==='FAILED'?'Restore failed':'Restore in progress';
 return <Card title="Restoration results" subtitle="A field counts as restored only after Jira has been read back and its value matched.">
  {error&&<Notice danger>{error}</Notice>}
  {rows.map(r=>{
   const replacements = r.detail?.find?.((d:any)=>d.replacements)?.replacements;
   return <div key={r.restore_id} className="va-record-field va-stack">
   <div className="va-row">
    <Badge tone={tone(r.state)}>{says(r.state)}</Badge>
    <span className="va-grow va-truncate">{r.field_name??'All tracked fields'}</span>
    {['FAILED','PARTIAL','PENDING'].includes(r.state)&&<Button isDisabled={!!busy} onClick={()=>retry(r.restore_id)}>Retry restore</Button>}
   </div>
   {r.error&&<p className="va-muted">{r.error}</p>}
   {!!replacements?.length && (
    <div style={{marginLeft: 12}}>
     <p className="va-muted">Recreated nodes:</p>
     <ul style={{marginTop: 4}}>
      {replacements.map((rep:any, idx:number) => (
       <li key={idx}>Replaced logical node {rep.logicalNodeId} with {rep.newIssueKey || rep.newIssueId}</li>
      ))}
     </ul>
    </div>
   )}
   {r.report!=null&&<details className="va-details"><summary>Per-field result</summary><pre className="va-json">{JSON.stringify(r.report,null,2)}</pre></details>}
  </div>;})}
 </Card>;
}
