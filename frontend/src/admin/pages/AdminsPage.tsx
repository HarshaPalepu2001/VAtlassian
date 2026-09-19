import { useCallback,useEffect,useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card,Loading,Page,Person,Table } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult,errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { JiraUser } from '../types';
import UserPicker from '../UserPicker';
type Admin={accountId:string;displayName?:string;state:string;seededByName?:string;canRevoke?:boolean;revokeReason?:string};
export default function AdminsPage({bootstrap=false,onBootstrap}:{bootstrap?:boolean;onBootstrap?:()=>void}){
 const [loading,setLoading]=useState(!bootstrap);const [loaded,setLoaded]=useState(false);
 const [admins,setAdmins]=useState<Admin[]>([]);const [person,setPerson]=useState<JiraUser|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');
 const load=useCallback(async()=>{setLoading(true);setError('');try{const r=assertResult(await invoke<Result&{admins:Admin[]}>('admin:listAdmins'));setAdmins(r.admins);setLoaded(true);}catch(e){setLoaded(false);setError(errorMessage(e));}finally{setLoading(false);}},[]);
 useEffect(()=>{if(!bootstrap)void load();},[bootstrap,load]);
 async function run(action:()=>Promise<Result>,done?:()=>void){setBusy(true);setError('');setMessage('');try{const r=assertResult(await action());setMessage(r.message??r.note??'Change saved.');done?.();if(!bootstrap)await load();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <Page eyebrow="Setup" title="Administrators"><div className="va-stack">{error&&<Notice danger>{error}{!bootstrap&&<Button isDisabled={busy||loading} onClick={load}>Retry</Button>}</Notice>}{message&&<Notice>{message}</Notice>}
  {bootstrap?<Card title="Claim the first administrator role"><p>A Jira administrator can initialize access to VAtlassian.</p><Button appearance="primary" isDisabled={busy} onClick={()=>run(()=>invoke<Result>('admin:bootstrap'),onBootstrap)}>Claim administrator role</Button></Card>:<>
   <Card title="Grant administrative access"><fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}><UserPicker value={person} onChange={setPerson}/></fieldset><Button appearance="primary" isDisabled={busy||!person} onClick={()=>run(()=>invoke<Result>('admin:grantAdmin',{targetAccountId:person?.accountId}),()=>setPerson(null))}>Add administrator</Button></Card>
   <Card flush>{loading?<Loading label="Loading administrators…"/>:!loaded?<p>Administrator roster is unavailable.</p>:<Table columns={[{key:'person',label:'Administrator'},{key:'state',label:'Status'},{key:'actions',label:'Actions'}]}>{admins.map(a=><tr key={a.accountId}><td><Person name={a.displayName}/></td><td>{a.state}</td><td>{a.state==='ACTIVE'&&(a.canRevoke===false?<span className="va-muted">{a.revokeReason}</span>:<Button isDisabled={busy} onClick={()=>run(()=>invoke<Result>('admin:revokeAdmin',{targetAccountId:a.accountId}))}>Revoke</Button>)}</td></tr>)}</Table>}</Card>
   <Card title="Database maintenance"><Button isDisabled={busy} onClick={()=>run(()=>invoke<Result>('admin:runMigrations'))}>Run pending migrations</Button></Card>
  </>}
 </div></Page>;
}
