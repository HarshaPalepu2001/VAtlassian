import { useEffect,useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Affirmation,Card,Field,Page,Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult,download,errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';
type Policy=Result&{days?:number;floorDays:number;description:string;warning?:string};
type Export=Result&{electronic?:string;humanReadable?:string;sha256?:string;truncated?:boolean;chainVerified?:boolean};
export default function RetentionPage({projects}:{projects:Project[]}){
 const [policy,setPolicy]=useState<Policy|null>(null);const [days,setDays]=useState('');const [ack,setAck]=useState(false);const [projectId,setProject]=useState('');const [from,setFrom]=useState('');const [to,setTo]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');const [exported,setExport]=useState<Export|null>(null);
 useEffect(()=>{invoke<Policy>('admin:getRetentionPolicy').then(assertResult).then(r=>{setPolicy(r);setDays(r.days==null?'':String(r.days));}).catch(e=>setError(errorMessage(e)));},[]);
 async function save(){setBusy(true);setError('');try{const r=assertResult(await invoke<Result&{description?:string}>('admin:setRetentionPolicy',{days:days||null,acknowledgeShortPeriod:ack}));setMessage(r.description??'Retention policy saved.');const next=assertResult(await invoke<Policy>('admin:getRetentionPolicy'));setPolicy(next);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 async function exportRecords(){setBusy(true);setError('');setExport(null);try{if(from&&to&&from>to)throw new Error('The end date must follow the start date.');const r=assertResult(await invoke<Export>('admin:exportRecords',{projectId:projectId||null,fromMs:from?Date.parse(from):null,toMs:to?Date.parse(to)+86399999:null}));setExport(r);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <Page eyebrow="Evidence" title="Export & retention"><div className="va-stack">{error&&<Notice danger>{error}</Notice>}{message&&<Notice>{message}</Notice>}
 <Card title="Export approval and baseline records"><div className="va-form-grid"><Field label="Project"><Select value={projectId} onChange={setProject} placeholder="All projects" options={projects.map(p=>({value:p.id,label:p.name}))}/></Field><Field label="From"><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field><Field label="Through"><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></Field></div><Button isDisabled={busy} onClick={exportRecords}>{busy?'Preparing…':'Prepare export'}</Button>
 {exported&&<div className="va-stack"><Notice danger={!!exported.truncated||exported.chainVerified===false}>{exported.truncated?'Export is incomplete: narrow the date range and export again.':'Export prepared.'} {exported.chainVerified===false?'The ledger chain could not be verified.':''}</Notice><code className="va-hash">{exported.sha256}</code><div className="va-row"><Button onClick={()=>download('vatlassian-records.json',exported.electronic??exported)}>Download JSON</Button>{exported.humanReadable&&<Button onClick={()=>download('vatlassian-records.txt',exported.humanReadable,'text/plain')}>Download readable copy</Button>}</div></div>}
 </Card>
 <Card title="Retention policy"><p>{policy?.description}</p>{policy?.warning&&<Notice>{policy.warning}</Notice>}<Field label="Days to retain records" hint="Leave empty to retain indefinitely."><input className="va-input" type="number" min="1" value={days} onChange={e=>{setDays(e.target.value);setAck(false);}}/></Field>{!!days&&!!policy&&Number(days)<policy.floorDays&&<Affirmation checked={ack} onChange={setAck}>I confirm this period below {policy.floorDays} days meets our applicable record retention requirements.</Affirmation>}<Button appearance="primary" isDisabled={busy||!policy} onClick={save}>Save retention policy</Button></Card>
 </div></Page>;
}
