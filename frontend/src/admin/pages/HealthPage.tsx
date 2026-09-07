import { useCallback,useEffect,useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge,Card,Field,Page,Select } from '../../ui/primitives';
import { Notice,When } from '../../ui/feedback';
import { assertResult,errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';
type Finding={findingKey:string;severity:string;type:string;projectName?:string;detail:string;lastSeenAt:number};
export default function HealthPage({projects}:{projects:Project[]}){
 const [findings,setFindings]=useState<Finding[]>([]);const [projectId,setProject]=useState('');const [issueTypeId,setType]=useState('');const [types,setTypes]=useState<{id:string;name:string}[]>([]);const [undelivered,setUndelivered]=useState(0);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
 const load=useCallback(async()=>{try{const [f,a]=await Promise.all([invoke<Result&{findings:Finding[]}>('admin:listGateFindings'),invoke<Result&{projectId?:string;issueTypeId?:string;undelivered:number}>('admin:getAlertDestination')]);assertResult(f);assertResult(a);setFindings(f.findings);setProject(a.projectId??'');setType(a.issueTypeId??'');setUndelivered(a.undelivered);}catch(e){setError(errorMessage(e));}},[]);
 useEffect(()=>{void load();},[load]);useEffect(()=>{let active=true;if(!projectId){setTypes([]);return;}invoke<Result&{issueTypes:{id:string;name:string}[]}>('admin:listIssueTypesForProject',{projectId}).then(assertResult).then(r=>{if(active)setTypes(r.issueTypes);}).catch(e=>{if(active)setError(errorMessage(e));});return()=>{active=false;};},[projectId]);
 async function save(){setBusy(true);setError('');try{assertResult(await invoke<Result>('admin:setAlertDestination',{projectId,issueTypeId}));setMessage('Security alert destination saved.');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <Page eyebrow="Operations" title="Control health" actions={<Button onClick={load}>Refresh</Button>}><div className="va-stack">{error&&<Notice danger>{error}</Notice>}{message&&<Notice>{message}</Notice>}<Card title="Workflow findings">{findings.length?findings.map(f=><div className="va-record-field" key={f.findingKey}><Badge tone={f.severity==='CRITICAL'?'danger':'warning'}>{f.severity}</Badge> <strong>{f.type}</strong><p>{f.projectName} · {f.detail}</p><When ms={f.lastSeenAt}/></div>):<p>No open workflow findings recorded.</p>}</Card><Card title="Security alerts"><p>{undelivered} alerts awaiting delivery</p><div className="va-form-grid"><Field label="Project"><Select value={projectId} onChange={v=>{setProject(v);setType('');}} placeholder="Choose a project" options={projects.map(p=>({value:p.id,label:p.name}))}/></Field><Field label="Work item type"><Select value={issueTypeId} onChange={setType} placeholder="Choose a type" options={types.map(t=>({value:t.id,label:t.name}))}/></Field></div><Button appearance="primary" isDisabled={busy||!projectId||!issueTypeId} onClick={save}>Save destination</Button></Card></div></Page>;
}
