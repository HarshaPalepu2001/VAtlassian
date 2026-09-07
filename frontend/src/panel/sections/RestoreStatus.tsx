import { useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
type Restore={restore_id:string;state:string;field_name?:string;error?:string;report?:unknown};
export default function RestoreStatus({issueKey,revision}:{issueKey?:string;revision?:string}){
 const [rows,setRows]=useState<Restore[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState('');
 useEffect(()=>{let active=true;invoke<Result&{restores:Restore[]}>('restore:getState',{issueKey}).then(assertResult).then(r=>{if(active)setRows(r.restores??[]);}).catch(e=>{if(active)setError(errorMessage(e));});return()=>{active=false;};},[issueKey,revision]);
 async function retry(restoreId:string){setBusy(restoreId);setError('');try{assertResult(await invoke<Result>('restore:retry',{issueKey,restoreId}));const r=assertResult(await invoke<Result&{restores:Restore[]}>('restore:getState',{issueKey}));setRows(r.restores??[]);}catch(e){setError(errorMessage(e));}finally{setBusy('');}}
 if(!rows.length&&!error)return null;
 return <Card title="Restoration results">{error&&<Notice danger>{error}</Notice>}{rows.map(r=><div key={r.restore_id} className="va-record-field"><strong>{r.field_name??'Restore'} · {r.state}</strong>{r.error&&<p>{r.error}</p>}{r.report!=null&&<details><summary>Result details</summary><pre className="va-json">{JSON.stringify(r.report,null,2)}</pre></details>}{['FAILED','PARTIAL','PENDING'].includes(r.state)&&<Button isDisabled={!!busy} onClick={()=>retry(r.restore_id)}>Retry restore</Button>}</div>)}</Card>;
}
